/**
 * `agento acp` — the Agent Client Protocol, so an editor can run agento as its agent.
 *
 * ACP (Zed's standard, adopted by JetBrains and others) is to coding agents what LSP is to languages:
 * the editor launches the agent as a subprocess and talks JSON-RPC 2.0 over stdio, one message per
 * line. This is that conversation, written by hand over the public API — no SDK, so the package keeps
 * zero runtime dependencies (the official SDK and the protocol's conformance kit are test-time tools).
 *
 *   initialize ─► session/new ─► session/prompt ─► session/update … ─► {stopReason}
 *                                      ▲   session/request_permission ◄─► the person, in the editor
 *                                      └── session/cancel
 *
 * How agento's own pieces map onto it:
 *   streamed text     → agent_message_chunk          tool call     → tool_call, then tool_call_update
 *   approve()         → session/request_permission   AbortSignal   → session/cancel (stopReason cancelled)
 *   the USD / step cap → stopReason max_turn_requests    MCP servers   → the ones the editor passes in session/new
 * What it does NOT use yet: the editor's own file and terminal methods (agento reads the disk and runs
 * its own shell), session/load, images and audio.
 *
 * Unattended use (an agent answering in a chat channel, with no one to click "Allow"): `autoApprove`
 * approves everything; `allowShell` approves only SIMPLE shell commands that start with a given word —
 * simple meaning nothing that chains, redirects or expands (see simpleCommand).
 *
 * stdout belongs to the protocol: nothing else may be written there, so logs go to stderr.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { dirSkills, type ApprovalRequest, type Guidance, type ModelProvider, type Toolset } from '../index.ts';
import { home } from './config.ts';
import { loadStrategy } from './gym/strategy.ts';
import { connectSpecs, fromAcpMcp, mcpAvailable, type AcpMcpServer, type McpConnection } from './mcp.ts';
import { CURATED, labelOf, STARTER } from './models.ts';
import { createSession, type Answer, type Session } from './session.ts';
import { standardToolsets } from '../toolkit/index.ts';
import { describeCall } from './ui.ts';

export const PROTOCOL_VERSION = 1;

/** JSON-RPC 2.0 error codes, plus ACP's authentication-required. */
export const E = { parse: -32700, request: -32600, method: -32601, params: -32602, internal: -32603, auth: -32000, cancelled: -32800 } as const;

export class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

type Json = Record<string, unknown>;
type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';
export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

export interface AcpOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /** Diagnostics (stderr). */
  log?: (text: string) => void;
  /** The model for sessions that do not choose one (the saved default, or the starter). */
  defaultModel?: string;
  /** The worker for a model id. */
  providerFor: (model: string) => ModelProvider;
  guidance?: Guidance;
  maxUsd?: number;
  hasKey: () => boolean;
  /** Approve every change and command without asking. For an agent nobody is watching. */
  autoApprove?: boolean;
  /** Shell commands starting with one of these words are approved without asking, if they are simple. */
  allowShell?: string[];
  /** The web tools (default on) and whether they may reach local and private addresses (default off). */
  web?: boolean;
  webLocal?: boolean;
}

interface Turn {
  abort: AbortController;
  cancelled: boolean;
  streamed: boolean;
  /** Permission questions waiting on the editor; answered "no" if the turn is cancelled. */
  waiting: Set<(a: Answer) => void>;
}

interface AcpSession {
  id: string;
  cwd: string;
  session: Session;
  mcp: McpConnection[];
  turn?: Turn;
}

const KINDS: Record<string, ToolKind> = { read_file: 'read', list_dir: 'read', glob: 'search', search: 'search', web_search: 'search', web_fetch: 'fetch', write_file: 'edit', edit_file: 'edit', run_command: 'execute' };
export const kindOf = (tool: string): ToolKind => KINDS[tool] ?? 'other';

/**
 * True for a shell command that does one thing: no chaining (; & |), redirects (< >), substitution
 * ($ ` ( )), globs or newlines outside quotes — and none of the expanding kinds inside double quotes.
 * Inside single quotes everything is literal, which is how a JSON argument is passed safely.
 */
export function simpleCommand(cmd: string): boolean {
  let quote = '';
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (quote === "'") {
      if (c === "'") quote = '';
    } else if (quote === '"') {
      if (c === '"') quote = '';
      else if (c === '\\') i++;
      else if (c === '$' || c === '`') return false;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === '\\') i++;
    else if (';&|<>`$(){}*?~!\n'.includes(c)) return false;
  }
  return quote === '';
}

/** Whether `command` starts with one of the allowed words and is simple. */
export function shellAllowed(command: unknown, allow: string[] = []): boolean {
  const cmd = String(command ?? '').trim();
  return allow.some(w => cmd === w || cmd.startsWith(`${w} `)) && simpleCommand(cmd);
}

const FILE_TOOLS = new Set(['read_file', 'list_dir', 'glob', 'search', 'write_file', 'edit_file']);

/** A prompt's content blocks as the text the agent reads. */
export function promptText(blocks: unknown): string {
  if (!Array.isArray(blocks)) throw new RpcError(E.params, '`prompt` must be an array of content blocks');
  return blocks
    .map((b: Json) => {
      switch (b.type) {
        case 'text':
          return String(b.text ?? '');
        case 'resource_link':
          return `[${String(b.name ?? b.uri)}](${String(b.uri)})`;
        case 'resource': {
          const r = (b.resource ?? {}) as Json;
          return typeof r.text === 'string' ? `<file uri="${String(r.uri)}">\n${r.text}\n</file>` : `[binary resource ${String(r.uri)}]`;
        }
        case 'image':
        case 'audio':
          return `[${String(b.type)} omitted: agento reads text only]`;
        default:
          return '';
      }
    })
    .filter(Boolean)
    .join('\n\n');
}

/** How a finished turn ends, in ACP's words. */
export function stopReason(status: string, cancelled: boolean): StopReason {
  if (cancelled) return 'cancelled';
  // Out of steps, tool calls or dollars: the turn was cut short by a limit.
  if (status === 'limit') return 'max_turn_requests';
  return 'end_turn';
}

const version = (): string => {
  try {
    return (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
};

export async function serveAcp(o: AcpOptions): Promise<void> {
  const log = o.log ?? (() => {});
  const sessions = new Map<string, AcpSession>();
  const inflight = new Map<number | string, () => void>(); // request id → cancel
  const waiting = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let nextId = 1;

  // ── the wire ──
  const write = (msg: Json) => void o.output.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  const reply = (id: number | string | null, result: unknown) => write({ id, result });
  const fail = (id: number | string | null, code: number, message: string) => write({ id, error: { code, message } });
  const notify = (method: string, params: Json) => write({ method, params });
  const update = (sessionId: string, u: Json) => notify('session/update', { sessionId, update: u });
  const ask = <T>(method: string, params: Json): Promise<T> =>
    new Promise((resolveReq, rejectReq) => {
      const id = nextId++;
      waiting.set(id, { resolve: resolveReq as (v: unknown) => void, reject: rejectReq });
      write({ id, method, params });
    });

  const modelOf = (s: AcpSession) => s.session.model ?? o.defaultModel ?? STARTER;

  /** The model selector the editor shows: agento's curated list, plus the current one if it is not on it. */
  const configOptions = (s: AcpSession): Json[] => {
    const current = modelOf(s);
    const options = CURATED.map(m => ({ value: m.id, name: m.label, description: `${m.maker} · ${m.note}` }));
    if (!options.some(m => m.value === current)) options.unshift({ value: current, name: labelOf(current), description: 'Selected outside the list' });
    return [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: current, options }];
  };

  /** The model's context window from the provider's card, or a safe 128k when it cannot say. */
  const sizes = new Map<string, number>();
  const contextSize = async (model: string): Promise<number> => {
    if (sizes.has(model)) return sizes.get(model)!;
    let size = 128_000;
    try {
      const card = await Promise.race([o.providerFor(model).card?.(model), new Promise<undefined>(r => setTimeout(() => r(undefined), 3000))]);
      if (card?.context) size = card.context;
    } catch {
      /* no card: the default stands */
    }
    sizes.set(model, size);
    return size;
  };

  // ── events → session/update ──
  const onEvent = (s: AcpSession) => (e: import('../index.ts').AgentEvent) => {
    const turn = s.turn;
    if (!turn) return;
    if (e.type === 'delta') {
      turn.streamed = true;
      update(s.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: e.text } });
    } else if (e.type === 'tool_call') {
      const path = typeof e.args.path === 'string' && FILE_TOOLS.has(e.name) ? resolve(s.cwd, e.args.path) : null;
      update(s.id, {
        sessionUpdate: 'tool_call',
        toolCallId: e.id,
        name: e.name,
        title: describeCall(e.name, e.args),
        kind: kindOf(e.name),
        status: 'pending',
        rawInput: e.args,
        content: [],
        locations: path ? [{ path }] : [],
      });
    } else if (e.type === 'approval_result' && e.approved) {
      update(s.id, { sessionUpdate: 'tool_call_update', toolCallId: e.id, status: 'in_progress' });
    } else if (e.type === 'tool_result') {
      update(s.id, {
        sessionUpdate: 'tool_call_update',
        toolCallId: e.id,
        status: e.ok ? 'completed' : 'failed',
        content: [{ type: 'content', content: { type: 'text', text: e.result.length > 4000 ? `${e.result.slice(0, 4000)}…` : e.result } }],
      });
    }
  };

  // ── the editor decides about a change ──
  const permission = (s: AcpSession) => async (req: ApprovalRequest): Promise<Answer> => {
    const turn = s.turn;
    if (!turn || turn.cancelled) return 'no';
    if (o.autoApprove || (req.tool === 'run_command' && shellAllowed(req.args.command, o.allowShell))) return 'yes';
    const asked = ask<{ outcome?: { outcome?: string; optionId?: string } }>('session/request_permission', {
      sessionId: s.id,
      toolCall: { toolCallId: req.id, title: req.summary, kind: kindOf(req.tool), status: 'pending', rawInput: req.args },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'always', name: `Always allow ${req.tool}`, kind: 'allow_always' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    }).then(
      r => (r?.outcome?.outcome === 'selected' ? (r.outcome.optionId === 'always' ? 'always' : r.outcome.optionId === 'allow' ? 'yes' : 'no') : 'no') as Answer,
      () => 'no' as Answer
    );
    // A cancelled turn answers its own question: "no".
    const cancel = new Promise<Answer>(r => turn.waiting.add(r));
    return Promise.race([asked, cancel]);
  };

  // ── methods ──
  const methods: Record<string, (params: Json, id: number | string) => Promise<unknown> | unknown> = {
    async initialize() {
      const remote = await mcpAvailable();
      return {
        // We speak version 1 only: the same if it was asked for, the latest we have otherwise.
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: false, audio: false, embeddedContext: true },
          // stdio servers are always accepted; remote ones need ensemble's client (an optional peer).
          mcpCapabilities: { http: remote, sse: remote },
        },
        agentInfo: { name: 'agento', title: 'agento', version: version() },
        // With the key in the environment there is nothing to authenticate: no step, no prompt. Without it,
        // say how, and session/new fails fast with the same words.
        authMethods: o.hasKey()
          ? []
          : [
              {
                id: 'openrouter-key',
                name: 'OpenRouter API key',
                description: 'agento reads OPENROUTER_API_KEY from its environment. Set it where the host launches the agent (in Zed: the agent server\'s `env`).',
              },
            ],
      };
    },

    authenticate(p) {
      if (p.methodId !== 'openrouter-key') throw new RpcError(E.params, `Unknown authentication method "${String(p.methodId)}"`);
      if (!o.hasKey()) throw new RpcError(E.auth, 'OPENROUTER_API_KEY is not set in the agent\'s environment.');
      return {};
    },

    async 'session/new'(p) {
      if (!o.hasKey()) throw new RpcError(E.auth, 'Authentication required: set OPENROUTER_API_KEY in the agent\'s environment, then retry.');
      const cwd = String(p.cwd ?? '');
      if (!isAbsolute(cwd)) throw new RpcError(E.params, '`cwd` must be an absolute path');
      const model = o.defaultModel ?? STARTER;
      const id = `sess_${randomBytes(8).toString('hex')}`;
      const mcp = await connectSpecs(fromAcpMcp(p.mcpServers as AcpMcpServer[]), text => log(`${text}\n`)).catch(() => [] as McpConnection[]);
      for (const m of mcp) if (!m.ok) log(`mcp ${m.name}: ${m.error}\n`);
      const toolsets: Toolset[] = [
        ...standardToolsets({ root: cwd, web: o.web !== false, webOptions: { allowPrivate: !!o.webLocal } }),
        ...mcp.flatMap(m => (m.toolset ? [m.toolset] : [])),
      ];
      const strategy = loadStrategy(model);
      const entry: AcpSession = { id, cwd, mcp, session: undefined as unknown as Session };
      entry.session = createSession({
        provider: o.providerFor(model),
        model,
        root: cwd,
        toolsets,
        skills: dirSkills(join(cwd, '.claude', 'skills'), join(homedir(), '.claude', 'skills')),
        guidance: strategy ? strategy.guidance : (o.guidance ?? 'auto'),
        strategy: strategy ?? undefined,
        maxUsd: o.maxUsd ?? 0.5,
        ask: permission(entry),
        onEvent: onEvent(entry),
        logPath: join(home(), 'sessions', `${new Date().toISOString().replace(/[:.]/g, '-')}-acp.jsonl`),
        profilesPath: join(home(), 'profiles.json'),
      });
      sessions.set(id, entry);
      return { sessionId: id, configOptions: configOptions(entry) };
    },

    'session/set_config_option'(p) {
      const s = sessions.get(String(p.sessionId));
      if (!s) throw new RpcError(E.params, `Unknown session "${String(p.sessionId)}"`);
      if (p.configId !== 'model') throw new RpcError(E.params, `Unknown config option "${String(p.configId)}"`);
      if (typeof p.value !== 'string' || !p.value) throw new RpcError(E.params, '`value` must be a model id');
      s.session.model = p.value;
      return { configOptions: configOptions(s) };
    },

    async 'session/prompt'(p, requestId) {
      const s = sessions.get(String(p.sessionId));
      if (!s) throw new RpcError(E.params, `Unknown session "${String(p.sessionId)}"`);
      if (s.turn) throw new RpcError(E.request, 'A prompt is already running in this session');
      const text = promptText(p.prompt);
      const turn: Turn = { abort: new AbortController(), cancelled: false, streamed: false, waiting: new Set() };
      s.turn = turn;
      const cancelTurn = () => {
        turn.cancelled = true;
        turn.abort.abort();
        for (const w of turn.waiting) w('no');
      };
      inflight.set(requestId, cancelTurn);
      try {
        const result = await s.session.send(text, turn.abort.signal);
        const stop = stopReason(result.status, turn.cancelled);
        // What the turn cost (a host with a budget, like an ensemble graph, reads this) and a rough
        // size of the conversation: ~4 characters a token, against the model's context window.
        const used = Math.ceil(result.messages.reduce((n, m) => n + String(m.content ?? '').length, 0) / 4);
        const size = await contextSize(modelOf(s));
        update(s.id, { sessionUpdate: 'usage_update', used, size: Math.max(size, used), cost: { amount: s.session.total, currency: 'USD' } });
        // Words the model never streamed (an empty-reply give-up) or why a limit ended the turn.
        const notice = !turn.streamed && result.answer ? result.answer : result.status === 'limit' && result.reason ? `\n\n_(stopped: ${result.reason})_` : '';
        if (notice && stop !== 'cancelled') update(s.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: notice } });
        return { stopReason: stop };
      } catch (error) {
        if (turn.cancelled || turn.abort.signal.aborted) return { stopReason: 'cancelled' satisfies StopReason };
        throw new RpcError(E.internal, error instanceof Error ? error.message : String(error));
      } finally {
        inflight.delete(requestId);
        s.turn = undefined;
      }
    },
  };

  const notifications: Record<string, (params: Json) => void> = {
    'session/cancel'(p) {
      const turn = sessions.get(String(p.sessionId))?.turn;
      if (!turn) return;
      turn.cancelled = true;
      turn.abort.abort();
      for (const w of turn.waiting) w('no');
    },
    '$/cancel_request'(p) {
      inflight.get(p.requestId as number | string)?.();
    },
  };

  // ── dispatch ──
  const handle = async (line: string): Promise<void> => {
    let msg: Json;
    try {
      msg = JSON.parse(line) as Json;
    } catch {
      return fail(null, E.parse, 'Parse error');
    }
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return fail(null, E.request, 'Invalid request');
    const id = msg.id as number | string | undefined;

    // A response to something we asked (a permission request).
    if (typeof msg.method !== 'string') {
      if (id === undefined || id === null) return fail(null, E.request, 'Invalid request');
      const w = waiting.get(id);
      if (!w) return;
      waiting.delete(id);
      if (msg.error) w.reject(new Error(String((msg.error as Json).message ?? 'error')));
      else w.resolve(msg.result);
      return;
    }

    const params = (msg.params ?? {}) as Json;
    if (id === undefined) {
      // A notification: no reply, ever. Unknown ones (and extensions, `_…`) are ignored.
      notifications[msg.method]?.(params);
      return;
    }
    const run = methods[msg.method];
    if (!run) return fail(id, E.method, `Method not found: ${msg.method}`);
    try {
      reply(id, await run(params, id));
    } catch (error) {
      if (error instanceof RpcError) fail(id, error.code, error.message);
      else fail(id, E.internal, error instanceof Error ? error.message : String(error));
    }
  };

  const lines = createInterface({ input: o.input, crlfDelay: Infinity });
  const running = new Set<Promise<void>>();
  lines.on('line', line => {
    if (!line.trim()) return;
    // Concurrently: a cancel must be heard while a prompt is still running.
    const p = handle(line).catch(error => log(`error: ${error instanceof Error ? error.stack : String(error)}\n`));
    running.add(p);
    void p.finally(() => running.delete(p));
  });
  await new Promise<void>(done => lines.once('close', done));

  // The editor closed the pipe: stop any turn still running and let the MCP connections go.
  for (const s of sessions.values()) {
    s.turn?.abort.abort();
    for (const m of s.mcp) m.session?.close();
  }
  await Promise.allSettled([...running]);
}
