#!/usr/bin/env node
/**
 * `agento` — a terminal REPL on the agent core, in the spirit of opencode.
 *
 *   agento                                  chat in the current directory
 *   agento -p "what does this repo do?"     one turn, then exit (exit code 1 unless done)
 *   agento --model <id> --guidance close --max-usd 0.2 --yes --verbose
 *
 * The agent gets: files (read/list/search, and write/edit with approval), the shell (each command
 * approved), MCP servers from `.mcp.json`, and skills from `.claude/skills`. Every tool call, Jev
 * checkpoint, level change and cost is printed, and every event is logged to
 * ~/.agento/sessions/<time>.jsonl. The model is picked once from a list and saved as the default
 * (~/.agento/config.json): `agento model`, or `/model` in the chat.
 *
 * Config is plain environment: OPENROUTER_API_KEY (required), AGENT_MODEL and AGENT_MAX_USD
 * (defaults for --model and --max-usd). In the agent repo, cli/scripts/agento.sh supplies them through
 * varlock. There is no default model on purpose: pick one with --model (see `agento --models`).
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { dirSkills, modelCatalog, openrouter, type Guidance, type ModelCard, type Toolset } from '../index.ts';
import { choose, home, pickable, price, readConfig, resolveModel, writeConfig } from './config.ts';
import { connectAll, type McpConnection } from './mcp.ts';
import { createSession, type Answer } from './session.ts';
import { fileToolset } from './files.ts';
import { shellToolset } from './shell.ts';
import { c, printer, summary } from './ui.ts';

const { values: flags, positionals } = parseArgs({
  options: {
    prompt: { type: 'string', short: 'p' },
    model: { type: 'string', short: 'm' },
    guidance: { type: 'string', short: 'g' },
    'max-usd': { type: 'string' },
    cwd: { type: 'string' },
    yes: { type: 'boolean', short: 'y' },
    verbose: { type: 'boolean', short: 'v' },
    'no-mcp': { type: 'boolean' },
    'no-skills': { type: 'boolean' },
    'no-shell': { type: 'boolean' },
    models: { type: 'boolean' },
    pick: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
  allowPositionals: true,
});

const HELP = `agento — the agent core in a terminal

  agento [options]           chat in the current directory
  agento -p "…" [options]    one turn, then exit

  agento model               pick the default model from a list (saved; no flag needed after)
  agento model <id>          set the default model directly
  agento models [filter]     tool-capable OpenRouter models, cheapest first

  -m, --model <id>           OpenRouter model for this run (else $AGENT_MODEL, else the saved default)
  -g, --guidance <level>     auto | off | light | normal | close | N   (default: auto)
      --max-usd <n>          USD cap per turn (default: $AGENT_MAX_USD)
      --cwd <dir>            working directory (default: here)
  -y, --yes                  approve every change and command without asking
  -v, --verbose              longer tool results, and the transient lines said to the model
      --no-mcp --no-skills --no-shell

In the chat:  /model            pick from the list (and save as default)
              /model <id>       switch for this session     /default [id]  save as the default
              /models [filter]  /guidance [level]  /budget [usd]  /cost  /tools  /mcp  /skills
              /auto  /log  /clear  /help  /exit                               Ctrl+C stops a turn`;

if (flags.help) {
  console.log(HELP);
  process.exit(0);
}

async function listModels(filter: string | undefined, write: (s: string) => void) {
  const cards = pickable(await modelCatalog(), filter);
  for (const m of cards.slice(0, 20)) write(`${m.id.padEnd(48)} ${c.dim(price(m))}\n`);
  write(c.dim(`${cards.length} tool-capable models${filter ? ` matching "${filter}"` : ''}, cheapest first\n`));
}

const [sub, subArg] = positionals;
if (sub === 'models' || flags.models) {
  await listModels(sub === 'models' ? subArg : sub, s => process.stdout.write(s));
  process.exit(0);
}
if (sub && sub !== 'model') {
  console.error(`unknown command "${sub}" — agento --help`);
  process.exit(2);
}

const parseGuidance = (s: string | undefined): Guidance | null => {
  if (!s) return 'auto';
  if (['auto', 'off', 'light', 'normal', 'close'].includes(s)) return s as Guidance;
  const n = Number(s);
  return Number.isFinite(n) && n >= 1 ? n : null;
};

const root = resolve(flags.cwd ?? process.cwd());
const oneShot = flags.prompt !== undefined;
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
const out = (s: string) => process.stdout.write(s);

/**
 * The picker: a filter, then a numbered list from the live catalogue (tool-capable, cheapest
 * first). Reply with a number, an exact id, or `/words` to filter again; Enter alone cancels.
 */
async function pickModel(current: string | undefined): Promise<string | null> {
  let all: ModelCard[];
  try {
    all = await modelCatalog();
  } catch (error) {
    out(c.red(`could not load the model list: ${error instanceof Error ? error.message : String(error)}\n`));
    return null;
  }
  const saved = readConfig().model;
  let filter = (await rl.question(`${c.cyan('filter')} ${c.dim('(e.g. glm, claude sonnet, deepseek — Enter for all)')} › `)).trim();
  for (;;) {
    const shown = pickable(all, filter).slice(0, 30);
    if (!shown.length) out(c.yellow(`no tool-capable model matches "${filter}"\n`));
    shown.forEach((m, i) => {
      const mark = m.id === current ? c.green(' ← current') : m.id === saved ? c.green(' ← default') : '';
      out(`${c.dim(String(i + 1).padStart(3))}  ${m.id.padEnd(46)} ${c.dim(price(m))}${mark}\n`);
    });
    const total = pickable(all, filter).length;
    if (total > shown.length) out(c.dim(`     …${total - shown.length} more: narrow with /words\n`));
    const answer = (await rl.question(`${c.cyan('model')} ${c.dim('(number, id, /filter, Enter to cancel)')} › `)).trim();
    if (!answer) return null;
    if (answer.startsWith('/')) {
      filter = answer.slice(1).trim();
      continue;
    }
    const id = choose(answer, shown, all);
    if (id) return id;
    out(c.yellow(`"${answer}" is not a number in the list or a model id\n`));
  }
}

/** Pick, then offer to save it as the default. */
async function pickAndMaybeSave(current: string | undefined): Promise<string | null> {
  const id = await pickModel(current);
  if (!id) return null;
  const save = (await rl.question(`save ${c.bold(id)} as the default? ${c.dim('[Y/n]')} › `)).trim().toLowerCase();
  if (!save.startsWith('n')) {
    writeConfig({ model: id });
    out(c.green(`default model: ${id}`) + c.dim(` (${join(home(), 'config.json')})\n`));
  }
  return id;
}

// `agento model [id]`: set the default, then exit.
if (sub === 'model') {
  let id: string | null = subArg ?? null;
  if (!id) {
    if (!process.stdin.isTTY) {
      console.error('agento model needs a terminal to pick from a list; or give the id: agento model <id>');
      process.exit(2);
    }
    id = await pickModel(readConfig().model);
  }
  if (id) {
    writeConfig({ model: id });
    out(`${c.green(`default model: ${id}`)}${c.dim(` (${join(home(), 'config.json')})`)}\n`);
  }
  rl.close();
  process.exit(id ? 0 : 1);
}

let { model, from } = resolveModel(flags.model, process.env.AGENT_MODEL, readConfig());
if (flags.pick || (!model && !oneShot && process.stdin.isTTY)) {
  if (!model) out(c.dim('No model yet: pick one (saved as the default, so you only do this once).\n'));
  const picked = await pickAndMaybeSave(model);
  if (picked) {
    model = picked;
    from = readConfig().model === picked ? 'default' : 'flag';
  }
}
const guidance = parseGuidance(flags.guidance);
if (guidance === null) {
  console.error(`--guidance must be auto, off, light, normal, close or a number`);
  process.exit(2);
}
if (!process.env.OPENROUTER_API_KEY) {
  console.error('OPENROUTER_API_KEY is not set. Export it, or in the agent repo run cli/scripts/agento.sh (varlock).');
  process.exit(2);
}
if (!model) {
  console.error('No model: run `agento model` once to choose a default, or pass --model <id> (or set AGENT_MODEL).');
  process.exit(2);
}

const print = printer(out, { stream: true, verbose: !!flags.verbose });

// ── tools ──
const toolsets: Toolset[] = [fileToolset(root), ...(flags['no-shell'] ? [] : [shellToolset(root)])];
let mcp: McpConnection[] = [];
if (!flags['no-mcp']) {
  mcp = await connectAll(root, text => out(c.yellow(`${text}\n`)));
  for (const m of mcp) if (m.toolset) toolsets.push(m.toolset);
}
const skills = flags['no-skills'] ? undefined : dirSkills(join(root, '.claude', 'skills'), join(homedir(), '.claude', 'skills'));

// ── approvals ──
const ask = async (req: { tool: string; summary: string }): Promise<Answer> => {
  if (!process.stdin.isTTY) return 'no';
  if (print.midLine()) out('\n');
  const a = (await rl.question(`${c.yellow('?')} ${c.bold(req.summary)}\n  ${c.dim('allow? [y]es / [n]o / [a]lways for')} ${req.tool} ${c.dim('›')} `)).trim().toLowerCase();
  return a.startsWith('a') ? 'always' : a.startsWith('y') ? 'yes' : 'no';
};

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const session = createSession({
  provider: openrouter({ model, headers: { 'X-Title': 'agento' } }),
  model,
  root,
  toolsets,
  skills,
  guidance,
  maxUsd: Number(flags['max-usd'] ?? process.env.AGENT_MAX_USD ?? 0.5),
  ask,
  onEvent: print,
  logPath: join(home(), 'sessions', `${stamp}.jsonl`),
  profilesPath: join(home(), 'profiles.json'),
  autoApprove: !!flags.yes,
});

// ── one turn ──
let running: AbortController | null = null;
async function turn(text: string) {
  running = new AbortController();
  try {
    const r = await session.send(text, running.signal);
    if (print.midLine()) out('\n');
    out(`${summary(r, session.total)}\n`);
    return r;
  } catch (error) {
    if (print.midLine()) out('\n');
    out(`${c.red('error')} ${error instanceof Error ? error.message : String(error)}\n`);
    return null;
  } finally {
    running = null;
  }
}

rl.on('SIGINT', () => {
  if (running) {
    running.abort();
    out(c.yellow('\n(stopping…)\n'));
  } else {
    out('\n');
    rl.close();
    process.exit(0);
  }
});

if (oneShot) {
  const r = await turn(flags.prompt!);
  rl.close();
  for (const m of mcp) m.session?.close();
  process.exit(r && ['done', 'greeted', 'chatted'].includes(r.status) ? 0 : 1);
}

// ── the REPL ──
out(`${c.bold('agento')} ${c.dim(`· ${model}${from === 'default' ? ' (default)' : ''} · guidance ${String(guidance)} · $${session.maxUsd}/turn · ${root}`)}\n`);
const tools = toolsets.flatMap(s => s.tools.map(t => t.name));
out(c.dim(`tools: ${tools.length} (${toolsets.map(s => `${s.name} ${s.tools.length}`).join(', ')}) · /help for commands\n`));
for (const m of mcp) if (!m.ok) out(c.yellow(`mcp ${m.name}: ${m.error}\n`));

async function command(line: string): Promise<boolean> {
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  const arg = rest.join(' ').trim();
  switch (cmd) {
    case 'help':
      out(`${HELP}\n`);
      break;
    case 'exit':
    case 'quit':
      return false;
    case 'model':
      if (arg) {
        session.model = arg;
        out(`model: ${arg} ${c.dim('(this session; /default to save it)')}\n`);
      } else {
        const id = await pickAndMaybeSave(session.model);
        if (id) session.model = id;
        out(`model: ${session.model}\n`);
      }
      break;
    case 'default': {
      const id = arg || session.model;
      if (id) {
        writeConfig({ model: id });
        out(c.green(`default model: ${id}\n`));
      }
      break;
    }
    case 'models':
      await listModels(arg || undefined, out);
      break;
    case 'guidance': {
      const g = parseGuidance(arg || undefined);
      if (arg && g === null) out('auto | off | light | normal | close | N\n');
      else if (arg) session.guidance = g!;
      out(`guidance: ${String(session.guidance)}\n`);
      break;
    }
    case 'budget':
      if (arg && Number(arg) > 0) session.maxUsd = Number(arg);
      out(`budget: $${session.maxUsd} per turn\n`);
      break;
    case 'cost':
      out(`session: $${session.total.toFixed(5)} over ${session.turns} turn(s)\n`);
      break;
    case 'tools':
      for (const s of toolsets) out(`${c.bold(s.name)}: ${s.tools.map(t => (t.write ? `${t.name}*` : t.name)).join(', ')}\n`);
      out(c.dim('* asks approval\n'));
      break;
    case 'mcp':
      if (!mcp.length) out('no MCP servers (add them to .mcp.json or ~/.agento/mcp.json)\n');
      for (const m of mcp) out(`${m.name}: ${m.ok ? c.green(`${m.tools} tools`) : c.red(m.error ?? 'failed')}\n`);
      break;
    case 'skills': {
      const list = skills ? await skills.list() : [];
      if (!list.length) out('no skills (.claude/skills here or in ~)\n');
      for (const s of list) out(`${c.bold(s.name)} ${c.dim(s.description.slice(0, 100))}\n`);
      break;
    }
    case 'auto':
      session.autoApprove = !session.autoApprove;
      out(`auto-approve: ${session.autoApprove ? c.yellow('on — every change and command runs without asking') : 'off'}\n`);
      break;
    case 'log':
      out(`${session.logPath}\n`);
      break;
    case 'clear':
      session.clear();
      out('new conversation\n');
      break;
    default:
      out(`unknown command /${cmd} — /help\n`);
  }
  return true;
}

for (;;) {
  let line: string;
  try {
    line = (await rl.question(c.cyan('› '))).trim();
  } catch {
    break;
  }
  if (!line) continue;
  if (line.startsWith('/')) {
    if (!(await command(line))) break;
    continue;
  }
  await turn(line);
}
rl.close();
for (const m of mcp) m.session?.close();
process.exit(0);
