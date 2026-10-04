/**
 * `agento mcp` — the agent as ONE MCP tool, so any MCP client can hand it a task.
 *
 * MCP (the Model Context Protocol, now at the Linux Foundation) is how hosts call tools: Claude Code,
 * opencode, and ensemble's `mcp` nodes all speak it. This server exposes a single tool, `run_task`:
 * give it a prompt, it works on its own (files, search, the web, a shell if allowed) and returns its
 * answer, with the status, steps and cost in `structuredContent` (MCP has no field for what a call
 * cost, so it travels there).
 *
 * Over stdio, JSON-RPC 2.0, one message per line — the same framing as ACP, hand-written for the same
 * reason (the package keeps zero runtime dependencies). stdout carries protocol messages only.
 *
 * One call is one run: there is no one to ask, so changes are decided up front by `unattended()`.
 */
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { dirSkills, type Guidance, type ModelProvider } from '../index.ts';
import { standardToolsets } from '../toolkit/index.ts';
import { E, RpcError } from './acp.ts';
import { home } from './config.ts';
import { loadStrategy } from './gym/strategy.ts';
import { STARTER } from './models.ts';
import { createSession } from './session.ts';
import { unattended } from './unattended.ts';

type Json = Record<string, unknown>;

export const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export const RUN_TASK = {
  name: 'run_task',
  title: 'Run a task with agento',
  description:
    'Give the agento agent a task. It works on its own — reading and searching files, browsing the web, and (only if the server allows) changing files or running commands — then returns its answer. Make the prompt self-contained: the agent sees nothing else. The result text is the answer; structuredContent has status, steps, toolCalls and cost (USD).',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'The task, in words. Self-contained.' },
      cwd: { type: 'string', description: 'Absolute folder to work in. Default: the folder the server was started in.' },
      model: { type: 'string', description: 'An OpenRouter model id. Default: the server\'s.' },
      max_usd: { type: 'number', description: 'Spending cap for this task, in USD.' },
    },
    required: ['prompt'],
  },
};

export interface McpServeOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  log?: (text: string) => void;
  defaultModel?: string;
  providerFor: (model: string) => ModelProvider;
  guidance?: Guidance;
  maxUsd?: number;
  hasKey: () => boolean;
  autoApprove?: boolean;
  allowShell?: string[];
  web?: boolean;
  webLocal?: boolean;
  cwd?: string;
}

const version = (): string => {
  try {
    return (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
};

/** Statuses that mean the task did not get done. (needs_person is the agent's own question: a reply, not an error.) */
const FAILED = new Set(['limit', 'unfinished', 'stopped', 'paused']);

export async function serveMcp(o: McpServeOptions): Promise<void> {
  const log = o.log ?? (() => {});
  const calls = new Map<number | string, { abort: AbortController; cancelled: boolean }>();
  const write = (msg: Json) => void o.output.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  const reply = (id: number | string | null, result: unknown) => write({ id, result });
  const fail = (id: number | string | null, code: number, message: string) => write({ id, error: { code, message } });
  const text = (t: string, extra: Json = {}) => ({ content: [{ type: 'text', text: t }], ...extra });

  async function runTask(args: Json, signal: AbortSignal): Promise<Json> {
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    if (!prompt) throw new RpcError(E.params, '`prompt` is required: the task, in words');
    const cwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : (o.cwd ?? process.cwd());
    if (!isAbsolute(cwd)) throw new RpcError(E.params, '`cwd` must be an absolute path');
    if (args.max_usd !== undefined && !(Number(args.max_usd) > 0)) throw new RpcError(E.params, '`max_usd` must be a positive number');
    // No key: fail at once, naming it. (A tool error, not a protocol error: the call ran and could not work.)
    if (!o.hasKey()) return text('OPENROUTER_API_KEY is not set in the agento server\'s environment.', { isError: true });

    const model = typeof args.model === 'string' && args.model ? args.model : (o.defaultModel ?? STARTER);
    const strategy = loadStrategy(model);
    const session = createSession({
      provider: o.providerFor(model),
      model,
      root: cwd,
      toolsets: unattended(standardToolsets({ root: cwd, web: o.web !== false, webOptions: { allowPrivate: !!o.webLocal } }), { autoApprove: o.autoApprove, allowShell: o.allowShell }),
      skills: dirSkills(join(cwd, '.claude', 'skills'), join(homedir(), '.claude', 'skills')),
      guidance: strategy ? strategy.guidance : (o.guidance ?? 'auto'),
      strategy: strategy ?? undefined,
      maxUsd: args.max_usd !== undefined ? Number(args.max_usd) : (o.maxUsd ?? 0.5),
      ask: async () => 'no', // nothing here asks: the toolset already holds only what is allowed
      onEvent: () => {},
      logPath: join(home(), 'sessions', `${new Date().toISOString().replace(/[:.]/g, '-')}-mcp.jsonl`),
      profilesPath: join(home(), 'profiles.json'),
    });
    try {
      const r = await session.send(prompt, signal);
      const note = r.status === 'limit' && r.reason ? `\n\n(stopped: ${r.reason})` : '';
      const body = r.answer ? `${r.answer}${note}` : (r.reason ?? `The agent ended with status "${r.status}" and no answer.`);
      return text(body, { structuredContent: { status: r.status, reason: r.reason, steps: r.steps, toolCalls: r.toolCalls, cost: r.cost, model }, ...(FAILED.has(r.status) ? { isError: true } : {}) });
    } catch (error) {
      if (signal.aborted) throw error;
      return text(error instanceof Error ? error.message : String(error), { isError: true });
    }
  }

  const handle = async (line: string): Promise<void> => {
    let msg: Json;
    try {
      msg = JSON.parse(line) as Json;
    } catch {
      return fail(null, E.parse, 'Parse error');
    }
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg) || typeof msg.method !== 'string') {
      // A response to something we never asked, or junk: nothing to do for a server that asks nothing.
      if (msg && typeof msg === 'object' && !Array.isArray(msg) && 'id' in msg && !('method' in msg)) return;
      return fail(null, E.request, 'Invalid request');
    }
    const id = msg.id as number | string | undefined;
    const params = (msg.params ?? {}) as Json;

    if (id === undefined) {
      if (msg.method === 'notifications/cancelled') {
        const c = calls.get(params.requestId as number | string);
        if (c) {
          c.cancelled = true;
          c.abort.abort();
        }
      }
      return; // notifications get no reply
    }

    try {
      switch (msg.method) {
        case 'initialize':
          return reply(id, {
            protocolVersion: VERSIONS.includes(String(params.protocolVersion)) ? params.protocolVersion : VERSIONS[0],
            capabilities: { tools: {} },
            serverInfo: { name: 'agento', title: 'agento', version: version() },
            instructions: 'One tool, run_task: give agento a task and it returns its answer. Read-only unless the server was started with --yes or --allow-shell.',
          });
        case 'ping':
          return reply(id, {});
        case 'tools/list':
          return reply(id, { tools: [RUN_TASK] });
        case 'tools/call': {
          if (params.name !== RUN_TASK.name) throw new RpcError(E.params, `Unknown tool "${String(params.name)}". The tool is "${RUN_TASK.name}".`);
          const call = { abort: new AbortController(), cancelled: false };
          calls.set(id, call);
          try {
            const result = await runTask((params.arguments ?? {}) as Json, call.abort.signal);
            if (!call.cancelled) reply(id, result); // a cancelled call is not answered (MCP: the caller has moved on)
          } catch (error) {
            if (!call.cancelled) throw error;
          } finally {
            calls.delete(id);
          }
          return;
        }
        default:
          throw new RpcError(E.method, `Method not found: ${String(msg.method)}`);
      }
    } catch (error) {
      if (error instanceof RpcError) fail(id, error.code, error.message);
      else fail(id, E.internal, error instanceof Error ? error.message : String(error));
    }
  };

  const lines = createInterface({ input: o.input, crlfDelay: Infinity });
  const running = new Set<Promise<void>>();
  lines.on('line', line => {
    if (!line.trim()) return;
    const p = handle(line).catch(error => log(`error: ${error instanceof Error ? error.stack : String(error)}\n`));
    running.add(p);
    void p.finally(() => running.delete(p));
  });
  await new Promise<void>(done => lines.once('close', done));
  for (const c of calls.values()) c.abort.abort();
  await Promise.allSettled([...running]);
}
