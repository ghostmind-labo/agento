/**
 * Agent Plugins (agent-plugins.org, version 1.0.0): one folder that brings an agent skills and MCP
 * servers, in a layout every client reads the same way.
 *
 * The standard exists so that an extension is packaged once: `plugin.json` says who it is, `skills/`
 * holds Agent Skills, `mcp.json` configures MCP servers. This file is agento's side of it, the
 * loader: read a folder, decide what in it can be trusted to be what it says, and hand back the
 * skills and the server specs the rest of the CLI already knows how to use.
 *
 * The rules are the specification's, and they are about damage staying small:
 *   - a bad manifest rejects the plugin; a bad `mcp.json` disables its servers only; a bad server
 *     entry or skill is skipped alone. Everything skipped is said, in `problems`.
 *   - nothing the package names may resolve outside the plugin's folder (symlinks included);
 *   - only `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are expanded, once, in args, env values and cwd.
 * Hooks, commands and custom agents are not in version 1 of the standard, and are not read here.
 *
 * Where plugins live is the client's choice: here `<agento home>/plugins/<name>`, their data in
 * `<agento home>/plugins-data/<name>`, plus any folder named with `--plugin`.
 *
 * Also the public subpath `@ghostmind-dev/agento/plugins`: an app that takes plugins from its own
 * users calls `loadPlugin(dir, { data })` to check one, then `snapshotSkills(pluginSkills(plugin))`
 * to keep its skills as data and `plugin.servers` for the servers it is willing to reach.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { dirSkills, readFrontmatter, type SkillSource } from '../index.ts';
import { home } from './config.ts';
import type { McpServerSpec } from './mcp.ts';

export const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
export const PLUGIN_MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';

export const pluginsHome = (): string => join(home(), 'plugins');
export const pluginsData = (): string => join(home(), 'plugins-data');

/** An MCP server of a plugin, ready to connect: placeholders expanded, paths checked. */
export type PluginServer = McpServerSpec & { cwd?: string };

export interface LoadedPlugin {
  name: string;
  version?: string;
  description?: string;
  /** The plugin's folder, symlinks resolved. */
  root: string;
  /** Its persistent data folder (`PLUGIN_DATA`). Created when a server is about to start, not before. */
  data: string;
  /** The names of the skills found in `skills/`. */
  skills: string[];
  servers: Record<string, PluginServer>;
  /** What was skipped or ignored, and why. Never fatal. */
  problems: string[];
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is Record<string, string> => isObject(v) && Object.values(v).every(x => typeof x === 'string');

/** The real path of `path` when it exists and stays inside `root`; null otherwise. */
function inside(root: string, path: string): string | null {
  try {
    const real = realpathSync(path);
    return real === root || real.startsWith(root + sep) ? real : null;
  } catch {
    return null;
  }
}
const kind = (path: string): 'file' | 'dir' | null => {
  try {
    const s = statSync(path);
    return s.isFile() ? 'file' : s.isDirectory() ? 'dir' : null;
  } catch {
    return null;
  }
};

const MANIFEST_FIELDS = ['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions'];

/** The spec's name rule (5.5): 1-64 of a-z 0-9 - . , alphanumeric at both ends, no "--" and no "..". */
export const validPluginName = (name: unknown): name is string =>
  typeof name === 'string' && /^[a-z0-9.-]{1,64}$/.test(name) && /^[a-z0-9]/.test(name) && /[a-z0-9]$/.test(name) && !name.includes('--') && !name.includes('..');

const expand = (text: string, root: string, data: string) => text.replace(/\$\{PLUGIN_(ROOT|DATA)\}/g, (_, which: string) => (which === 'ROOT' ? root : data));

/** One server entry of `mcp.json` (spec 7.2.1). Returns the spec to connect with, or why it is not one. */
function readServer(entry: unknown, root: string, data: string): PluginServer | string {
  if (!isObject(entry)) return 'is not an object';
  const allowed = (keys: string[]) => Object.keys(entry).find(k => !keys.includes(k));
  if (entry.type === 'stdio') {
    const unknown = allowed(['type', 'command', 'args', 'env', 'cwd']);
    if (unknown) return `has a field stdio servers do not take: ${unknown}`;
    const command = entry.command;
    if (typeof command !== 'string' || !command || /\s/.test(command)) return '`command` must be one executable, not a command line';
    let executable = command;
    if (command.startsWith('./')) {
      const real = inside(root, join(root, command));
      if (!real) return `\`command\` ${command} is not a file inside the plugin`;
      executable = real;
    } else if (command.includes('/') || command.includes('\\')) return '`command` must be a bare name or a path starting with ./';
    if (entry.args !== undefined && !(Array.isArray(entry.args) && entry.args.every(a => typeof a === 'string'))) return '`args` must be a list of strings';
    if (entry.env !== undefined && !isStrings(entry.env)) return '`env` must be an object of strings';
    const env = (entry.env ?? {}) as Record<string, string>;
    if ('PLUGIN_ROOT' in env || 'PLUGIN_DATA' in env) return '`env` may not set PLUGIN_ROOT or PLUGIN_DATA';
    let cwd = root;
    if (entry.cwd !== undefined) {
      const c = entry.cwd;
      if (typeof c !== 'string') return '`cwd` must be a string';
      const inData = c === '${PLUGIN_DATA}' || c.startsWith('${PLUGIN_DATA}/');
      if (!inData && !(c.startsWith('./') || c === '${PLUGIN_ROOT}' || c.startsWith('${PLUGIN_ROOT}/'))) return '`cwd` must start with ./, ${PLUGIN_ROOT} or ${PLUGIN_DATA}';
      const base = inData ? data : root;
      const wanted = resolve(c.startsWith('./') ? join(root, c) : expand(c, root, data));
      // A folder that exists is checked where it really is; one that does not yet (in the data folder) by its path.
      const real = existsSync(wanted) ? inside(base, wanted) : wanted === base || wanted.startsWith(base + sep) ? wanted : null;
      if (!real) return `\`cwd\` ${c} leaves the plugin's ${inData ? 'data folder' : 'folder'}`;
      cwd = real;
    }
    return {
      command: executable,
      ...(entry.args ? { args: (entry.args as string[]).map(a => expand(a, root, data)) } : {}),
      env: { ...Object.fromEntries(Object.entries(env).map(([k, v]) => [k, expand(v, root, data)])), PLUGIN_ROOT: root, PLUGIN_DATA: data },
      cwd,
    };
  }
  if (entry.type === 'streamable-http' || entry.type === 'sse') {
    const unknown = allowed(['type', 'url', 'headers']);
    if (unknown) return `has a field remote servers do not take: ${unknown}`;
    let url: URL;
    try {
      url = new URL(String(entry.url));
    } catch {
      return '`url` must be an absolute URL';
    }
    if (typeof entry.url !== 'string' || (url.protocol !== 'https:' && url.protocol !== 'http:')) return '`url` must be http or https';
    if (url.username || url.password || url.hash) return '`url` may not carry credentials or a fragment';
    const loopback = url.hostname === 'localhost' || /^127\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname === '[::1]';
    if (url.protocol === 'http:' && !loopback) return '`url` must be https unless it is this machine';
    if (entry.headers !== undefined && !isStrings(entry.headers)) return '`headers` must be an object of strings';
    const headers = (entry.headers ?? {}) as Record<string, string>;
    const names = Object.keys(headers).map(h => h.toLowerCase());
    if (new Set(names).size !== names.length) return '`headers` names the same header twice';
    // The standard forbids expanding anything in a header; the connector underneath would expand ${NAME} from the environment.
    if (Object.values(headers).some(v => v.includes('${'))) return 'a header value contains ${…}, which agento cannot send as written';
    return { url: entry.url, transport: entry.type, ...(names.length ? { headers } : {}) };
  }
  return '`type` must be stdio, streamable-http or sse';
}

/** Load one plugin from its folder. A plugin that cannot be trusted to be what it says is an `error`, with nothing loaded. */
export function loadPlugin(dir: string, options: { data?: string } = {}): { plugin: LoadedPlugin } | { error: string } {
  let root: string;
  try {
    root = realpathSync(dir);
  } catch {
    return { error: 'no such folder' };
  }
  if (kind(root) !== 'dir') return { error: 'not a folder' };
  const manifestPath = inside(root, join(root, 'plugin.json'));
  if (!manifestPath || kind(manifestPath) !== 'file') return { error: 'no plugin.json in the folder (an Agent Plugin has one at its root)' };
  let m: unknown;
  try {
    m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return { error: 'plugin.json is not valid JSON' };
  }
  if (!isObject(m)) return { error: 'plugin.json must be an object' };
  if (m.$schema !== PLUGIN_SCHEMA) return { error: `plugin.json targets ${typeof m.$schema === 'string' ? m.$schema : 'no version'}: agento reads Agent Plugins 1.0.0 ("$schema": "${PLUGIN_SCHEMA}")` };
  if (!validPluginName(m.name)) return { error: '`name` in plugin.json must be 1-64 of a-z, 0-9, - and . , starting and ending with a letter or digit, with no "--" or ".."' };
  for (const field of ['version', 'description', 'homepage', 'repository', 'license']) if (m[field] !== undefined && typeof m[field] !== 'string') return { error: `\`${field}\` in plugin.json must be a string` };
  if (m.keywords !== undefined && !(Array.isArray(m.keywords) && m.keywords.every(k => typeof k === 'string'))) return { error: '`keywords` in plugin.json must be a list of strings' };
  if (m.author !== undefined && !(isStrings(m.author) && Object.keys(m.author).every(k => ['name', 'email', 'url'].includes(k)))) return { error: '`author` in plugin.json may only have name, email and url, as strings' };

  const problems: string[] = [];
  for (const field of Object.keys(m)) if (!MANIFEST_FIELDS.includes(field)) problems.push(`plugin.json: unknown field "${field}" ignored`);
  if (m.extensions !== undefined && !isObject(m.extensions)) problems.push('plugin.json: `extensions` is not an object, ignored');
  // A host with its own layout (a hosted product) says where the plugin's data goes; agento keeps it under its home.
  const data = options.data ?? join(pluginsData(), m.name);
  const plugin: LoadedPlugin = { name: m.name, ...(m.version ? { version: m.version as string } : {}), ...(m.description ? { description: m.description as string } : {}), root, data, skills: [], servers: {}, problems };

  // skills/: each immediate child with a SKILL.md that is a real file inside the plugin.
  const skillsPath = join(root, 'skills');
  if (existsSync(skillsPath)) {
    const skillsDir = inside(root, skillsPath);
    if (!skillsDir || kind(skillsDir) !== 'dir') problems.push('skills: not a folder inside the plugin, ignored');
    else {
      for (const entry of readdirSync(skillsDir).sort()) {
        if (kind(join(skillsDir, entry)) !== 'dir') continue;
        const candidate = join(skillsDir, entry, 'SKILL.md');
        if (!existsSync(candidate)) continue;
        const file = inside(root, candidate);
        if (!file || kind(file) !== 'file') {
          problems.push(`skills/${entry}: SKILL.md is not a file inside the plugin, skipped`);
          continue;
        }
        const fm = readFrontmatter(readFileSync(file, 'utf8'));
        if (!fm.description) problems.push(`skills/${entry}: SKILL.md has no description, skipped`);
        else plugin.skills.push(fm.name || entry);
      }
    }
  }

  // mcp.json: a bad file disables the plugin's servers; a bad entry is skipped alone.
  const mcpPath = join(root, 'mcp.json');
  if (existsSync(mcpPath)) {
    const file = inside(root, mcpPath);
    let config: unknown;
    try {
      config = file && kind(file) === 'file' ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
    } catch {
      config = undefined;
    }
    if (!isObject(config)) problems.push('mcp.json: not a JSON object in a file inside the plugin, its servers are off');
    else if (config.$schema !== PLUGIN_MCP_SCHEMA) problems.push('mcp.json: targets another version than plugin.json, its servers are off');
    else if (!isObject(config.mcpServers) || Object.keys(config).some(k => k !== '$schema' && k !== 'mcpServers')) problems.push('mcp.json: must hold exactly $schema and mcpServers, its servers are off');
    else {
      for (const [name, entry] of Object.entries(config.mcpServers)) {
        const server = readServer(entry, root, data);
        if (typeof server === 'string') problems.push(`mcp.json: server "${name}" ${server}, skipped`);
        else plugin.servers[name] = server;
      }
    }
  }
  return { plugin };
}

/** Every plugin in force: the folders named with `--plugin`, then the installed ones. The first of a name wins. */
export function plugins(extra: string[] = []): { loaded: LoadedPlugin[]; rejected: { dir: string; error: string }[] } {
  const dirs = [...extra];
  try {
    for (const entry of readdirSync(pluginsHome()).sort()) if (!entry.startsWith('.')) dirs.push(join(pluginsHome(), entry));
  } catch {
    // no plugins installed
  }
  const loaded: LoadedPlugin[] = [];
  const rejected: { dir: string; error: string }[] = [];
  for (const dir of dirs) {
    const r = loadPlugin(isAbsolute(dir) ? dir : resolve(dir));
    if ('error' in r) rejected.push({ dir, error: r.error });
    else if (!loaded.some(p => p.name === r.plugin.name)) loaded.push(r.plugin);
  }
  return { loaded, rejected };
}

/** The plugins' MCP servers as specs to connect, named `<plugin>:<server>`. Each plugin's data folder is created first. */
export function pluginServers(loaded: LoadedPlugin[]): Record<string, PluginServer> {
  const out: Record<string, PluginServer> = {};
  for (const p of loaded) {
    if (!Object.keys(p.servers).length) continue;
    try {
      mkdirSync(p.data, { recursive: true });
    } catch {
      continue; // nowhere to keep its data: its servers do not start
    }
    for (const [name, spec] of Object.entries(p.servers)) out[`${p.name}:${name}`] = spec;
  }
  return out;
}

/** A plugin's skills: its `skills/` folder, narrowed to the ones that passed the loader's checks. */
export function pluginSkills(p: LoadedPlugin): SkillSource {
  const source = dirSkills(join(p.root, 'skills'));
  const ok = (name: string) => p.skills.includes(name);
  return {
    list: async () => (await source.list()).filter(m => ok(m.name)),
    open: async name => (ok(name) ? source.open(name) : null),
    readFile: async (name, path) => (ok(name) ? source.readFile(name, path) : null),
  };
}
