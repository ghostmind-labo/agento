/**
 * `agento mcp | skill | plugin  list | add | remove` — what the agent is given, managed from the
 * command line instead of by editing files.
 *
 * Three things extend the agent, and each already had a home on disk: MCP servers (`.mcp.json`, the
 * file Claude Code reads, or `~/.agento/mcp.json`), skills (folders with a SKILL.md), and Agent
 * Plugins (a folder bringing both, see `plugins.ts`). These commands only put things in those homes
 * and take them out; nothing here is a second registry, so a file edited by hand and a command agree.
 *
 * `add` takes a folder or a git URL. A plugin is checked by the loader before it is installed, and
 * what it would start is printed: installing a plugin with a stdio server means letting it run a
 * program on this machine the next time agento starts.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { readFrontmatter, type Toolset } from '../index.ts';
import { home } from './config.ts';
import { loadPlugin, plugins, pluginsData, pluginsHome, pluginServers, type LoadedPlugin } from './plugins.ts';
import { cliSkills } from './session.ts';

export interface ManageFlags {
  project?: boolean;
  url?: string;
  header?: string[];
  env?: string[];
  path?: string;
  skills?: string[];
  plugin?: string[];
  cwd?: string;
}

type Out = (text: string) => void;
const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const isGit = (source: string) => /^(https?:\/\/|git@|ssh:\/\/)/.test(source) || source.endsWith('.git');
const pairs = (list: string[] = [], what: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const item of list) {
    const at = item.indexOf('=');
    if (at < 1) throw new Error(`${what} must be NAME=value, got "${item}"`);
    out[item.slice(0, at)] = item.slice(at + 1);
  }
  return out;
};

/** The folder a source names: itself, or a shallow clone of it. `cleanup` removes a clone. */
function fetchSource(source: string, sub?: string): { dir: string; cleanup: () => void } {
  let dir = resolve(source);
  let cleanup = () => {};
  if (isGit(source)) {
    const tmp = mkdtempSync(join(tmpdir(), 'agento-add-'));
    const r = spawnSync('git', ['clone', '--depth', '1', '--quiet', source, tmp], { encoding: 'utf8' });
    if (r.error || r.status !== 0) {
      rmSync(tmp, { recursive: true, force: true });
      throw new Error(`could not clone ${source}: ${r.error ? 'git is not installed' : r.stderr.trim().split('\n').pop()}`);
    }
    dir = tmp;
    cleanup = () => rmSync(tmp, { recursive: true, force: true });
  }
  if (sub) dir = join(dir, sub);
  if (!isDir(dir)) {
    cleanup();
    throw new Error(`no such folder: ${sub ? `${sub} in ` : ''}${source}`);
  }
  return { dir, cleanup };
}
/** Put a copy of `from` at `to`, replacing what was there, without the source's git history. */
function install(from: string, to: string) {
  mkdirSync(join(to, '..'), { recursive: true });
  const staged = `${to}.installing`;
  rmSync(staged, { recursive: true, force: true });
  cpSync(from, staged, { recursive: true, filter: src => basename(src) !== '.git' });
  rmSync(to, { recursive: true, force: true });
  renameSync(staged, to);
}

// ── MCP servers ──
const mcpFile = (root: string, project?: boolean) => (project ? join(root, '.mcp.json') : join(home(), 'mcp.json'));
const readMcp = (file: string): { mcpServers: Record<string, Record<string, unknown>> } & Record<string, unknown> => {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    return { ...parsed, mcpServers: (parsed.mcpServers as Record<string, Record<string, unknown>>) ?? {} };
  } catch {
    return { mcpServers: {} };
  }
};
const writeMcp = (file: string, config: unknown) => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
};
const describeServer = (s: Record<string, unknown>) => (s.url ? String(s.url) : [s.command, ...((s.args as string[]) ?? [])].join(' '));

function mcp(action: string | undefined, args: string[], flags: ManageFlags, root: string, out: Out): number {
  if (action === 'list') {
    let any = false;
    for (const [where, file] of [['this folder', mcpFile(root, true)], ['you', mcpFile(root, false)]] as const) {
      for (const [name, s] of Object.entries(readMcp(file).mcpServers)) {
        any = true;
        out(`${name}  ${describeServer(s)}  (${where}: ${file})\n`);
      }
    }
    for (const [name, s] of Object.entries(pluginServers(plugins(flags.plugin).loaded))) {
      any = true;
      out(`${name}  ${describeServer(s as Record<string, unknown>)}  (plugin)\n`);
    }
    if (!any) out('no MCP servers. Add one: agento mcp add <name> -- <command> [args…]   or   agento mcp add <name> --url <url>\n');
    return 0;
  }
  const [name, command, ...rest] = args;
  const file = mcpFile(root, flags.project);
  if (action === 'add') {
    if (!name || (!flags.url && !command) || (flags.url && command)) throw new Error('usage: agento mcp add <name> -- <command> [args…]   or   agento mcp add <name> --url <url> [--header NAME=value]');
    const config = readMcp(file);
    const replaced = name in config.mcpServers;
    const headers = pairs(flags.header, '--header');
    const env = pairs(flags.env, '--env');
    config.mcpServers[name] = flags.url
      ? { type: 'http', url: flags.url, ...(Object.keys(headers).length ? { headers } : {}) }
      : { command, ...(rest.length ? { args: rest } : {}), ...(Object.keys(env).length ? { env } : {}) };
    writeMcp(file, config);
    out(`${replaced ? 'replaced' : 'added'} MCP server ${name} in ${file}\n`);
    return 0;
  }
  if (action === 'remove') {
    if (!name) throw new Error('usage: agento mcp remove <name> [--project]');
    const config = readMcp(file);
    if (!(name in config.mcpServers)) throw new Error(`no MCP server "${name}" in ${file}${flags.project ? '' : ' (one in this folder\'s .mcp.json needs --project)'}`);
    delete config.mcpServers[name];
    writeMcp(file, config);
    out(`removed MCP server ${name} from ${file}\n`);
    return 0;
  }
  throw new Error('usage: agento mcp list | add | remove   (agento mcp alone runs agento AS an MCP server)');
}

// ── skills ──
const skillsHome = (root: string, project?: boolean) => (project ? join(root, '.agents', 'skills') : join(home(), 'skills'));
/** The skill folders a source holds: itself, its children, or the children of its `skills/` folder. */
function skillFolders(dir: string): string[] {
  if (existsSync(join(dir, 'SKILL.md'))) return [dir];
  const children = (parent: string) => (isDir(parent) ? readdirSync(parent).map(e => join(parent, e)).filter(p => isDir(p) && existsSync(join(p, 'SKILL.md'))) : []);
  const direct = children(dir);
  return direct.length ? direct : children(join(dir, 'skills'));
}

async function skill(action: string | undefined, args: string[], flags: ManageFlags, root: string, out: Out): Promise<number> {
  if (action === 'list') {
    const list = await cliSkills(root, (flags.skills ?? []).map(d => resolve(d)), flags.plugin).list();
    if (!list.length) out('no skills. Add one: agento skill add <folder or git URL>\n');
    for (const s of list) out(`${s.name}  ${s.description.slice(0, 110)}\n`);
    return 0;
  }
  const [target] = args;
  const to = skillsHome(root, flags.project);
  if (action === 'add') {
    if (!target) throw new Error('usage: agento skill add <folder or git URL> [--path <folder inside it>] [--project]');
    const source = fetchSource(target, flags.path);
    try {
      const found = skillFolders(source.dir);
      if (!found.length) throw new Error(`no SKILL.md in ${target}${flags.path ? `/${flags.path}` : ''} (a skill is a folder with one; a folder of skills works too)`);
      for (const folder of found) {
        const fm = readFrontmatter(readFileSync(join(folder, 'SKILL.md'), 'utf8'));
        const name = fm.name || basename(folder);
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw new Error(`"${name}" is not a usable skill name`);
        if (!fm.description) throw new Error(`${name}: SKILL.md has no description, so no agent could tell when to use it`);
        install(folder, join(to, name));
        out(`added skill ${name} to ${join(to, name)}\n`);
      }
    } finally {
      source.cleanup();
    }
    return 0;
  }
  if (action === 'remove') {
    if (!target) throw new Error('usage: agento skill remove <name> [--project]');
    const at = join(to, target);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(target) || !existsSync(join(at, 'SKILL.md'))) throw new Error(`no skill "${target}" in ${to}. agento only removes skills it installed; one in .claude/skills, or brought by a plugin, is removed where it lives.`);
    rmSync(at, { recursive: true, force: true });
    out(`removed skill ${target} from ${to}\n`);
    return 0;
  }
  throw new Error('usage: agento skill list | add | remove');
}

// ── plugins ──
function describePlugin(p: LoadedPlugin, out: Out) {
  out(`${p.name}${p.version ? ` ${p.version}` : ''}${p.description ? `  ${p.description.slice(0, 90)}` : ''}\n`);
  out(`  skills: ${p.skills.length ? p.skills.join(', ') : 'none'}\n`);
  const servers = Object.entries(p.servers);
  out(`  MCP servers: ${servers.length ? '' : 'none'}\n`);
  for (const [name, s] of servers) out(`    ${name}: ${'url' in s ? s.url : `runs ${[s.command, ...(s.args ?? [])].join(' ')}`}\n`);
  for (const problem of p.problems) out(`  ! ${problem}\n`);
}

function plugin(action: string | undefined, args: string[], flags: ManageFlags, out: Out): number {
  if (action === 'list') {
    const { loaded, rejected } = plugins(flags.plugin);
    if (!loaded.length && !rejected.length) out('no plugins. Add one: agento plugin add <folder or git URL>   (Agent Plugins 1.0.0: a folder with a plugin.json)\n');
    for (const p of loaded) describePlugin(p, out);
    for (const r of rejected) out(`! ${r.dir}: not loaded: ${r.error}\n`);
    return 0;
  }
  const [target] = args;
  if (action === 'add') {
    if (!target) throw new Error('usage: agento plugin add <folder or git URL> [--path <folder inside it>]');
    const source = fetchSource(target, flags.path);
    try {
      const checked = loadPlugin(source.dir);
      if ('error' in checked) throw new Error(`${target} is not a plugin agento can load: ${checked.error}`);
      const to = join(pluginsHome(), checked.plugin.name);
      const replaced = existsSync(to);
      install(source.dir, to);
      const installed = loadPlugin(to);
      if ('error' in installed) throw new Error(installed.error);
      out(`${replaced ? 'updated' : 'added'} plugin, in ${to}\n`);
      describePlugin(installed.plugin, out);
      if (Object.values(installed.plugin.servers).some(s => 'command' in s)) out('  note: its stdio servers are programs that will run on this machine when agento starts. Remove it with: agento plugin remove ' + installed.plugin.name + '\n');
    } finally {
      source.cleanup();
    }
    return 0;
  }
  if (action === 'remove') {
    if (!target) throw new Error('usage: agento plugin remove <name>');
    const at = join(pluginsHome(), target);
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(target) || !existsSync(at)) throw new Error(`no plugin "${target}" in ${pluginsHome()}`);
    rmSync(at, { recursive: true, force: true });
    rmSync(join(pluginsData(), target), { recursive: true, force: true });
    out(`removed plugin ${target} and its data\n`);
    return 0;
  }
  throw new Error('usage: agento plugin list | add | remove');
}

/** Run one management command. Returns the exit code; a usage or input mistake is said on `err`. */
export async function manage(kind: 'mcp' | 'skill' | 'plugin', action: string | undefined, args: string[], flags: ManageFlags, out: Out, err: Out): Promise<number> {
  const root = resolve(flags.cwd ?? process.cwd());
  try {
    if (kind === 'mcp') return mcp(action, args, flags, root, out);
    if (kind === 'skill') return await skill(action, args, flags, root, out);
    return plugin(action, args, flags, out);
  } catch (error) {
    err(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

/**
 * The same installs as tools, so the person can ask the agent ("install this plugin") instead of
 * leaving the conversation. Each is a change and waits for approval, with the source in the question.
 * Offered in the terminal only: an agent nobody watches must not be talked into installing programs.
 * A new skill is there on the next turn; a new MCP server connects when agento next starts.
 */
export function extendToolset(root: string, flags: ManageFlags = {}): Toolset {
  const call = async (kind: 'mcp' | 'skill' | 'plugin', action: string, args: string[], extra: ManageFlags = {}) => {
    const said: string[] = [];
    const code = await manage(kind, action, args, { ...flags, ...extra, cwd: root }, s => void said.push(s), s => void said.push(s));
    if (code !== 0) throw new Error(said.join('').trim() || 'failed');
    return said.join('').trim();
  };
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const source = { type: 'string', description: 'A folder on this machine, or a git URL.' };
  const path = { type: 'string', description: 'A folder inside the source, when what is wanted is not at its root.' };
  return {
    name: 'extend',
    description: 'Install what extends this agent: plugins, skills, MCP servers.',
    tools: [
      {
        name: 'list_extensions',
        description: 'What this agent has installed: its plugins, its skills and its MCP servers.',
        parameters: { type: 'object', properties: {} },
        run: async () => `PLUGINS\n${await call('plugin', 'list', [])}\n\nSKILLS\n${await call('skill', 'list', [])}\n\nMCP SERVERS\n${await call('mcp', 'list', [])}`,
      },
      {
        name: 'install_plugin',
        description: 'Install an Agent Plugin (a folder with a plugin.json, bringing skills and MCP servers) from a folder or a git URL. Its skills are usable from the next turn; its MCP servers connect when agento next starts. Asks the person first.',
        parameters: { type: 'object', properties: { source, path }, required: ['source'] },
        write: { describe: a => `Install the plugin at ${text(a.source)}${text(a.path) ? ` (${text(a.path)})` : ''}. Its MCP servers may run programs on this machine.` },
        run: async a => call('plugin', 'add', [text(a.source)], { path: text(a.path) || undefined }),
      },
      {
        name: 'install_skill',
        description: 'Install a skill (a folder with a SKILL.md), or every skill of a folder, from a folder or a git URL. Usable from the next turn. `project: true` installs it for this folder only. Asks the person first.',
        parameters: { type: 'object', properties: { source, path, project: { type: 'boolean' } }, required: ['source'] },
        write: { describe: a => `Install the skill at ${text(a.source)}${text(a.path) ? ` (${text(a.path)})` : ''}${a.project === true ? ' for this folder' : ''}.` },
        run: async a => call('skill', 'add', [text(a.source)], { path: text(a.path) || undefined, project: a.project === true }),
      },
      {
        name: 'add_mcp_server',
        description: 'Add an MCP server to the agent\'s configuration: a local one (`command` and `args`) or a hosted one (`url`). It connects when agento next starts. `project: true` writes this folder\'s .mcp.json. Asks the person first.',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string' }, command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, url: { type: 'string' }, project: { type: 'boolean' } },
          required: ['name'],
        },
        write: { describe: a => `Add the MCP server "${text(a.name)}": ${text(a.url) || [text(a.command), ...(Array.isArray(a.args) ? a.args.map(String) : [])].join(' ')}.` },
        run: async a => call('mcp', 'add', [text(a.name), ...(text(a.command) ? [text(a.command), ...(Array.isArray(a.args) ? a.args.map(String) : [])] : [])], { url: text(a.url) || undefined, project: a.project === true }),
      },
    ],
  };
}
