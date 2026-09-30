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
import { createInterface, type Interface } from 'node:readline/promises';
import { dirSkills, ModelError, modelCatalog, openrouter, type Guidance, type ModelCard, type Toolset } from '../index.ts';
import { home, pickable, price, readConfig, resolveModel, writeConfig } from './config.ts';
import { capable, labelOf, offered } from './models.ts';
import { pick, type Item } from './picker.ts';
import { loadStrategy } from './gym/strategy.ts';
import { connectAll, type McpConnection } from './mcp.ts';
import { createSession, type Answer } from './session.ts';
import { fileToolset } from './files.ts';
import { shellToolset } from './shell.ts';
import { c, isStyle, printer, STYLES, summary, type Style } from './ui.ts';

const { values: flags, positionals } = parseArgs({
  options: {
    prompt: { type: 'string', short: 'p' },
    model: { type: 'string', short: 'm' },
    guidance: { type: 'string', short: 'g' },
    'max-usd': { type: 'string' },
    cwd: { type: 'string' },
    yes: { type: 'boolean', short: 'y' },
    verbose: { type: 'boolean', short: 'v' },
    style: { type: 'string', short: 's' },
    'no-mcp': { type: 'boolean' },
    'no-skills': { type: 'boolean' },
    'no-shell': { type: 'boolean' },
    models: { type: 'boolean' },
    pick: { type: 'boolean' },
    all: { type: 'boolean' },
    rounds: { type: 'string' },
    size: { type: 'string' },
    seed: { type: 'string' },
    report: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
  allowPositionals: true,
});

const HELP = `agento — the agent core in a terminal

  agento [options]           chat in the current directory
  agento -p "…" [options]    one turn, then exit

  agento model               pick the default model from a list (saved; no flag needed after)
  agento model <id>          set the default model directly
  agento models              the models agento offers, with live prices
  agento train               train the harness around your model: fresh challenges, keep what
                             scores better (--rounds 3, --size 6, --max-usd 0.05; --report)
  agento models --all [f]    every OpenRouter model with tools + reasoning, cheapest first

  -m, --model <id>           OpenRouter model for this run (else $AGENT_MODEL, else the saved default)
  -g, --guidance <level>     auto | off | light | normal | close | N   (default: auto)
      --max-usd <n>          USD cap per turn (default: $AGENT_MAX_USD)
      --cwd <dir>            working directory (default: here)
  -y, --yes                  approve every change and command without asking
  -s, --style <style>        output: minimal (answers) · normal (+ a line per tool call) · verbose
                             (+ results, Jev scoring, costs). Default: saved with /style, else normal
  -v, --verbose              same as --style verbose
      --no-mcp --no-skills --no-shell

In the chat:  /model            pick from the list (↑↓, type to filter; then save as default)
              /model <id>       switch for this session     /default [id]  save as the default
              /models [filter]  /guidance [level]  /budget [usd]  /cost  /tools  /mcp  /skills
              /style [minimal|normal|verbose]  (saved as default)   /strategy  what training learned
              /auto  /log  /clear  /help  /exit                               Ctrl+C stops a turn`;

if (flags.help) {
  console.log(HELP);
  process.exit(0);
}

async function catalog(): Promise<ModelCard[] | null> {
  try {
    return await modelCatalog();
  } catch (error) {
    process.stderr.write(c.red(`could not load the model list from OpenRouter: ${error instanceof Error ? error.message : String(error)}\n`));
    return null;
  }
}

/** `agento models`: the curated list; `--all [filter]`: every capable model in the catalogue. */
async function listModels(filter: string | undefined, all: boolean, write: (s: string) => void) {
  const cards = await catalog();
  if (!cards) return;
  if (all) {
    const list = pickable(cards.filter(capable), filter);
    for (const m of list.slice(0, 40)) write(`${m.id.padEnd(48)} ${c.dim(price(m))}\n`);
    write(c.dim(`${list.length} models with tools + reasoning${filter ? ` matching "${filter}"` : ''}, cheapest first${list.length > 40 ? ' (first 40)' : ''}\n`));
    return;
  }
  const saved = readConfig().model;
  for (const m of offered(cards)) {
    write(`${m.label.padEnd(22)} ${c.dim(`${m.maker} · ${m.note}`.padEnd(46))} ${c.dim(price(m.card))}  ${c.dim(m.id)}${m.id === saved ? c.green(' ← default') : ''}\n`);
  }
  write(c.dim('agento model to choose one · agento models --all [filter] for the whole catalogue\n'));
}

const [sub, subArg] = positionals;
if (sub === 'models' || flags.models) {
  await listModels(sub === 'models' ? subArg : sub, !!flags.all, s => process.stdout.write(s));
  process.exit(0);
}
if (sub && sub !== 'model' && sub !== 'train') {
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
const out = (s: string) => process.stdout.write(s);

// The line reader is closed while the picker owns the keyboard, and made again on the next question.
let running: AbortController | null = null;
let lineReader: Interface | null = null;
function reader(): Interface {
  if (lineReader) return lineReader;
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  // Ctrl+C: stop the running turn, or leave when nothing runs.
  rl.on('SIGINT', () => {
    if (running) {
      running.abort();
      out(c.yellow('\n(stopping…)\n'));
    } else {
      out('\n');
      releaseReader();
      process.exit(0);
    }
  });
  lineReader = rl;
  return rl;
}
function releaseReader() {
  lineReader?.close();
  lineReader = null;
}

const OTHER = '\u0000other';

/**
 * The model picker: agento's short list (tools + reasoning, live prices), scrollable, filter as you
 * type; "Other model…" opens the whole catalogue (tools + reasoning only).
 */
async function pickModel(current: string | undefined): Promise<string | null> {
  const cards = await catalog();
  if (!cards) return null;
  const saved = readConfig().model;
  const mark = (id: string) => (id === current ? '← current' : id === saved ? '← default' : '');
  releaseReader();
  const list = offered(cards);
  const items: Item<string>[] = [
    ...list.map(m => ({ label: m.label, detail: `${m.maker} · ${m.note}`, aside: `${price(m.card).split(' · ')[0]!.padStart(12)} ${mark(m.id)}`, value: m.id })),
    { label: 'Other model…', detail: 'search every OpenRouter model with tools + reasoning', value: OTHER },
  ];
  const at = list.findIndex(m => m.id === (current ?? saved));
  const id = await pick(items, { title: 'Model', initial: at >= 0 ? at : 0 });
  if (id !== OTHER) return id;
  const everything = pickable(cards.filter(capable));
  return pick(
    everything.map(m => ({ label: m.id, detail: m.name, aside: `${price(m).split(' · ')[0]!.padStart(12)} ${mark(m.id)}`, value: m.id })),
    { title: `All models with tools + reasoning (${everything.length}, cheapest first)` }
  );
}

/** Pick, then offer to save it as the default. */
async function pickAndMaybeSave(current: string | undefined): Promise<string | null> {
  const id = await pickModel(current);
  if (!id) return null;
  const save = (await reader().question(`${c.bold(labelOf(id))} ${c.dim(`(${id})`)} — save as the default? ${c.dim('[Y/n]')} › `)).trim().toLowerCase();
  if (!save.startsWith('n')) {
    writeConfig({ model: id });
    out(c.green(`default model: ${labelOf(id)}`) + c.dim(` (${join(home(), 'config.json')})\n`));
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
    out(`${c.green(`default model: ${labelOf(id)}`)}${c.dim(` ${id === labelOf(id) ? '' : `(${id}) `}→ ${join(home(), 'config.json')}`)}\n`);
  }
  releaseReader();
  process.exit(id ? 0 : 1);
}

// `agento train`: the gym. Uses the saved/flag model, or the cheapest one agento offers.
if (sub === 'train') {
  const { runTraining } = await import('./gym/command.ts');
  const code = await runTraining({
    model: flags.model ?? (process.env.AGENT_MODEL || undefined) ?? readConfig().model,
    rounds: Number(flags.rounds ?? 3),
    size: Number(flags.size ?? 6),
    maxUsd: Number(flags['max-usd'] ?? 0.05),
    seed: flags.seed ? Number(flags.seed) : undefined,
    report: !!flags.report,
    out,
  });
  releaseReader();
  process.exit(code);
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

const styleArg = flags.verbose ? 'verbose' : flags.style;
if (styleArg !== undefined && !isStyle(styleArg)) {
  console.error(`--style must be one of: ${STYLES.join(', ')}`);
  process.exit(2);
}
const saved = readConfig().style;
const style: Style = (styleArg as Style | undefined) ?? (isStyle(saved) ? saved : 'normal');
const print = printer(out, { stream: true, style });

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
  print.flush();
  const a = (await reader().question(`${c.yellow('?')} ${c.bold(req.summary)}\n  ${c.dim('allow? [y]es / [n]o / [a]lways for')} ${req.tool} ${c.dim('›')} `)).trim().toLowerCase();
  return a.startsWith('a') ? 'always' : a.startsWith('y') ? 'yes' : 'no';
};

const strategy = loadStrategy(model);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const session = createSession({
  provider: openrouter({ model, headers: { 'X-Title': 'agento' } }),
  model,
  root,
  toolsets,
  skills,
  // An explicit --guidance wins; otherwise what training settled on for this model.
  guidance: flags.guidance || !strategy ? guidance : strategy.guidance,
  strategy: strategy ?? undefined,
  maxUsd: Number(flags['max-usd'] ?? process.env.AGENT_MAX_USD ?? 0.5),
  ask,
  onEvent: print,
  logPath: join(home(), 'sessions', `${stamp}.jsonl`),
  profilesPath: join(home(), 'profiles.json'),
  autoApprove: !!flags.yes,
});

// ── one turn ──
async function turn(text: string) {
  running = new AbortController();
  try {
    const r = await session.send(text, running.signal);
    print.flush();
    const line = summary(r, session.total, print.style);
    if (line) out(`${line}\n`);
    return r;
  } catch (error) {
    print.flush();
    if (error instanceof ModelError && error.code === 'rate_limited') {
      out(`${c.yellow(`${labelOf(session.model ?? '')} is rate-limited by its provider right now`)} ${c.dim('(retried 3 times). Try again in a moment, or /model to switch.')}\n`);
      if (print.style === 'verbose') out(c.dim(`${error.message}\n`));
    } else if (error instanceof ModelError && error.code === 'network') {
      out(`${c.yellow("can't reach OpenRouter")} ${c.dim('(retried 3 times). Check your connection and try again.')}\n`);
      if (print.style === 'verbose') out(c.dim(`${error.message}\n`));
    } else out(`${c.red('error')} ${error instanceof Error ? error.message : String(error)}\n`);
    return null;
  } finally {
    running = null;
  }
}

if (oneShot) {
  const r = await turn(flags.prompt!);
  releaseReader();
  for (const m of mcp) m.session?.close();
  process.exit(r && ['done', 'greeted', 'chatted'].includes(r.status) ? 0 : 1);
}

// ── the REPL ──
out(`${c.bold('agento')} ${c.dim(`· ${labelOf(model)}${from === 'default' ? '' : ` (${from})`}${strategy ? ` · trained ${Math.round((strategy.score ?? 0) * 100)}%` : ''} · ${root.replace(homedir(), '~')} · /help`)}\n`);
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
      await listModels(arg.replace(/^--all\s*/, '') || undefined, arg.startsWith('--all'), out);
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
    case 'style':
    case 'verbose': {
      const next = cmd === 'verbose' ? (print.style === 'verbose' ? 'normal' : 'verbose') : arg;
      if (next && !isStyle(next)) {
        out(`styles: ${STYLES.join(', ')}\n`);
        break;
      }
      if (next) {
        print.style = next as Style;
        writeConfig({ style: next });
      }
      out(`style: ${print.style}${next ? c.dim(' (saved as default)') : c.dim(` — ${STYLES.join(' · ')}`)}\n`);
      break;
    }
    case 'strategy':
      if (!strategy) out(`no training yet for ${labelOf(session.model ?? '')} — run: agento train\n`);
      else {
        out(`${c.bold(`trained for ${labelOf(strategy.model)}`)} ${c.dim(`score ${Math.round((strategy.score ?? 0) * 100)}% · guidance ${String(strategy.guidance)} · maxSteps ${strategy.maxSteps} · readNudgeAt ${strategy.readNudgeAt}`)}\n`);
        for (const rule of strategy.rules) out(`  • ${rule}\n`);
      }
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
    line = (await reader().question(c.cyan('› '))).trim();
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
releaseReader();
for (const m of mcp) m.session?.close();
process.exit(0);
