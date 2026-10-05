/**
 * `agento a2a` — the agent as an A2A server, so any agent that speaks Agent2Agent can hand it a task.
 *
 * A2A (the Agent2Agent protocol, at the Linux Foundation; this is version 1.0) is how one agent calls
 * another: the caller reads an Agent Card at `/.well-known/agent-card.json`, sends a message, and gets
 * back a Task it can poll, stream or cancel. Unlike MCP's one call, a Task has turns: when the agent
 * needs an answer from the person it says `TASK_STATE_INPUT_REQUIRED`, and the next message carries on.
 *
 * The protocol is `a2a-handler.ts`, a function from a web Request to a Response that runs anywhere.
 * This file is what Node adds to it:
 *   - `serveA2a`, the one place the package listens on a port (`node:http`, no dependency);
 *   - `agentoExecutor`, what a task DOES here: one agento session per `contextId`;
 *   - `fileStore` and `fileHistory`, tasks and conversations as JSON files in a folder, for several
 *     instances behind one address or instances that do not last (a mounted volume is enough).
 * The engine does not import this file.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dirSkills, type AgentEvent, type ChatMessage, type Guidance, type ModelProvider } from '../index.ts';
import { standardToolsets } from '../toolkit/index.ts';
import { a2aHandler, type A2aExecutor, type A2aHandlerOptions, type A2aStore, type A2aTurn, type StoredTask } from './a2a-handler.ts';
import { home } from './config.ts';
import { loadStrategy } from './gym/strategy.ts';
import { STARTER } from './models.ts';
import { createSession, type Session } from './session.ts';
import { unattended } from './unattended.ts';

export * from './a2a-handler.ts';

const version = (): string => {
  try {
    return (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
};

export interface A2aOptions extends A2aHandlerOptions {
  /** Default 0: the system picks a free port (read it from the handle). */
  port?: number;
  /** Default 127.0.0.1: reachable from this machine only. A container needs 0.0.0.0. */
  host?: string;
}

export interface A2aHandle {
  port: number;
  url: string;
  close(): Promise<void>;
}

/** The protocol on a port: each HTTP request becomes a web Request for the handler, and its Response is written back. */
export async function serveA2a(o: A2aOptions): Promise<A2aHandle> {
  const log = o.log ?? (() => {});
  const handler = a2aHandler({ ...o, card: { version: version(), ...o.card } });
  const host = o.host ?? '127.0.0.1';
  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req as AsyncIterable<Buffer>) {
          size += chunk.length;
          if (size > 4_000_000) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            return void res.end(JSON.stringify({ error: { code: 413, status: 'INVALID_ARGUMENT', message: 'Request too large' } }));
          }
          chunks.push(chunk);
        }
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        const method = req.method ?? 'GET';
        let request: Request;
        try {
          request = new Request(`http://${req.headers.host ?? `${host}:${handle.port}`}${req.url ?? '/'}`, { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : Buffer.concat(chunks) });
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return void res.end(JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Bad request' } }));
        }
        const response = await handler.fetch(request);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        if (!response.body) return void res.end();
        const reader = response.body.getReader();
        res.on('close', () => void reader.cancel().catch(() => {}));
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
        res.end();
      } catch (error) {
        log(`a2a: ${error instanceof Error ? error.stack : String(error)}\n`);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    })();
  });
  const handle: A2aHandle = {
    port: 0,
    url: '',
    close: () =>
      new Promise<void>(done => {
        handler.close();
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
  await new Promise<void>((ready, fail) => {
    server.once('error', fail);
    server.listen(o.port ?? 0, host, ready);
  });
  handle.port = (server.address() as { port: number }).port;
  handle.url = (o.publicUrl ?? `http://${host}:${handle.port}`).replace(/\/+$/, '');
  return handle;
}

// ---------- keeping tasks and conversations in a folder ----------

const readJson = <T,>(path: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
};
/** Whole or not at all: a reader on another instance never sees half a file. */
const writeJson = (dir: string, name: string, value: unknown) => {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${name}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, join(dir, name));
};

/** Tasks as one JSON file each under `<dir>/tasks`. Good for a shared volume; a table or a key-value store does the same job through `A2aStore`. */
export function fileStore(dir: string): A2aStore {
  const folder = join(dir, 'tasks');
  // Task ids are made by the server (UUIDs); anything else cannot name a file here.
  const file = (id: string) => (/^[A-Za-z0-9-]{1,64}$/.test(id) ? `${id}.json` : null);
  return {
    async get(id) {
      const name = file(id);
      return name ? readJson<StoredTask>(join(folder, name)) : undefined;
    },
    async put(task) {
      const name = file(task.id);
      if (!name) throw new Error(`not a task id: ${task.id}`);
      writeJson(folder, name, task);
    },
    async list() {
      let names: string[];
      try {
        names = readdirSync(folder);
      } catch {
        return [];
      }
      return names.filter(n => n.endsWith('.json') && !n.startsWith('.')).flatMap(n => readJson<StoredTask>(join(folder, n)) ?? []);
    },
  };
}

/** Where a conversation is kept between turns, when the instance that held it may be gone. */
export interface A2aHistory {
  load(contextId: string): Promise<ChatMessage[] | undefined>;
  save(contextId: string, messages: ChatMessage[]): Promise<void>;
}

/** Conversations as one JSON file each under `<dir>/contexts`. A contextId comes from the caller, so the file is named by its hash. */
export function fileHistory(dir: string): A2aHistory {
  const folder = join(dir, 'contexts');
  const file = (contextId: string) => `${createHash('sha256').update(contextId).digest('hex')}.json`;
  return {
    load: async contextId => readJson<ChatMessage[]>(join(folder, file(contextId))),
    save: async (contextId, messages) => writeJson(folder, file(contextId), messages),
  };
}

// ---------- the executor that runs agento ----------

export interface AgentoExecutorOptions {
  defaultModel?: string;
  providerFor: (model: string) => ModelProvider;
  guidance?: Guidance;
  maxUsd?: number;
  hasKey: () => boolean;
  autoApprove?: boolean;
  allowShell?: string[];
  /** False leaves the file and shell tools out: an agent with the web only, and no folder to stand in. */
  files?: boolean;
  web?: boolean;
  webLocal?: boolean;
  cwd?: string;
  /** Conversations outlive the instance. Default: this instance's memory. */
  history?: A2aHistory;
  /** Conversations kept in memory, one per contextId. */
  maxContexts?: number;
}

/**
 * One contextId is one agento session: a second task in the same context, or an answer to a task that
 * asked for input, carries the conversation on. Nobody is there to approve a change, so what the model
 * is offered is decided up front by `unattended()`, exactly as for `agento mcp`.
 */
export function agentoExecutor(o: AgentoExecutorOptions): A2aExecutor {
  type Context = { session: Session; turn: A2aTurn | null; queue: Promise<void> };
  const contexts = new Map<string, Context>();
  const cwd = o.cwd ?? process.cwd();
  const model = o.defaultModel ?? STARTER;
  const withFiles = o.files !== false;
  const contextFor = (id: string): Context => {
    const known = contexts.get(id);
    if (known) return known;
    const strategy = loadStrategy(model);
    const tools = standardToolsets({ ...(withFiles ? { root: cwd } : { files: false, shell: false }), web: o.web !== false, webOptions: { allowPrivate: !!o.webLocal } });
    const created: Context = {
      turn: null,
      queue: Promise.resolve(),
      session: createSession({
        provider: o.providerFor(model),
        model,
        root: cwd,
        toolsets: unattended(tools, { autoApprove: o.autoApprove, allowShell: o.allowShell }),
        skills: dirSkills(join(cwd, '.claude', 'skills'), join(homedir(), '.claude', 'skills')),
        guidance: strategy ? strategy.guidance : (o.guidance ?? 'auto'),
        strategy: strategy ?? undefined,
        maxUsd: o.maxUsd ?? 0.5,
        ask: async () => 'no', // nothing here asks: the toolset already holds only what is allowed
        // What the agent is doing, for a caller that streams: one line per tool it calls.
        onEvent: (event: AgentEvent) => {
          if (event.type === 'tool_call') created.turn?.status('TASK_STATE_WORKING', `Using ${event.name}`);
        },
        logPath: join(home(), 'sessions', `${new Date().toISOString().replace(/[:.]/g, '-')}-a2a.jsonl`),
        profilesPath: join(home(), 'profiles.json'),
      }),
    };
    contexts.set(id, created);
    if (contexts.size > (o.maxContexts ?? 200)) contexts.delete(contexts.keys().next().value as string);
    return created;
  };

  return async turn => {
    if (!turn.text.trim()) return turn.status('TASK_STATE_REJECTED', 'The message has no text: send the task in words, as a text part.');
    if (!o.hasKey()) return turn.status('TASK_STATE_FAILED', 'OPENROUTER_API_KEY is not set in the agento server\'s environment.');
    turn.status('TASK_STATE_WORKING');
    const c = contextFor(turn.contextId);
    // One turn at a time per conversation: a session has one history.
    const mine = c.queue.then(async () => {
      if (turn.signal.aborted) return;
      c.turn = turn;
      try {
        // The last turn of this conversation may have run on another instance: what was kept is the truth.
        const kept = await o.history?.load(turn.contextId);
        if (kept) c.session.history = kept;
        const r = await c.session.send(turn.text, turn.signal);
        await o.history?.save(turn.contextId, c.session.history);
        turn.meta({ agento: { status: r.status, reason: r.reason, steps: r.steps, toolCalls: r.toolCalls, cost: r.cost, model } });
        const said = r.answer ?? r.reason ?? `The agent ended with status "${r.status}" and no answer.`;
        if (r.status === 'needs_person') return turn.status('TASK_STATE_INPUT_REQUIRED', said);
        if (r.status === 'limit' || r.status === 'unfinished' || r.status === 'stopped' || r.status === 'paused') return turn.status('TASK_STATE_FAILED', r.status === 'limit' && r.reason && r.answer ? `${r.answer}\n\n(stopped: ${r.reason})` : said);
        turn.artifact(said, { name: 'answer' });
        turn.status('TASK_STATE_COMPLETED');
      } finally {
        c.turn = null;
      }
    });
    c.queue = mine.catch(() => {});
    await mine;
  };
}
