/**
 * MCP servers, from the same `.mcp.json` Claude Code reads.
 *
 * The connection is ensemble's `connect()` (stdio, Streamable HTTP, SSE, WebSocket, and every auth
 * mode including OAuth logins), used here as a third-party library: the agent core speaks no MCP wire
 * protocol, it only takes a session shaped `{ name, listTools, call }`.
 *
 * Ensemble is an OPTIONAL peer dependency, loaded only when a server is configured: the package keeps
 * zero runtime dependencies, and files, shell and skills work without it. Without it, each server is
 * reported with the install command.
 *
 * Config is read from `<cwd>/.mcp.json`, then `~/.agento/mcp.json` (the first definition of a name
 * wins). A server that fails to connect is reported and skipped; it never stops the CLI.
 *
 * Which MCP calls are CHANGES is not something servers say reliably, so the CLI guesses from the
 * tool's name (create_, update_, delete_…) and asks approval for those. `/auto` skips all approvals.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mcpToolset, type McpLike, type Toolset } from '../index.ts';
import { home } from './config.ts';

/** The parts of ensemble's McpServerSpec this reads and writes (kept local: ensemble is optional). */
export type McpServerSpec =
  | { command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { url: string; transport?: 'auto' | 'streamable-http' | 'sse' | 'websocket'; headers?: Record<string, string> };

type McpSession = McpLike & { close(): void };
type Connect = (name: string, spec: McpServerSpec, options: { interactive?: boolean; prompt?: (message: string) => void }) => Promise<McpSession>;

export const ENSEMBLE = '@ghostmind-dev/ensemble';

/** ensemble's connect(), or null when it is not installed. */
async function loadConnect(): Promise<Connect | null> {
  try {
    const mod = (await import(ENSEMBLE)) as { connect?: Connect };
    return mod.connect ?? null;
  } catch {
    return null;
  }
}

interface ClaudeServer {
  type?: 'stdio' | 'http' | 'sse' | 'ws';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export const WRITE_VERBS = /^(create|update|delete|remove|write|set|add|edit|append|trash|apply|send|put|patch|move|rename|upload|restore|link|unlink|pin|unpin|publish|deploy|run|execute|insert|drop|merge|close|archive)[_-]/i;

export function mcpConfig(cwd: string): Record<string, McpServerSpec> {
  const out: Record<string, McpServerSpec> = {};
  for (const file of [join(cwd, '.mcp.json'), join(home(), 'mcp.json')]) {
    if (!existsSync(file)) continue;
    let servers: Record<string, ClaudeServer> = {};
    try {
      servers = (JSON.parse(readFileSync(file, 'utf8')) as { mcpServers?: Record<string, ClaudeServer> }).mcpServers ?? {};
    } catch {
      continue;
    }
    for (const [name, s] of Object.entries(servers)) {
      if (name in out) continue;
      if (s.url) out[name] = { url: s.url, transport: s.type === 'sse' ? 'sse' : s.type === 'ws' ? 'websocket' : 'auto', ...(s.headers ? { headers: s.headers } : {}) };
      else if (s.command) out[name] = { command: s.command, ...(s.args ? { args: s.args } : {}), ...(s.env ? { env: s.env } : {}) };
    }
  }
  return out;
}

export interface McpConnection {
  name: string;
  ok: boolean;
  tools: number;
  error?: string;
  session?: McpSession;
  toolset?: Toolset;
}

/** `.mcp.json` in the folder, then ~/.agento/mcp.json. */
export async function connectAll(cwd: string, onLogin: (text: string) => void): Promise<McpConnection[]> {
  return connectSpecs(mcpConfig(cwd), onLogin);
}

/** An MCP server as an ACP client hands it over in session/new (name/value arrays, a `type` for remote ones). */
export type AcpMcpServer =
  | { name: string; command: string; args?: string[]; env?: { name: string; value: string }[] }
  | { type: 'http' | 'sse'; name: string; url: string; headers?: { name: string; value: string }[] };

const pairs = (list?: { name: string; value: string }[]) => (list?.length ? Object.fromEntries(list.map(p => [p.name, p.value])) : undefined);

export function fromAcpMcp(servers: AcpMcpServer[] = []): Record<string, McpServerSpec> {
  const out: Record<string, McpServerSpec> = {};
  for (const s of servers) {
    if ('url' in s) out[s.name] = { url: s.url, transport: s.type === 'sse' ? 'sse' : 'streamable-http', ...(pairs(s.headers) ? { headers: pairs(s.headers)! } : {}) };
    else if (s.command) out[s.name] = { command: s.command, ...(s.args?.length ? { args: s.args } : {}), ...(pairs(s.env) ? { env: pairs(s.env)! } : {}) };
  }
  return out;
}

/** True when ensemble's connect() can be loaded (it is an optional peer). */
export async function mcpAvailable(): Promise<boolean> {
  return (await loadConnect()) !== null;
}

export async function connectSpecs(specs: Record<string, McpServerSpec>, onLogin: (text: string) => void): Promise<McpConnection[]> {
  if (!Object.keys(specs).length) return [];
  const connect = await loadConnect();
  if (!connect) return Object.keys(specs).map(name => ({ name, ok: false, tools: 0, error: `MCP needs ${ENSEMBLE}: npm install -g ${ENSEMBLE} (or add it next to this package)` }));
  return Promise.all(
    Object.entries(specs).map(async ([name, spec]): Promise<McpConnection> => {
      try {
        // Interactive: an OAuth server (Potion) may open a browser to log in the first time.
        const session = await connect(name, spec, { interactive: true, prompt: onLogin });
        const toolset = await mcpToolset(session, {
          writes: (tool, args) => (WRITE_VERBS.test(tool) ? `${name}.${tool}(${JSON.stringify(args).slice(0, 160)})` : null),
        });
        return { name, ok: true, tools: toolset.tools.length, session, toolset };
      } catch (error) {
        return { name, ok: false, tools: 0, error: error instanceof Error ? error.message : String(error) };
      }
    })
  );
}
