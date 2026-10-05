/**
 * The A2A protocol itself (Agent2Agent 1.0), as one function: a web `Request` in, a `Response` out.
 *
 * It exists apart from `a2a.ts` so the protocol can run where there is no port to listen on and no
 * process that stays up: a serverless function, an edge worker, a container that scales to zero. So
 * this file imports nothing from Node, and nothing here assumes the next request reaches the same
 * instance:
 *   - a `store` (injected) holds every task, so a task sent to one instance can be read, continued,
 *     cancelled or watched from another; without one, tasks live in this instance's memory;
 *   - a turn's work is handed to the platform's `waitUntil`, for hosts that freeze an instance once
 *     its response is sent;
 *   - `streaming: false` takes Server-Sent Events off the card, for hosts that buffer responses;
 *   - the card's address follows `X-Forwarded-Proto` / `X-Forwarded-Host`, or `publicUrl`.
 *
 * Two bindings on the same tasks: JSON-RPC 2.0 at `POST /`, and HTTP+JSON as REST paths. What a task
 * DOES is the `executor`, injected, which can only steer the task through `A2aTurn`.
 *
 * Not offered, and said so in the card: push notifications, the extended card, gRPC.
 */

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
  version?: string;
  skills?: Json[];
  inputModes?: string[];
  outputModes?: string[];
}

/** A task as it is kept: plain data, safe to write as JSON. */
export interface StoredTask {
  id: string;
  contextId: string;
  state: TaskState;
  statusMessage?: Json;
  /** When the status or an artifact last changed, ISO 8601 UTC. */
  timestamp: string;
  artifacts: Json[];
  history: Json[];
  metadata: Json;
}

/**
 * Where tasks are kept when one instance's memory is not enough (several instances, or instances that
 * do not last). Three calls, so any key-value store, table or folder will do. `put` replaces the task.
 */
export interface A2aStore {
  get(id: string): Promise<StoredTask | undefined>;
  put(task: StoredTask): Promise<void>;
  list(): Promise<StoredTask[]>;
}

export interface A2aHandlerOptions {
  executor: A2aExecutor;
  /** Tasks outlive the instance and are shared between instances. Default: this instance's memory. */
  store?: A2aStore;
  /** The address callers should use. Default: the request's own, honouring X-Forwarded-Proto and X-Forwarded-Host. */
  publicUrl?: string;
  /** When set, every call must carry `Authorization: Bearer <token>`. The card stays public. */
  token?: string;
  card?: A2aCard;
  /** False takes streaming off the card, for a host that buffers responses. Default true. */
  streaming?: boolean;
  log?: (text: string) => void;
  /** Tasks kept in this instance's memory; the oldest that are not running go first. */
  maxTasks?: number;
  /** How often a watcher re-reads the store for a task another instance is running, in ms. Default 1000. */
  pollMs?: number;
}

/** What a host may offer with a request: `waitUntil` keeps the instance alive for work that outlasts the response. */
export interface A2aRequestContext {
  waitUntil?(work: Promise<unknown>): void;
}

export interface A2aHandler {
  fetch(request: Request, context?: A2aRequestContext): Promise<Response>;
  /** Stop every task running here and end every open stream. */
  close(): void;
}

interface TaskRecord extends StoredTask {
  /** Told to the caller yet? A task whose turn opens with `reply` never is. */
  published: boolean;
  listeners: Set<(event: Json) => void>;
  waiters: Set<() => void>;
  abort: AbortController;
  /** A turn is running on THIS instance. */
  running: boolean;
  /** The writes to the store still under way, in order. */
  saving: Promise<void>;
}

const toParts = (p: Part[] | string): Part[] => (typeof p === 'string' ? [{ text: p }] : p);
const CONTENT = ['text', 'raw', 'url', 'data'];
const PUSH = new Set(['CreateTaskPushNotificationConfig', 'GetTaskPushNotificationConfig', 'ListTaskPushNotificationConfigs', 'DeleteTaskPushNotificationConfig']);
const b64 = (text: string) => btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (text: string) => atob(text.replace(/-/g, '+').replace(/_/g, '/'));

export function a2aHandler(o: A2aHandlerOptions): A2aHandler {
  const log = o.log ?? (() => {});
  const store = o.store;
  const streaming = o.streaming !== false;
  const tasks = new Map<string, TaskRecord>();
  const maxTasks = o.maxTasks ?? 1000;
  const inputModes = o.card?.inputModes ?? ['text/plain'];
  const outputModes = o.card?.outputModes ?? ['text/plain'];
  const closers = new Set<() => void>();
  let lastStamp = 0;
  /** Strictly increasing, so "most recently updated first" never ties within an instance. */
  const stamp = (): string => {
    lastStamp = Math.max(Date.now(), lastStamp + 1);
    return new Date(lastStamp).toISOString();
  };

  const card = (base: string): Json => ({
    name: o.card?.name ?? 'agento',
    description: o.card?.description ?? 'A general agent: give it a task in words and it works on its own (reading and searching files, browsing the web, and changing files or running commands only if its operator allows), then returns its answer.',
    version: o.card?.version ?? '0.0.0',
    supportedInterfaces: [
      { url: `${base}/`, protocolBinding: 'JSONRPC', protocolVersion: A2A_VERSION },
      { url: base, protocolBinding: 'HTTP+JSON', protocolVersion: A2A_VERSION },
    ],
    capabilities: { streaming, pushNotifications: false, extendedAgentCard: false },
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

  // ---------- the tasks ----------
  const plain = (t: StoredTask): StoredTask => ({ id: t.id, contextId: t.contextId, state: t.state, ...(t.statusMessage ? { statusMessage: t.statusMessage } : {}), timestamp: t.timestamp, artifacts: t.artifacts, history: t.history, metadata: t.metadata });
  const snapshot = (t: StoredTask, historyLength?: number, artifacts = true): Json => {
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
  const statusEvent = (t: StoredTask): Json => ({ statusUpdate: { taskId: t.id, contextId: t.contextId, status: { state: t.state, ...(t.statusMessage ? { message: t.statusMessage } : {}), timestamp: t.timestamp } } });
  const emit = (t: TaskRecord, event: Json) => {
    for (const l of [...t.listeners]) l(event);
  };
  const settle = (t: TaskRecord) => {
    for (const w of [...t.waiters]) w();
    t.waiters.clear();
  };
  const record = (s: StoredTask, published: boolean): TaskRecord => ({ ...s, published, listeners: new Set(), waiters: new Set(), abort: new AbortController(), running: false, saving: Promise.resolve() });
  const remember = (t: TaskRecord) => {
    tasks.set(t.id, t);
    if (tasks.size > maxTasks) for (const [id, old] of tasks) if (tasks.size > maxTasks && !old.running && (store || TERMINAL.has(old.state))) tasks.delete(id);
  };
  /**
   * Write the task to the store, after the writes before it. Another instance may have cancelled it
   * meanwhile: then the cancellation stands, and the turn running here is stopped instead.
   */
  const persist = (t: TaskRecord) => {
    if (!store) return;
    const mine = t.running; // as the change was made: a turn that has since ended must still yield to a cancellation
    t.saving = t.saving
      .then(async () => {
        if (mine && t.state !== 'TASK_STATE_CANCELED') {
          const there = await store.get(t.id);
          if (there?.state === 'TASK_STATE_CANCELED') {
            t.running = false;
            t.abort.abort();
            // Whatever the turn added since is dropped with it: the task is as the store has it.
            Object.assign(t, plain(there), { statusMessage: there.statusMessage });
            emit(t, statusEvent(t));
            settle(t);
            return;
          }
        }
        await store.put(plain(t));
      })
      .catch(error => log(`a2a: could not save task ${t.id}: ${error instanceof Error ? error.message : String(error)}\n`));
  };
  const publish = (t: TaskRecord) => {
    if (t.published) return;
    t.published = true;
    remember(t);
    emit(t, { task: snapshot(t) });
  };
  const agentMessage = (t: StoredTask, parts: Part[], inTask = true): Json => ({ messageId: crypto.randomUUID(), contextId: t.contextId, ...(inTask ? { taskId: t.id } : {}), role: 'ROLE_AGENT', parts });
  const setState = (t: TaskRecord, state: TaskState, text?: string) => {
    t.state = state;
    t.timestamp = stamp();
    t.statusMessage = text ? agentMessage(t, [{ text }]) : undefined;
    if (t.statusMessage) t.history.push(t.statusMessage);
    emit(t, statusEvent(t));
    persist(t);
    if (rests(state)) settle(t);
  };

  /** The task as it is now. With a store, a task that is not running here is read again: another instance may have moved it. */
  async function find(id: string): Promise<TaskRecord> {
    let t = tasks.get(id);
    if (store && !t?.running) {
      await t?.saving;
      const there = await store.get(id);
      if (there && t) Object.assign(t, plain(there), { statusMessage: there.statusMessage });
      else if (there) remember((t = record(there, true)));
    }
    if (!t || !t.published) throw a2aError('taskNotFound', `Task not found: ${id}`, { taskId: id });
    return t;
  }

  /** Run one turn of the executor on a task. `reply` resolves with a Message when the turn answered without a task. */
  function runTurn(t: TaskRecord, message: Json, first: boolean, context?: A2aRequestContext): { reply: Promise<Json | null> } {
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
        const artifactId = options.artifactId ?? crypto.randomUUID();
        const existing = t.artifacts.find(a => a.artifactId === artifactId);
        const chunk = { artifactId, ...(options.name ? { name: options.name } : {}), parts: toParts(parts) };
        if (existing && options.append) existing.parts.push(...chunk.parts);
        else if (existing) Object.assign(existing, { ...chunk, parts: [...chunk.parts] });
        else t.artifacts.push({ ...chunk, parts: [...chunk.parts] });
        t.timestamp = stamp();
        emit(t, { artifactUpdate: { taskId: t.id, contextId: t.contextId, artifact: chunk, append: !!options.append, lastChunk: options.lastChunk ?? !options.append } });
        persist(t);
      },
      meta(values) {
        if (live()) Object.assign(t.metadata, values);
      },
    };
    const work = (async () => {
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
        settle(t);
      }
      await t.saving;
    })();
    // A host that freezes an instance once its response is sent is asked to wait for the turn.
    context?.waitUntil?.(work);
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

  /** SendMessage and SendStreamingMessage, up to the point where the turn can start. */
  async function send(params: Json, context?: A2aRequestContext): Promise<{ task: TaskRecord; start: () => { reply: Promise<Json | null> }; historyLength?: number; returnImmediately: boolean }> {
    const message = readMessage(params);
    const config = (typeof params.configuration === 'object' && params.configuration) || {};
    const historyLength = int(config.historyLength, 'configuration.historyLength', 0);
    if (config.taskPushNotificationConfig) throw a2aError('pushNotSupported');
    const taskId = str(message.taskId, 'message.taskId', false);
    const contextId = str(message.contextId, 'message.contextId', false);
    let t: TaskRecord;
    let first = true;
    if (taskId) {
      t = await find(taskId);
      if (contextId && contextId !== t.contextId) throw badParams('message.contextId', 'does not match the context of the task');
      if (TERMINAL.has(t.state)) throw a2aError('unsupported', `Task ${taskId} has ended (${t.state}) and takes no more messages. Send a message without taskId to start a new one.`, { taskId });
      // Working, here or on another instance: one turn at a time.
      if (t.running || !INTERRUPTED.has(t.state)) throw a2aError('unsupported', `Task ${taskId} is still working on the previous message.`, { taskId });
      first = false;
    } else {
      t = record({ id: crypto.randomUUID(), contextId: contextId ?? crypto.randomUUID(), state: 'TASK_STATE_SUBMITTED', timestamp: stamp(), artifacts: [], history: [], metadata: {} }, false);
    }
    t.history.push({ ...message, taskId: t.id, contextId: t.contextId });
    return { task: t, start: () => runTurn(t, message, first, context), historyLength, returnImmediately: config.returnImmediately === true };
  }

  const waitRest = (t: TaskRecord) => new Promise<void>(res => (rests(t.state) && !t.running ? res() : t.waiters.add(res)));

  async function sendMessage(params: Json, context?: A2aRequestContext): Promise<Json> {
    const s = await send(params, context);
    const { reply } = s.start();
    const message = await reply;
    if (message) return { message };
    if (!s.returnImmediately && !rests(s.task.state)) await waitRest(s.task);
    // What the caller is told must already be where another instance would look for it.
    await s.task.saving;
    return { task: snapshot(s.task, s.historyLength) };
  }

  async function listTasks(params: Json): Promise<Json> {
    const contextId = str(params.contextId, 'contextId', false);
    const status = str(params.status, 'status', false);
    if (status !== undefined && !STATES.has(status)) throw badParams('status', 'must be a TaskState');
    const pageSize = int(params.pageSize, 'pageSize', 1, 100) ?? 50;
    const historyLength = int(params.historyLength, 'historyLength', 0) ?? 0;
    const after = str(params.statusTimestampAfter, 'statusTimestampAfter', false);
    if (after !== undefined && Number.isNaN(Date.parse(after))) throw badParams('statusTimestampAfter', 'must be an ISO 8601 timestamp');
    if (params.includeArtifacts !== undefined && typeof params.includeArtifacts !== 'boolean') throw badParams('includeArtifacts', 'must be a boolean');
    const token = str(params.pageToken, 'pageToken', false);
    let cursor: { t?: string; i?: string } | null = null;
    if (token) {
      try {
        cursor = JSON.parse(unb64(token)) as { t?: string; i?: string };
      } catch {
        cursor = {};
      }
      if (typeof cursor.t !== 'string' || typeof cursor.i !== 'string') throw badParams('pageToken', 'is not a token this server issued');
    }
    // The store's tasks, with the ones running here as this instance knows them (it is ahead of the store).
    const known = new Map<string, StoredTask>();
    if (store) for (const s of await store.list()) known.set(s.id, s);
    for (const t of tasks.values()) if (t.published && (!store || t.running || !known.has(t.id))) known.set(t.id, t);
    const all = [...known.values()]
      .filter(t => (!contextId || t.contextId === contextId) && (!status || t.state === status) && (!after || Date.parse(t.timestamp) >= Date.parse(after)))
      .sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : a.id < b.id ? 1 : -1));
    // The cursor is the last task of the page before: the next page is whatever now sorts after it.
    let from = 0;
    if (cursor) {
      from = all.findIndex(t => t.timestamp < cursor.t! || (t.timestamp === cursor.t && t.id < cursor.i!));
      if (from < 0) from = all.length;
    }
    const page = all.slice(from, from + pageSize);
    const last = page.at(-1);
    return {
      tasks: page.map(t => snapshot(t, historyLength, params.includeArtifacts === true)),
      nextPageToken: last && from + pageSize < all.length ? b64(JSON.stringify({ t: last.timestamp, i: last.id })) : '',
      pageSize,
      totalSize: all.length,
    };
  }

  async function cancel(params: Json): Promise<Json> {
    const t = await find(str(params.id, 'id')!);
    if (TERMINAL.has(t.state)) throw a2aError('notCancelable', `Task ${t.id} has already ended (${t.state}).`, { taskId: t.id });
    // Running here: stop it. Running elsewhere: the store says so, and that instance stops at its next write.
    t.running = false;
    t.abort.abort();
    setState(t, 'TASK_STATE_CANCELED');
    await t.saving;
    return snapshot(t);
  }

  // ---------- responses ----------
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

  /** Server-Sent Events. `setup` is given how to write an event and how to end the stream, and returns how to let go. */
  function sse(wrap: (result: Json) => Json, setup: (write: (result: Json) => void, close: () => void) => () => void): Response {
    const encoder = new TextEncoder();
    let closed = false;
    let release = () => {};
    let close = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        close = () => {
          if (closed) return;
          closed = true;
          closers.delete(close);
          release();
          controller.close();
        };
        const write = (result: Json) => {
          if (!closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(wrap(result))}\n\n`));
        };
        closers.add(close);
        const letGo = setup(write, close);
        if (closed) letGo();
        else release = letGo;
      },
      cancel() {
        // The caller went away: the task carries on, nobody is listening here any more.
        closed = true;
        closers.delete(close);
        release();
      },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' } });
  }

  /** A task running on this instance: its events as they happen. */
  const watchLive = (t: TaskRecord, write: (r: Json) => void, close: () => void, closeOn: (state: string) => boolean) => {
    const listener = (event: Json) => {
      write(event);
      if (event.statusUpdate && closeOn(event.statusUpdate.status.state)) close();
    };
    t.listeners.add(listener);
    return () => void t.listeners.delete(listener);
  };
  /** A task some other instance may be running: the store is read again and again, and what changed is said. */
  const watchStore = (first: StoredTask, write: (r: Json) => void, close: () => void) => {
    let seen = first;
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const now = await store!.get(first.id);
        if (!now) return close();
        if (now.timestamp !== seen.timestamp || now.state !== seen.state) {
          for (const artifact of now.artifacts) {
            const before = seen.artifacts.find(a => a.artifactId === artifact.artifactId);
            if (JSON.stringify(before) !== JSON.stringify(artifact)) write({ artifactUpdate: { taskId: now.id, contextId: now.contextId, artifact, append: false, lastChunk: true } });
          }
          if (now.state !== seen.state || JSON.stringify(now.statusMessage) !== JSON.stringify(seen.statusMessage)) write(statusEvent(now));
          seen = now;
        }
        if (TERMINAL.has(now.state)) close();
      } catch (error) {
        log(`a2a: ${error instanceof Error ? error.message : String(error)}\n`);
      } finally {
        busy = false;
      }
    }, o.pollMs ?? 1000);
    return () => clearInterval(timer);
  };

  /** One operation, whichever binding it arrived on. `wrap` dresses a result for that binding. */
  async function operate(method: string, raw: Json, wrap: (result: Json) => Json, context?: A2aRequestContext): Promise<Response> {
    const params = normalize(raw);
    switch (method) {
      case 'SendMessage':
        return json(200, wrap(await sendMessage(params, context)));
      case 'SendStreamingMessage': {
        if (!streaming) throw a2aError('unsupported', 'This agent does not stream: use SendMessage, then GetTask.');
        const s = await send(params, context);
        return sse(wrap, (write, close) => {
          // A message to a task that was waiting opens with that task as it stands.
          if (s.task.published) write({ task: snapshot(s.task, s.historyLength) });
          // Listen before the turn starts: a new task's first event is the Task itself.
          const release = watchLive(s.task, write, close, rests);
          void s.start().reply.then(message => {
            // The turn may answer with a plain Message, which is then the whole stream.
            if (message) write({ message });
            if (message || (rests(s.task.state) && !s.task.running)) close();
          });
          return release;
        });
      }
      case 'GetTask':
        return json(200, wrap(snapshot(await find(str(params.id, 'id')!), int(params.historyLength, 'historyLength', 0))));
      case 'ListTasks':
        return json(200, wrap(await listTasks(params)));
      case 'CancelTask':
        return json(200, wrap(await cancel(params)));
      case 'SubscribeToTask': {
        if (!streaming) throw a2aError('unsupported', 'This agent does not stream: read the task with GetTask.');
        const t = await find(str(params.id, 'id')!);
        if (TERMINAL.has(t.state)) throw a2aError('unsupported', `Task ${t.id} has ended (${t.state}): there is nothing left to subscribe to. Read it with GetTask.`, { taskId: t.id });
        // A subscriber outlives a pause: the stream ends only when the task does.
        return sse(wrap, (write, close) => {
          write({ task: snapshot(t) });
          return store && !t.running ? watchStore(structuredClone(plain(t)), write, close) : watchLive(t, write, close, state => TERMINAL.has(state));
        });
      }
      case 'GetExtendedAgentCard':
        throw a2aError('unsupported', 'This agent has no extended Agent Card.');
      default:
        if (PUSH.has(method)) throw a2aError('pushNotSupported');
        throw new A2aError(RPC.method, `Method not found: ${method}`);
    }
  }

  /** The version asked for: Major.Minor, the patch ignored. No header at all means 0.3 (spec 3.6.2), which this server does not speak. */
  function checkVersion(request: Request, url: URL) {
    const asked = request.headers.get('a2a-version') ?? url.searchParams.get('A2A-Version') ?? '';
    const wanted = asked.trim() ? asked.trim().split('.').slice(0, 2).join('.') : '0.3';
    if (wanted !== A2A_VERSION) throw a2aError('version', `A2A version ${wanted} is not supported. This agent speaks ${A2A_VERSION}: send the header "A2A-Version: ${A2A_VERSION}".`, { requested: wanted, supported: A2A_VERSION });
  }
  /** A body that is not JSON is a media type this agent does not take. */
  function checkContentType(request: Request) {
    const type = request.headers.get('content-type');
    if (type && !/json/i.test(type)) throw a2aError('contentType', `Content-Type ${type} is not supported: send application/json.`, { mediaType: type });
  }
  const body = async (request: Request): Promise<string> => {
    const text = await request.text();
    if (text.length > 4_000_000) throw new A2aError(RPC.request, 'Request too large');
    return text;
  };
  const failure = (error: unknown): A2aError => {
    if (error instanceof A2aError) return error;
    log(`a2a: ${error instanceof Error ? error.stack : String(error)}\n`);
    return new A2aError(RPC.internal, error instanceof Error ? error.message : String(error));
  };

  /** The JSON-RPC binding: POST / with `{ jsonrpc, id, method, params }`. Errors travel in a 200. */
  async function rpc(request: Request, url: URL, context?: A2aRequestContext): Promise<Response> {
    let id: unknown = null;
    try {
      checkContentType(request);
      let msg: Json;
      try {
        msg = JSON.parse(await body(request)) as Json;
      } catch (error) {
        throw error instanceof A2aError ? error : new A2aError(RPC.parse, 'Invalid JSON payload');
      }
      if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) throw new A2aError(RPC.request, 'Request payload validation error');
      if (typeof msg.id === 'string' || typeof msg.id === 'number') id = msg.id;
      if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string' || (msg.params !== undefined && (typeof msg.params !== 'object' || msg.params === null))) throw new A2aError(RPC.request, 'Request payload validation error');
      checkVersion(request, url);
      return await operate(msg.method, (msg.params ?? {}) as Json, result => ({ jsonrpc: '2.0', id, result }), context);
    } catch (error) {
      const e = failure(error);
      return json(200, { jsonrpc: '2.0', id: id ?? null, error: { code: e.code, message: e.message, ...(e.data.length ? { data: e.data } : {}) } });
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
  async function rest(request: Request, url: URL, route: { op: string; params: Json }, context?: A2aRequestContext): Promise<Response> {
    try {
      const params: Json = { ...route.params };
      if (request.method === 'GET') {
        // Query values are text: the numbers and the one boolean are read back as what they are.
        for (const [k, v] of url.searchParams) {
          const key = k.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
          if (key === 'A2A-Version') continue;
          params[key] = key === 'pageSize' || key === 'historyLength' ? (/^-?\d+$/.test(v) ? Number(v) : v) : key === 'includeArtifacts' ? (v === 'true' ? true : v === 'false' ? false : v) : v;
        }
      } else {
        checkContentType(request);
        const text = await body(request);
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
      checkVersion(request, url);
      return await operate(route.op, params, result => result, context);
    } catch (error) {
      const e = failure(error);
      const [status, name] = REST_STATUS[e.code] ?? [500, 'INTERNAL'];
      return json(status, { error: { code: status, status: name, message: e.message, ...(e.data.length ? { details: e.data } : {}) } });
    }
  }

  const started = new Date().toUTCString();
  const hash = (text: string) => {
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
    return h.toString(16);
  };

  return {
    async fetch(request, context) {
      const url = new URL(request.url);
      const first = (name: string) => request.headers.get(name)?.split(',')[0]?.trim() || undefined;
      // Behind a proxy that ends TLS (every serverless host), the request arrives as plain http: the card must not say so.
      const base = (o.publicUrl ?? `${first('x-forwarded-proto') ?? url.protocol.replace(':', '')}://${first('x-forwarded-host') ?? url.host}`).replace(/\/+$/, '');
      if (url.pathname === CARD_PATH) {
        if (request.method !== 'GET' && request.method !== 'HEAD') return json(405, { error: { code: 405, status: 'INVALID_ARGUMENT', message: 'Method not allowed' } }, { Allow: 'GET, HEAD' });
        const text = JSON.stringify(card(base));
        const etag = `"${hash(text)}"`;
        const headers = { 'Cache-Control': 'public, max-age=3600', ETag: etag, 'Last-Modified': started };
        if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
        return new Response(request.method === 'HEAD' ? null : text, { status: 200, headers: { 'Content-Type': 'application/json', ...headers } });
      }
      const route = url.pathname === '/' ? null : restRoute(request.method, url.pathname);
      if (url.pathname !== '/' && !route) return json(404, { error: { code: 404, status: 'NOT_FOUND', message: `Not found. The Agent Card is at ${CARD_PATH}; JSON-RPC calls are POST /, and REST calls are /message:send, /tasks, /tasks/{id}.` } });
      if (!route && request.method !== 'POST') return json(405, { error: { code: 405, status: 'INVALID_ARGUMENT', message: 'Method not allowed: JSON-RPC calls are POST /.' } }, { Allow: 'POST' });
      if (o.token && request.headers.get('authorization') !== `Bearer ${o.token}`) return json(401, { error: { code: 401, status: 'UNAUTHENTICATED', message: 'Send "Authorization: Bearer <token>".' } }, { 'WWW-Authenticate': 'Bearer' });
      return route ? rest(request, url, route, context) : rpc(request, url, context);
    },
    close() {
      for (const t of tasks.values()) {
        t.running = false;
        t.abort.abort();
        t.listeners.clear();
        settle(t);
      }
      for (const close of [...closers]) close();
    },
  };
}
