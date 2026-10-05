/**
 * `agento a2a` — the agent as an A2A server, so any agent that speaks Agent2Agent can hand it a task.
 *
 * A2A (the Agent2Agent protocol, at the Linux Foundation; this is version 1.0) is how one agent calls
 * another: the caller reads an Agent Card at `/.well-known/agent-card.json`, sends a message, and gets
 * back a Task it can poll, stream or cancel. Unlike MCP's one call, a Task has turns: when the agent
 * needs an answer from the person it says `TASK_STATE_INPUT_REQUIRED`, and the next message carries on.
 *
 * A2A runs over HTTP, so this is the one place the package listens on a port: `node:http`, two of the
 * protocol's bindings on the same task store (JSON-RPC 2.0 at `POST /`, and HTTP+JSON as REST paths),
 * Server-Sent Events for streams, hand-written like ACP and MCP (the package keeps zero runtime
 * dependencies). The engine does not import this file.
 *
 * Two halves. `serveA2a` is the protocol: the card, the task store, the operations. What a task DOES is
 * the `executor`, injected: `agentoExecutor` runs an agento session, and the compliance kit's fixture
 * runs a scripted one. The executor can only steer the task through `A2aTurn`.
 *
 * Not offered, and said so in the card: push notifications, the extended card, gRPC.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dirSkills, type AgentEvent, type Guidance, type ModelProvider } from '../index.ts';
import { standardToolsets } from '../toolkit/index.ts';
import { home } from './config.ts';
import { loadStrategy } from './gym/strategy.ts';
import { STARTER } from './models.ts';
import { createSession, type Session } from './session.ts';
import { unattended } from './unattended.ts';

type Json = Record<string, any>;

export const A2A_VERSION = '1.0';
export const CARD_PATH = '/.well-known/agent-card.json';

export type TaskState =
  | 'TASK_STATE_SUBMITTED'
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_CANCELED'
  | 'TASK_STATE_INPUT_REQUIRED'
  | 'TASK_STATE_REJECTED'
  | 'TASK_STATE_AUTH_REQUIRED';
const STATES = new Set<string>(['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING', 'TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_REJECTED', 'TASK_STATE_AUTH_REQUIRED']);
const TERMINAL = new Set<string>(['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED']);
const INTERRUPTED = new Set<string>(['TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_AUTH_REQUIRED']);
/** A stream closes, and a blocking send returns, when the task rests: done for good, or waiting on the caller. */
const rests = (state: string) => TERMINAL.has(state) || INTERRUPTED.has(state);

/** A2A's own errors (spec 5.4): the JSON-RPC code and the reason carried in `google.rpc.ErrorInfo`. */
export const A2A_ERRORS = {
  taskNotFound: [-32001, 'TASK_NOT_FOUND', 'Task not found'],
  notCancelable: [-32002, 'TASK_NOT_CANCELABLE', 'Task cannot be canceled'],
  pushNotSupported: [-32003, 'PUSH_NOTIFICATION_NOT_SUPPORTED', 'Push notifications are not supported'],
  unsupported: [-32004, 'UNSUPPORTED_OPERATION', 'This operation is not supported'],
  contentType: [-32005, 'CONTENT_TYPE_NOT_SUPPORTED', 'Media type not supported'],
  version: [-32009, 'VERSION_NOT_SUPPORTED', 'A2A version not supported'],
} as const;
const RPC = { parse: -32700, request: -32600, method: -32601, params: -32602, internal: -32603 } as const;

export class A2aError extends Error {
  code: number;
  data: Json[];
  constructor(code: number, message: string, data: Json[] = []) {
    super(message);
    this.code = code;
    this.data = data;
  }
}
const a2aError = (kind: keyof typeof A2A_ERRORS, message?: string, metadata: Record<string, string> = {}) => {
  const [code, reason, standard] = A2A_ERRORS[kind];
  return new A2aError(code, message ?? standard, [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'a2a-protocol.org', metadata }]);
};
const badParams = (field: string, description: string) =>
  new A2aError(RPC.params, `Invalid parameters: ${field}: ${description}`, [{ '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field, description }] }]);

/** One part of a message or an artifact, as A2A spells it: exactly one of text / raw / url / data. */
export type Part = { text: string } | { raw: string; filename?: string; mediaType?: string } | { url: string; filename?: string; mediaType?: string } | { data: unknown; mediaType?: string };

/** What an executor may do with the turn it was given. Calls after the task has ended are ignored. */
export interface A2aTurn {
  /** The caller's message, as sent. */
  message: Json;
  /** Its text parts, joined. */
  text: string;
  taskId: string;
  contextId: string;
  /** False when this message continues a task that was waiting for input. */
  first: boolean;
  /** Aborted when the caller cancels the task. */
  signal: AbortSignal;
  /** Answer with a plain Message and no Task. Only as the first thing a new task's turn does. */
  reply(parts: Part[] | string): void;
  /** Move the task to a state, with an optional word for the caller. */
  status(state: TaskState, text?: string): void;
  /** Add an output. `append` continues the artifact with the same id; `lastChunk` marks its end. */
  artifact(parts: Part[] | string, options?: { artifactId?: string; name?: string; append?: boolean; lastChunk?: boolean }): void;
  /** Merge keys into the task's metadata (the cost of a run travels here). */
  meta(values: Json): void;
}
export type A2aExecutor = (turn: A2aTurn) => Promise<void>;

export interface A2aCard {
  name?: string;
  description?: string;
  skills?: Json[];
  inputModes?: string[];
  outputModes?: string[];
}

export interface A2aOptions {
  executor: A2aExecutor;
  /** Default 0: the system picks a free port (read it from the handle). */
  port?: number;
  /** Default 127.0.0.1: reachable from this machine only. */
  host?: string;
  /** The address callers should use, when it is not the one a request arrives on (a proxy, a tunnel). */
  publicUrl?: string;
  /** When set, every call must carry `Authorization: Bearer <token>`. The card stays public. */
  token?: string;
  card?: A2aCard;
  log?: (text: string) => void;
  /** Tasks kept in memory; the oldest finished ones go first. */
  maxTasks?: number;
}

export interface A2aHandle {
  port: number;
  url: string;
  close(): Promise<void>;
}

interface TaskRecord {
  id: string;
  contextId: string;
  seq: number;
  state: TaskState;
  statusMessage?: Json;
  timestamp: string;
  artifacts: Json[];
  history: Json[];
  metadata: Json;
  /** Told to the caller yet? A task whose turn opens with `reply` never is. */
  published: boolean;
  listeners: Set<(event: Json) => void>;
  waiters: Set<() => void>;
  abort: AbortController;
  running: boolean;
}

const version = (): string => {
  try {
    return (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
};

const toParts = (p: Part[] | string): Part[] => (typeof p === 'string' ? [{ text: p }] : p);
const CONTENT = ['text', 'raw', 'url', 'data'];

export async function serveA2a(o: A2aOptions): Promise<A2aHandle> {
  const log = o.log ?? (() => {});
  const tasks = new Map<string, TaskRecord>();
  const maxTasks = o.maxTasks ?? 1000;
  const inputModes = o.card?.inputModes ?? ['text/plain'];
  const outputModes = o.card?.outputModes ?? ['text/plain'];
  let seq = 0;
  let lastStamp = 0;
  /** Strictly increasing, so "most recently updated first" never ties. */
  const stamp = (): string => {
    lastStamp = Math.max(Date.now(), lastStamp + 1);
    return new Date(lastStamp).toISOString();
  };

  const card = (base: string): Json => ({
    name: o.card?.name ?? 'agento',
    description: o.card?.description ?? 'A general agent: give it a task in words and it works on its own (reading and searching files, browsing the web, and changing files or running commands only if its operator allows), then returns its answer.',
    version: version(),
    supportedInterfaces: [
      { url: `${base}/`, protocolBinding: 'JSONRPC', protocolVersion: A2A_VERSION },
      { url: base, protocolBinding: 'HTTP+JSON', protocolVersion: A2A_VERSION },
    ],
    capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false },
    defaultInputModes: inputModes,
    defaultOutputModes: outputModes,
    skills: o.card?.skills ?? [
      {
        id: 'run_task',
        name: 'Run a task',
        description: 'Works on a self-contained task and returns the answer as a text artifact. Asks back (input required) when it cannot go on without the caller.',
        tags: ['agent', 'files', 'web', 'research'],
        examples: ['Summarize what this folder contains.', 'Find the latest stable version of Node.js and name the page you read it on.'],
      },
    ],
    ...(o.token ? { securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } }, securityRequirements: [{ schemes: { bearer: { list: [] } } }] } : {}),
  });

  // ---------- the task store ----------
  const snapshot = (t: TaskRecord, historyLength?: number, artifacts = true): Json => {
    const history = historyLength === undefined ? t.history : historyLength === 0 ? [] : t.history.slice(-historyLength);
    return {
      id: t.id,
      contextId: t.contextId,
      status: { state: t.state, ...(t.statusMessage ? { message: t.statusMessage } : {}), timestamp: t.timestamp },
      ...(artifacts && t.artifacts.length ? { artifacts: t.artifacts } : {}),
      ...(history.length ? { history } : {}),
      ...(Object.keys(t.metadata).length ? { metadata: t.metadata } : {}),
    };
  };
  const emit = (t: TaskRecord, event: Json) => {
    for (const l of [...t.listeners]) l(event);
  };
  const settle = (t: TaskRecord) => {
    for (const w of [...t.waiters]) w();
    t.waiters.clear();
  };
  const publish = (t: TaskRecord) => {
    if (t.published) return;
    t.published = true;
    tasks.set(t.id, t);
    if (tasks.size > maxTasks) for (const [id, old] of tasks) if (TERMINAL.has(old.state) && tasks.size > maxTasks) tasks.delete(id);
    emit(t, { task: snapshot(t) });
  };
  const agentMessage = (t: TaskRecord, parts: Part[], inTask = true): Json => ({ messageId: randomUUID(), contextId: t.contextId, ...(inTask ? { taskId: t.id } : {}), role: 'ROLE_AGENT', parts });
  const setState = (t: TaskRecord, state: TaskState, text?: string) => {
    t.state = state;
    t.timestamp = stamp();
    t.statusMessage = text ? agentMessage(t, [{ text }]) : undefined;
    if (t.statusMessage) t.history.push(t.statusMessage);
    emit(t, { statusUpdate: { taskId: t.id, contextId: t.contextId, status: { state, ...(t.statusMessage ? { message: t.statusMessage } : {}), timestamp: t.timestamp } } });
    if (rests(state)) settle(t);
  };

  /** Run one turn of the executor on a task. Resolves with a Message when the turn answered without a task. */
  function runTurn(t: TaskRecord, message: Json, first: boolean): { reply: Promise<Json | null> } {
    t.abort = new AbortController();
    t.running = true;
    const signal = t.abort.signal;
    const live = () => !signal.aborted && (!t.published || !TERMINAL.has(t.state));
    let answered: (m: Json | null) => void = () => {};
    const reply = new Promise<Json | null>(res => (answered = res));
    const text = (message.parts as Json[]).map(p => (typeof p.text === 'string' ? p.text : '')).filter(Boolean).join('\n');
    const turn: A2aTurn = {
      message,
      text,
      taskId: t.id,
      contextId: t.contextId,
      first,
      signal,
      reply(parts) {
        if (t.published || !live()) return;
        signal.throwIfAborted();
        t.running = false;
        t.abort.abort();
        answered(agentMessage(t, toParts(parts), false));
      },
      status(state, word) {
        if (!live()) return;
        publish(t);
        answered(null);
        setState(t, state, word);
      },
      artifact(parts, options = {}) {
        if (!live()) return;
        publish(t);
        answered(null);
        const artifactId = options.artifactId ?? randomUUID();
        const existing = t.artifacts.find(a => a.artifactId === artifactId);
        const chunk = { artifactId, ...(options.name ? { name: options.name } : {}), parts: toParts(parts) };
        if (existing && options.append) existing.parts.push(...chunk.parts);
        else if (existing) Object.assign(existing, chunk);
        else t.artifacts.push({ ...chunk, parts: [...chunk.parts] });
        t.timestamp = stamp();
        emit(t, { artifactUpdate: { taskId: t.id, contextId: t.contextId, artifact: chunk, append: !!options.append, lastChunk: options.lastChunk ?? !options.append } });
      },
      meta(values) {
        if (live()) Object.assign(t.metadata, values);
      },
    };
    void (async () => {
      try {
        await o.executor(turn);
        // An executor that returns without saying how it ended has finished.
        if (t.running && live() && !rests(t.state)) turn.status('TASK_STATE_COMPLETED');
      } catch (error) {
        if (t.running && live()) turn.status('TASK_STATE_FAILED', error instanceof Error ? error.message : String(error));
        else if (!signal.aborted) log(`a2a: ${error instanceof Error ? error.stack : String(error)}\n`);
      } finally {
        t.running = false;
        answered(null);
      }
    })();
    return { reply };
  }

  // ---------- reading requests ----------
  /** ProtoJSON readers accept a field under its proto name too (`history_length` for `historyLength`). */
  const camel = <T,>(v: T): T => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return v;
    const out: Json = {};
    for (const [k, value] of Object.entries(v)) out[k.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase())] = value;
    return out as T;
  };
  /** Only the protocol's own objects: never the free-form ones (metadata, a data part's value). */
  const normalize = (raw: Json): Json => {
    const params = camel(raw);
    if (params.configuration) params.configuration = camel(params.configuration);
    if (params.message && typeof params.message === 'object' && !Array.isArray(params.message)) {
      params.message = camel(params.message);
      if (Array.isArray(params.message.parts)) params.message.parts = (params.message.parts as unknown[]).map(camel);
    }
    return params;
  };
  const str = (v: unknown, field: string, required = true): string | undefined => {
    if (v === undefined || v === null || v === '') {
      if (required) throw badParams(field, 'is required');
      return undefined;
    }
    if (typeof v !== 'string') throw badParams(field, 'must be a string');
    return v;
  };
  const int = (v: unknown, field: string, min: number, max = Number.MAX_SAFE_INTEGER): number | undefined => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw badParams(field, `must be an integer from ${min}${max === Number.MAX_SAFE_INTEGER ? '' : ` to ${max}`}`);
    return v;
  };
  const find = (id: string): TaskRecord => {
    const t = tasks.get(id);
    if (!t) throw a2aError('taskNotFound', `Task not found: ${id}`, { taskId: id });
    return t;
  };

  function readMessage(params: Json): Json {
    const m = params.message;
    if (typeof m !== 'object' || m === null || Array.isArray(m)) throw badParams('message', 'is required');
    str(m.messageId, 'message.messageId');
    if (m.role !== 'ROLE_USER') throw badParams('message.role', 'must be ROLE_USER');
    if (!Array.isArray(m.parts) || !m.parts.length) throw badParams('message.parts', 'at least one part is required');
    for (const [i, p] of (m.parts as Json[]).entries()) {
      if (typeof p !== 'object' || p === null) throw badParams(`message.parts[${i}]`, 'must be an object');
      const kinds = CONTENT.filter(k => k in p);
      if (kinds.length !== 1) throw badParams(`message.parts[${i}]`, 'must have exactly one of text, raw, url, data');
      if (kinds[0] === 'text' && typeof p.text !== 'string') throw badParams(`message.parts[${i}].text`, 'must be a string');
    }
    for (const p of m.parts as Json[]) {
      const media = typeof p.mediaType === 'string' && p.mediaType ? p.mediaType : 'text' in p ? 'text/plain' : 'data' in p ? 'application/json' : 'application/octet-stream';
      if (!inputModes.includes(media)) throw a2aError('contentType', `Media type not supported: ${media}. This agent accepts ${inputModes.join(', ')}.`, { mediaType: media });
    }
    return m;
  }

  /** SendMessage and SendStreamingMessage, up to the point where the turn is running. */
  function send(params: Json): { task: TaskRecord; start: () => { reply: Promise<Json | null> }; historyLength?: number; returnImmediately: boolean } {
    const message = readMessage(params);
    const config = (typeof params.configuration === 'object' && params.configuration) || {};
    const historyLength = int(config.historyLength, 'configuration.historyLength', 0);
    if (config.taskPushNotificationConfig) throw a2aError('pushNotSupported');
    const taskId = str(message.taskId, 'message.taskId', false);
    const contextId = str(message.contextId, 'message.contextId', false);
    let t: TaskRecord;
    let first = true;
    if (taskId) {
      t = find(taskId);
      if (contextId && contextId !== t.contextId) throw badParams('message.contextId', 'does not match the context of the task');
      if (TERMINAL.has(t.state)) throw a2aError('unsupported', `Task ${taskId} has ended (${t.state}) and takes no more messages. Send a message without taskId to start a new one.`, { taskId });
      if (t.running) throw a2aError('unsupported', `Task ${taskId} is still working on the previous message.`, { taskId });
      first = false;
    } else {
      t = { id: randomUUID(), contextId: contextId ?? randomUUID(), seq: ++seq, state: 'TASK_STATE_SUBMITTED', timestamp: stamp(), artifacts: [], history: [], metadata: {}, published: false, listeners: new Set(), waiters: new Set(), abort: new AbortController(), running: false };
    }
    t.history.push({ ...message, taskId: t.id, contextId: t.contextId });
    return { task: t, start: () => runTurn(t, message, first), historyLength, returnImmediately: config.returnImmediately === true };
  }

  const waitRest = (t: TaskRecord) => new Promise<void>(res => (rests(t.state) && !t.running ? res() : t.waiters.add(res)));

  async function sendMessage(params: Json): Promise<Json> {
    const s = send(params);
    const { reply } = s.start();
    const message = await reply;
    if (message) return { message };
    if (!s.returnImmediately && !rests(s.task.state)) await waitRest(s.task);
    return { task: snapshot(s.task, s.historyLength) };
  }

  /** A stream of one task's events, `opening` first, closed when `closeOn` says the task has got there. */
  function stream(res: ServerResponse, wrap: (result: Json) => Json, t: TaskRecord, opening: Json | null, closeOn: (state: string) => boolean) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const write = (result: Json) => void res.write(`data: ${JSON.stringify(wrap(result))}\n\n`);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      t.listeners.delete(listener);
      res.end();
    };
    const listener = (event: Json) => {
      if (closed) return;
      write(event);
      if (event.statusUpdate && closeOn(event.statusUpdate.status.state)) close();
    };
    if (opening) write(opening);
    t.listeners.add(listener);
    res.on('close', () => {
      closed = true;
      t.listeners.delete(listener);
    });
    return {
      /** For a new message: the turn may answer with a plain Message, which is then the whole stream. */
      until: (reply: Promise<Json | null>) =>
        void reply.then(message => {
          if (closed) return;
          if (message) write({ message });
          if (message || (rests(t.state) && !t.running)) close();
        }),
    };
  }

  function listTasks(params: Json): Json {
    const contextId = str(params.contextId, 'contextId', false);
    const status = str(params.status, 'status', false);
    if (status !== undefined && !STATES.has(status)) throw badParams('status', 'must be a TaskState');
    const pageSize = int(params.pageSize, 'pageSize', 1, 100) ?? 50;
    const historyLength = int(params.historyLength, 'historyLength', 0) ?? 0;
    const after = str(params.statusTimestampAfter, 'statusTimestampAfter', false);
    if (after !== undefined && Number.isNaN(Date.parse(after))) throw badParams('statusTimestampAfter', 'must be an ISO 8601 timestamp');
    if (params.includeArtifacts !== undefined && typeof params.includeArtifacts !== 'boolean') throw badParams('includeArtifacts', 'must be a boolean');
    const all = [...tasks.values()]
      .filter(t => (!contextId || t.contextId === contextId) && (!status || t.state === status) && (!after || Date.parse(t.timestamp) >= Date.parse(after)))
      .sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : b.seq - a.seq));
    // The cursor is the last task of the page before: the next page is whatever now sorts after it.
    let from = 0;
    const token = str(params.pageToken, 'pageToken', false);
    if (token) {
      let cursor: { t?: string; s?: number };
      try {
        cursor = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as { t?: string; s?: number };
      } catch {
        cursor = {};
      }
      if (typeof cursor.t !== 'string' || typeof cursor.s !== 'number') throw badParams('pageToken', 'is not a token this server issued');
      from = all.findIndex(t => t.timestamp < cursor.t! || (t.timestamp === cursor.t && t.seq < cursor.s!));
      if (from < 0) from = all.length;
    }
    const page = all.slice(from, from + pageSize);
    const last = page.at(-1);
    return {
      tasks: page.map(t => snapshot(t, historyLength, params.includeArtifacts === true)),
      nextPageToken: last && from + pageSize < all.length ? Buffer.from(JSON.stringify({ t: last.timestamp, s: last.seq })).toString('base64url') : '',
      pageSize,
      totalSize: all.length,
    };
  }

  function cancel(params: Json): Json {
    const t = find(str(params.id, 'id')!);
    if (TERMINAL.has(t.state)) throw a2aError('notCancelable', `Task ${t.id} has already ended (${t.state}).`, { taskId: t.id });
    t.running = false;
    t.abort.abort();
    setState(t, 'TASK_STATE_CANCELED');
    return snapshot(t);
  }

  // ---------- HTTP ----------
  const PUSH = new Set(['CreateTaskPushNotificationConfig', 'GetTaskPushNotificationConfig', 'ListTaskPushNotificationConfigs', 'DeleteTaskPushNotificationConfig']);
  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...headers });
    res.end(text);
  };
  const body = (req: IncomingMessage) =>
    new Promise<string>((res, rej) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > 4_000_000) {
          rej(new A2aError(RPC.request, 'Request too large'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => res(Buffer.concat(chunks).toString('utf8')));
      req.on('error', rej);
    });

  /** The version asked for: Major.Minor, the patch ignored. No header at all means 0.3 (spec 3.6.2), which this server does not speak. */
  function checkVersion(req: IncomingMessage, url: URL) {
    const header = req.headers['a2a-version'];
    const asked = (Array.isArray(header) ? header[0] : header) ?? url.searchParams.get('A2A-Version') ?? '';
    const wanted = asked.trim() ? asked.trim().split('.').slice(0, 2).join('.') : '0.3';
    if (wanted !== A2A_VERSION) throw a2aError('version', `A2A version ${wanted} is not supported. This agent speaks ${A2A_VERSION}: send the header "A2A-Version: ${A2A_VERSION}".`, { requested: wanted, supported: A2A_VERSION });
  }
  /** A body that is not JSON is a media type this agent does not take. */
  function checkContentType(req: IncomingMessage) {
    const type = req.headers['content-type'];
    if (type && !/json/i.test(type)) throw a2aError('contentType', `Content-Type ${type} is not supported: send application/json.`, { mediaType: type });
  }

  /** One operation, whichever binding it arrived on. `wrap` dresses a result for that binding. */
  async function operate(method: string, raw: Json, res: ServerResponse, wrap: (result: Json) => Json) {
    const params = normalize(raw);
    switch (method) {
      case 'SendMessage':
        return json(res, 200, wrap(await sendMessage(params)));
      case 'SendStreamingMessage': {
        const s = send(params);
        // Listen before the turn starts: its first event is the Task itself.
        // A message to a task that was waiting opens with that task as it stands.
        const opened = stream(res, wrap, s.task, s.task.published ? { task: snapshot(s.task, s.historyLength) } : null, rests);
        opened.until(s.start().reply);
        return;
      }
      case 'GetTask':
        return json(res, 200, wrap(snapshot(find(str(params.id, 'id')!), int(params.historyLength, 'historyLength', 0))));
      case 'ListTasks':
        return json(res, 200, wrap(listTasks(params)));
      case 'CancelTask':
        return json(res, 200, wrap(cancel(params)));
      case 'SubscribeToTask': {
        const t = find(str(params.id, 'id')!);
        if (TERMINAL.has(t.state)) throw a2aError('unsupported', `Task ${t.id} has ended (${t.state}): there is nothing left to subscribe to. Read it with GetTask.`, { taskId: t.id });
        // A subscriber outlives a pause: the stream ends only when the task does.
        stream(res, wrap, t, { task: snapshot(t) }, state => TERMINAL.has(state));
        return;
      }
      case 'GetExtendedAgentCard':
        throw a2aError('unsupported', 'This agent has no extended Agent Card.');
      default:
        if (PUSH.has(method)) throw a2aError('pushNotSupported');
        throw new A2aError(RPC.method, `Method not found: ${method}`);
    }
  }

  /** The JSON-RPC binding: POST / with `{ jsonrpc, id, method, params }`. Errors travel in a 200. */
  async function rpc(req: IncomingMessage, res: ServerResponse, url: URL) {
    let id: unknown = null;
    try {
      checkContentType(req);
      let msg: Json;
      try {
        msg = JSON.parse(await body(req)) as Json;
      } catch (error) {
        throw error instanceof A2aError ? error : new A2aError(RPC.parse, 'Invalid JSON payload');
      }
      if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) throw new A2aError(RPC.request, 'Request payload validation error');
      if (typeof msg.id === 'string' || typeof msg.id === 'number') id = msg.id;
      if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string' || (msg.params !== undefined && (typeof msg.params !== 'object' || msg.params === null))) throw new A2aError(RPC.request, 'Request payload validation error');
      checkVersion(req, url);
      await operate(msg.method, (msg.params ?? {}) as Json, res, result => ({ jsonrpc: '2.0', id, result }));
    } catch (error) {
      if (res.headersSent) return void res.end();
      const e = error instanceof A2aError ? error : new A2aError(RPC.internal, error instanceof Error ? error.message : String(error));
      if (!(error instanceof A2aError)) log(`a2a: ${error instanceof Error ? error.stack : String(error)}\n`);
      json(res, 200, { jsonrpc: '2.0', id: id ?? null, error: { code: e.code, message: e.message, ...(e.data.length ? { data: e.data } : {}) } });
    }
  }

  /** The HTTP+JSON binding: the same operations as REST paths. Errors are HTTP statuses with a google.rpc.Status body. */
  const REST_STATUS: Record<number, [number, string]> = {
    [-32001]: [404, 'NOT_FOUND'], [-32002]: [409, 'FAILED_PRECONDITION'], [-32003]: [400, 'FAILED_PRECONDITION'], [-32004]: [400, 'FAILED_PRECONDITION'], [-32005]: [415, 'INVALID_ARGUMENT'], [-32009]: [400, 'FAILED_PRECONDITION'],
    [RPC.parse]: [400, 'INVALID_ARGUMENT'], [RPC.request]: [400, 'INVALID_ARGUMENT'], [RPC.params]: [400, 'INVALID_ARGUMENT'], [RPC.method]: [404, 'NOT_FOUND'], [RPC.internal]: [500, 'INTERNAL'],
  };
  function restRoute(method: string, path: string): { op: string; params: Json } | null {
    if (method === 'POST' && path === '/message:send') return { op: 'SendMessage', params: {} };
    if (method === 'POST' && path === '/message:stream') return { op: 'SendStreamingMessage', params: {} };
    if (method === 'GET' && path === '/tasks') return { op: 'ListTasks', params: {} };
    if (method === 'GET' && path === '/extendedAgentCard') return { op: 'GetExtendedAgentCard', params: {} };
    const m = /^\/tasks\/([^/:]+)(?::(cancel|subscribe)|\/pushNotificationConfigs(?:\/[^/]+)?)?$/.exec(path);
    if (!m) return null;
    const params = { id: decodeURIComponent(m[1]!) };
    if (path.includes('/pushNotificationConfigs')) return { op: 'CreateTaskPushNotificationConfig', params };
    if (m[2] === 'cancel' && method === 'POST') return { op: 'CancelTask', params };
    if (m[2] === 'subscribe' && (method === 'POST' || method === 'GET')) return { op: 'SubscribeToTask', params };
    if (!m[2] && method === 'GET') return { op: 'GetTask', params };
    return null;
  }
  async function rest(req: IncomingMessage, res: ServerResponse, url: URL, route: { op: string; params: Json }) {
    try {
      const params: Json = { ...route.params };
      if (req.method === 'GET') {
        // Query values are text: the numbers and the one boolean are read back as what they are.
        for (const [k, v] of url.searchParams) {
          const key = k.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
          if (key === 'A2A-Version') continue;
          params[key] = key === 'pageSize' || key === 'historyLength' ? (/^-?\d+$/.test(v) ? Number(v) : v) : key === 'includeArtifacts' ? (v === 'true' ? true : v === 'false' ? false : v) : v;
        }
      } else {
        checkContentType(req);
        const text = await body(req);
        if (text.trim()) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            throw new A2aError(RPC.parse, 'Invalid JSON payload');
          }
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new A2aError(RPC.request, 'Request payload validation error');
          Object.assign(params, parsed, route.params);
        }
      }
      checkVersion(req, url);
      await operate(route.op, params, res, result => result);
    } catch (error) {
      if (res.headersSent) return void res.end();
      const e = error instanceof A2aError ? error : new A2aError(RPC.internal, error instanceof Error ? error.message : String(error));
      if (!(error instanceof A2aError)) log(`a2a: ${error instanceof Error ? error.stack : String(error)}\n`);
      const [status, name] = REST_STATUS[e.code] ?? [500, 'INTERNAL'];
      json(res, status, { error: { code: status, status: name, message: e.message, ...(e.data.length ? { details: e.data } : {}) } });
    }
  }

  const started = new Date().toUTCString();
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const base = (o.publicUrl ?? `http://${req.headers.host ?? `${o.host ?? '127.0.0.1'}:${handle.port}`}`).replace(/\/+$/, '');
    if (url.pathname === CARD_PATH) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD' });
      const text = JSON.stringify(card(base));
      const etag = `"${Buffer.from(`${text.length}-${version()}-${base}`).toString('base64url')}"`;
      const headers = { 'Cache-Control': 'public, max-age=3600', ETag: etag, 'Last-Modified': started };
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers);
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...headers });
      return res.end(req.method === 'HEAD' ? undefined : text);
    }
    const route = url.pathname === '/' ? null : restRoute(req.method ?? '', url.pathname);
    if (url.pathname !== '/' && !route) return json(res, 404, { error: { code: 404, status: 'NOT_FOUND', message: `Not found. The Agent Card is at ${CARD_PATH}; JSON-RPC calls are POST /, and REST calls are /message:send, /tasks, /tasks/{id}.` } });
    if (!route && req.method !== 'POST') return json(res, 405, { error: { code: 405, status: 'INVALID_ARGUMENT', message: 'Method not allowed: JSON-RPC calls are POST /.' } }, { Allow: 'POST' });
    if (o.token && req.headers.authorization !== `Bearer ${o.token}`) return json(res, 401, { error: { code: 401, status: 'UNAUTHENTICATED', message: 'Send "Authorization: Bearer <token>".' } }, { 'WWW-Authenticate': 'Bearer' });
    void (route ? rest(req, res, url, route) : rpc(req, res, url));
  });
  const handle: A2aHandle = {
    port: 0,
    url: '',
    close: () =>
      new Promise<void>(done => {
        for (const t of tasks.values()) {
          t.abort.abort();
          for (const l of [...t.listeners]) t.listeners.delete(l);
        }
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
  await new Promise<void>((ready, fail) => {
    server.once('error', fail);
    server.listen(o.port ?? 0, o.host ?? '127.0.0.1', ready);
  });
  handle.port = (server.address() as { port: number }).port;
  handle.url = (o.publicUrl ?? `http://${o.host ?? '127.0.0.1'}:${handle.port}`).replace(/\/+$/, '');
  return handle;
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
  web?: boolean;
  webLocal?: boolean;
  cwd?: string;
  /** Conversations kept in memory, one per contextId. */
  maxContexts?: number;
}

/**
 * One contextId is one agento session: a second task in the same context, or an answer to a task that
 * asked for input, carries the conversation on. Nobody is there to approve a change, so what the model
 * is offered is decided up front by `unattended()`, exactly as for `agento mcp`.
 */
export function agentoExecutor(o: AgentoExecutorOptions): A2aExecutor {
  const contexts = new Map<string, { session: Session; turn: A2aTurn | null; queue: Promise<void> }>();
  const cwd = o.cwd ?? process.cwd();
  const model = o.defaultModel ?? STARTER;
  const contextFor = (id: string) => {
    let c = contexts.get(id);
    if (c) return c;
    const strategy = loadStrategy(model);
    const created: { session: Session; turn: A2aTurn | null; queue: Promise<void> } = {
      turn: null,
      queue: Promise.resolve(),
      session: createSession({
        provider: o.providerFor(model),
        model,
        root: cwd,
        toolsets: unattended(standardToolsets({ root: cwd, web: o.web !== false, webOptions: { allowPrivate: !!o.webLocal } }), { autoApprove: o.autoApprove, allowShell: o.allowShell }),
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
    c = created;
    contexts.set(id, c);
    if (contexts.size > (o.maxContexts ?? 200)) contexts.delete(contexts.keys().next().value as string);
    return c;
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
        const r = await c.session.send(turn.text, turn.signal);
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
