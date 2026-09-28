/**
 * MCP servers, from the same `.mcp.json` Claude Code reads.
 *
 * The connection is ensemble's `connect()` (stdio, Streamable HTTP, SSE, WebSocket, and every auth
 * mode including OAuth logins), used here as a third-party library: the agent core speaks no MCP wire
 * protocol, it only takes a session shaped `{ name, listTools, call }`.
 *
 * Config is read from `<cwd>/.mcp.json`, then `~/.agent-cli/mcp.json` (the first definition of a name
 * wins). A server that fails to connect is reported and skipped; it never stops the CLI.
 *
 * Which MCP calls are CHANGES is not something servers say reliably, so the CLI guesses from the
 * tool's name (create_, update_, delete_…) and asks approval for those. `/auto` skips all approvals.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { connect, type McpServerSpec, type McpSession } from '@ghostmind-dev/ensemble';
import { mcpToolset, type Toolset } from './engine.ts';

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
  for (const file of [join(cwd, '.mcp.json'), join(homedir(), '.agent-cli', 'mcp.json')]) {
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

export async function connectAll(cwd: string, onLogin: (text: string) => void): Promise<McpConnection[]> {
  const specs = mcpConfig(cwd);
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
