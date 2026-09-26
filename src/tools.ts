/**
 * Tools — what an app hands the engine, and the helpers every app ended up writing.
 *
 * A tool is a spec the model reads plus a `run`. A tool that CHANGES something says so with
 * `write.describe`: the loop then never runs it on the model's say-so, it asks the app's `approve`
 * first with that one-line account of the change. That split lives on the tool, not in the loop,
 * because only the tool knows whether THIS call writes (an action tool may read or write depending
 * on its arguments).
 *
 * `foldTools` exists because a few general tools beat many narrow ones (Pi's lesson, confirmed in
 * Potion's evaluation): a router that offered only some tools per step was the main cause of
 * "I have no tool for that". Folding keeps every action visible in ONE tool's description while
 * each still runs, and asks approval, exactly as before.
 *
 * Arguments are read forgivingly (`forgivingArgs`, `readCall`): models send JSON as a string, put
 * arguments beside `action` instead of inside `args`, or (GLM) pack them into the action name. Each
 * of those used to cost a failed step; each is a harmless encoding slip, so it is read as meant.
 */
import type { ToolSpec } from './model.ts';

export interface ToolContext {
  signal: AbortSignal;
  /** Add USD this tool spent (a model it consulted, a sub-agent) to the run's total and budget. */
  spend(usd: number): void;
  /** The model's id for this call. */
  callId: string;
}

export interface AgentTool extends ToolSpec {
  /** Whatever it returns is handed to the model as text (objects as JSON). A throw is reported to the model, not to the caller. */
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
  /** A change: its approval sentence (may need a lookup). Null = this particular call only reads. */
  write?: { describe(args: Record<string, unknown>): string | null | Promise<string | null> };
}

/** A group of tools: one MCP server, one area of an app, one page's buttons. */
export interface Toolset {
  /** A short stable key: "notes", "github-mcp". */
  name: string;
  /** What it is for. */
  description: string;
  tools: AgentTool[];
}

export interface ApprovalRequest {
  id: string;
  tool: string;
  summary: string;
  args: Record<string, unknown>;
}

/**
 * JSON with keys sorted at every level: the same call written in another key order is the same
 * call. Not JSON.stringify(v, keys): an array replacer is an allowlist applied at EVERY depth, so
 * it emptied nested arguments — every call looked like a repeat of the first, and the repeat guard
 * locked the model out after one miss.
 */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter(k => o[k] !== undefined)
      .map(k => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** Parse arguments a model sent as JSON strings; leave everything else as it is. */
export function forgivingArgs(args: unknown): Record<string, unknown> {
  const raw = typeof args === 'string' ? safeParse(args) : args;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && /^\s*[[{]/.test(v)) {
      const parsed = safeParse(v);
      out[k] = parsed !== undefined && typeof parsed === 'object' ? parsed : v;
    } else out[k] = v;
  }
  return out;
}

/** The action and its arguments of a folded call, however the model sent them. */
export function readCall(a: Record<string, unknown>): { name: string; args: Record<string, unknown> } {
  let name = String(a.action ?? '').trim();
  const packed: Record<string, unknown> = {};
  if (name.includes('<arg_key>')) {
    for (const m of name.matchAll(/<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)(?:<\/arg_value>|$)/g)) {
      const value = (m[2] ?? '').trim();
      const parsed = /^[[{"]|^-?\d|^(true|false|null)$/.test(value) ? safeParse(value) : undefined;
      packed[(m[1] ?? '').trim()] = parsed !== undefined ? parsed : value;
    }
    name = name.slice(0, name.indexOf('<')).trim();
  }
  const { action: _action, args: nested, ...beside } = a;
  const fromPacked = packed.args && typeof packed.args === 'object' ? (packed.args as Record<string, unknown>) : {};
  const { args: _packedArgs, ...packedRest } = packed;
  return { name, args: forgivingArgs({ ...beside, ...fromPacked, ...packedRest, ...forgivingArgs(nested) }) };
}

/** A compact argument signature from a JSON Schema: { query, limit? }. */
function signature(tool: AgentTool): string {
  const p = tool.parameters as { properties?: Record<string, unknown>; required?: string[] };
  if (!p?.properties || !Object.keys(p.properties).length) return '{}';
  const req = new Set(p.required ?? []);
  return `{ ${Object.keys(p.properties)
    .map(k => (req.has(k) ? k : `${k}?`))
    .join(', ')} }`;
}

/** The first sentence of a description. */
function gist(tool: AgentTool): string {
  const d = tool.description.trim();
  const first = d.split(/(?<=\.)\s/)[0] ?? d;
  return first.length > 140 ? `${first.slice(0, 140)}…` : first;
}

export interface FoldOptions {
  /** The folded tool's name, e.g. the app's name. */
  name: string;
  /** The first line of its description: what it reaches. */
  description: string;
  /** Appended after the action reference: query grammars, argument shapes a model guesses wrong. */
  appendix?: string;
}

/**
 * Fold toolsets into ONE tool called as { action, args }. Its description is a compact reference of
 * every action. Reads run directly; an action with `write` still asks approval (the folded tool's
 * `write.describe` delegates, and says null for a read).
 */
export function foldTools(toolsets: Toolset[], options: FoldOptions): AgentTool {
  const byName = new Map(toolsets.flatMap(s => s.tools).map(t => [t.name, t] as const));
  const names = [...byName.keys()];
  const reference = toolsets
    .map(s => `${s.name.replace(/_/g, ' ')}:\n${s.tools.map(t => `  ${t.name} ${signature(t)}${t.write ? ' [asks approval]' : ''} — ${gist(t)}`).join('\n')}`)
    .join('\n');
  return {
    name: options.name,
    description: [`${options.description} Call as { action, args }. Actions marked [asks approval] run only once the person approves.`, reference, options.appendix]
      .filter(Boolean)
      .join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: names },
        args: { type: 'object', description: "The action's arguments, as listed", additionalProperties: true },
      },
      required: ['action'],
    },
    write: {
      describe: a => {
        const call = readCall(a);
        const t = byName.get(call.name);
        return t?.write ? t.write.describe(call.args) : null;
      },
    },
    run: async (a, ctx) => {
      const call = readCall(a);
      const t = byName.get(call.name);
      if (!t) throw new Error(`There is no action "${call.name}". Actions: ${names.join(', ')}`);
      return t.run(call.args, ctx);
    },
  };
}

// ── MCP ─────────────────────────────────────────────────────────────────────

/**
 * The shape of an MCP connection this engine can use. Structural on purpose: ensemble's
 * `connect()` session satisfies it as-is, and any other client can with a three-line adapter.
 * The engine speaks no MCP wire protocol itself — connecting (stdio, HTTP, OAuth) is the app's job.
 */
export interface McpLike {
  name: string;
  listTools(options?: { signal?: AbortSignal }): Promise<{ name: string; description?: string; inputSchema?: Record<string, unknown> }[]>;
  call(tool: string, args: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<{ text: string; data?: unknown; isError: boolean }>;
}

export interface McpToolsetOptions {
  /** Default: the session's name. */
  name?: string;
  description?: string;
  /** Only these tools (by name). */
  only?: string[];
  /**
   * Which calls CHANGE something, and the sentence the person approves. MCP servers do not say
   * reliably (annotations are hints), so the app decides. Default: every call is a read.
   */
  writes?: (tool: string, args: Record<string, unknown>) => string | null | Promise<string | null>;
  signal?: AbortSignal;
}

/** One MCP server's tools as a Toolset. */
export async function mcpToolset(session: McpLike, options: McpToolsetOptions = {}): Promise<Toolset> {
  const listed = await session.listTools({ signal: options.signal });
  const tools = listed
    .filter(t => !options.only || options.only.includes(t.name))
    .map<AgentTool>(t => ({
      name: t.name,
      description: t.description ?? t.name,
      parameters: t.inputSchema ?? { type: 'object', properties: {} },
      ...(options.writes ? { write: { describe: (args: Record<string, unknown>) => options.writes!(t.name, args) } } : {}),
      run: async (args, ctx) => {
        const out = await session.call(t.name, args, { signal: ctx.signal });
        if (out.isError) throw new Error(out.text || `${t.name} failed`);
        return out.data ?? out.text;
      },
    }));
  return { name: options.name ?? session.name, description: options.description ?? `Tools of the ${session.name} MCP server.`, tools };
}
