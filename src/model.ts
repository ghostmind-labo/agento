/**
 * The model seam — the only door between the engine and a model.
 *
 * The loop needs exactly two kinds of call, and they are different animals:
 *
 *   chat   — the WORKER. A generative model that writes, plans and calls tools. Expensive, slow,
 *            persuadable. Chat completions with tools, streamed or not.
 *   decide — Jev, a System One DECISION model. It never writes: it answers typed questions (noul =
 *            probability of yes, choice, score) about a state, in well under a second, for a
 *            fraction of a cent. Probabilities, not prose, so it cannot be talked into agreeing.
 *            Optional: an engine without it simply skips the decisions it would have made.
 *
 * `ModelProvider` is the seam. The loop depends on that interface, never on OpenRouter, so a stub
 * (see testing.ts), a cache or another vendor mounts without touching the engine.
 *
 * `openrouter()` is the one implementation shipped, and it is a thin `fetch` on purpose — the same
 * choice ensemble made: one key (OPENROUTER_API_KEY) and one bill for the worker AND Jev (reached
 * through OpenRouter's `/systemone` route, never a TYPESAFE_API_KEY), a billed `usage.cost` in USD
 * on every response (which is what makes a USD budget possible at all), and zero runtime
 * dependencies. No worker model id is written here: the app names its model, and `modelCatalog()`
 * reads OpenRouter's live list when a price or a capability matters.
 */

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1';
/** An alias OpenRouter resolves to its newest Jev release — the same default ensemble uses. */
export const DEFAULT_DECISION_MODEL = 'jev-latest';

// ── chat ────────────────────────────────────────────────────────────────────

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export type AssistantMessage = Extract<ChatMessage, { role: 'assistant' }>;

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the arguments object. */
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  /** Falls back to the provider's default model. */
  model?: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
  signal?: AbortSignal;
  /** Streams the reply: called with each piece of text as the model writes it. */
  onDelta?: (text: string) => void;
  /**
   * 'none': the tools stay visible (the model still knows what it did) but it may not call one —
   * how a turn is made to answer. Removing the tools instead makes some models write their own
   * tool-call markup as text.
   */
  toolChoice?: 'auto' | 'none';
  /** Ask for a JSON object as the reply (providers that support it). */
  json?: boolean;
}

export interface ChatReply {
  message: AssistantMessage;
  finishReason: string | null;
  /** The model that actually answered. */
  model: string;
  /** USD, as billed. */
  cost: number;
}

// ── decide (Jev) ────────────────────────────────────────────────────────────

type Rubric = string | Record<string, unknown> | unknown[];

export type Question =
  | { type: 'noul'; instructions: Rubric; criteria?: { true?: Rubric; false?: Rubric } }
  | { type: 'choice'; instructions: Rubric; criteria: Record<string, Rubric | null> }
  | { type: 'score'; instructions: Rubric; criteria: Rubric[] };

export type Answer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; probabilities: Record<string, number>; confidence: number; legend: Record<string, string> };

export interface DecideReply<K extends string> {
  answers: Record<K, Answer>;
  cost: number;
}

// ── the seam ────────────────────────────────────────────────────────────────

export interface ModelProvider {
  /** The worker `chat` uses when a request names none. */
  defaultModel?: string;
  chat(request: ChatRequest): Promise<ChatReply>;
  /**
   * Ask typed questions about one state; each is answered independently. Without it, the loop
   * skips its decisions (the opening node, skill picking) and `ask_jev` cannot be offered.
   */
  decide?<K extends string>(state: unknown, questions: Record<K, Question>, signal?: AbortSignal): Promise<DecideReply<K>>;
  /**
   * What is known about a worker model — price, context, tool support — or null. The guide reads it
   * to decide how closely Jev should watch that model. Without it, the guide starts at "normal".
   */
  card?(model: string, signal?: AbortSignal): Promise<ModelCard | null>;
}

export type ModelErrorCode = 'no_key' | 'no_model' | 'credits' | 'auth' | 'failed' | 'no_answer';

/** Every failure of a model call. `code` is what an app maps to its own message or HTTP status. */
export class ModelError extends Error {
  readonly code: ModelErrorCode;
  readonly status?: number;
  constructor(code: ModelErrorCode, message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'ModelError';
    this.code = code;
    this.status = options.status;
  }
}

// ── OpenRouter ──────────────────────────────────────────────────────────────

export interface OpenRouterConfig {
  /** Defaults to `process.env.OPENROUTER_API_KEY`. */
  apiKey?: string;
  /** Defaults to `process.env.OPENROUTER_BASE_URL`, then OpenRouter. */
  baseUrl?: string;
  /** The worker model used when a request names none. No default: the app chooses. */
  model?: string;
  /** Jev's model id. Default `jev-latest`. */
  decisionModel?: string;
  /** Extra headers, e.g. OpenRouter's `HTTP-Referer` / `X-Title` app attribution. */
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
}

interface StreamChunk {
  model?: string;
  choices?: {
    delta?: { content?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] };
    finish_reason?: string | null;
  }[];
  usage?: { cost?: number };
  error?: { message?: string };
}

async function refusal(res: Response): Promise<ModelError> {
  const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  const message = json?.error?.message ?? `OpenRouter answered ${res.status}`;
  if (res.status === 402) return new ModelError('credits', `The OpenRouter credits ran out. (${message})`, { status: 402 });
  if (res.status === 401 || res.status === 403) return new ModelError('auth', `OpenRouter refused the key. (${message})`, { status: res.status });
  return new ModelError('failed', `The model call failed: ${message}`, { status: res.status });
}

export function openrouter(config: OpenRouterConfig = {}): ModelProvider {
  const base = (config.baseUrl ?? process.env.OPENROUTER_BASE_URL ?? OPENROUTER_URL).replace(/\/+$/, '');
  const doFetch = config.fetch ?? globalThis.fetch;
  const decisionModel = config.decisionModel ?? DEFAULT_DECISION_MODEL;

  const headers = () => {
    const key = config.apiKey ?? process.env.OPENROUTER_API_KEY;
    if (!key) throw new ModelError('no_key', 'No OpenRouter key: set OPENROUTER_API_KEY or pass apiKey.');
    return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...config.headers };
  };

  const post = async <T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> => {
    const res = await doFetch(`${base}${path}`, { method: 'POST', headers: headers(), body: JSON.stringify(body), signal });
    if (!res.ok) throw await refusal(res);
    const json = (await res.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
    if (!json || json.error) throw new ModelError('failed', `The model call failed: ${json?.error?.message ?? 'no answer'}`);
    return json;
  };

  /** Reads server-sent events into one reply, handing each piece of text to onDelta. */
  const stream = async (body: Record<string, unknown>, onDelta: (text: string) => void, signal?: AbortSignal): Promise<ChatReply> => {
    const res = await doFetch(`${base}/chat/completions`, { method: 'POST', headers: headers(), body: JSON.stringify({ ...body, stream: true }), signal });
    if (!res.ok || !res.body) throw await refusal(res);

    let content = '';
    let model = String(body.model);
    let finishReason: string | null = null;
    let cost = 0;
    const calls: ToolCall[] = [];
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    let buffer = '';

    const take = (line: string) => {
      // ":" lines are OpenRouter's keep-alive comments.
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return;
      const chunk = JSON.parse(data) as StreamChunk;
      if (chunk.error) throw new ModelError('failed', `The model call failed: ${chunk.error.message ?? 'stream error'}`);
      if (chunk.model) model = chunk.model;
      if (chunk.usage?.cost !== undefined) cost = chunk.usage.cost;
      const choice = chunk.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const text = choice.delta?.content;
      if (text) {
        content += text;
        onDelta(text);
      }
      // Tool calls arrive in pieces, keyed by index: the id and name first, the arguments in parts.
      for (const part of choice.delta?.tool_calls ?? []) {
        const at = (calls[part.index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
        if (part.id) at.id = part.id;
        if (part.function?.name) at.function.name += part.function.name;
        if (part.function?.arguments) at.function.arguments += part.function.arguments;
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        take(line);
      }
    }
    if (buffer.trim()) take(buffer.trim());

    const toolCalls = calls.filter(Boolean);
    return { message: { role: 'assistant', content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finishReason, model, cost };
  };

  return {
    defaultModel: config.model,

    async card(model, signal) {
      const cards = await modelCatalog({ baseUrl: base, fetch: doFetch }, signal).catch(() => []);
      return cards.find(c => c.id === model) ?? null;
    },

    async chat({ model = config.model, messages, tools, maxTokens = 4096, signal, onDelta, toolChoice = 'auto', json: wantJson = false }) {
      if (!model) throw new ModelError('no_model', 'No model: pass `model` to openrouter() or to the request.');
      const body = {
        model,
        messages,
        max_tokens: maxTokens,
        ...(tools?.length
          ? { tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })), tool_choice: toolChoice }
          : {}),
        // Only providers that honour tools; a provider that silently drops them would stall the loop.
        provider: { require_parameters: true },
        usage: { include: true },
        ...(wantJson ? { response_format: { type: 'json_object' } } : {}),
      };
      if (onDelta) return stream(body, onDelta, signal);
      const json = await post<{
        model: string;
        choices: { message: { content: string | null; tool_calls?: ToolCall[] }; finish_reason: string | null }[];
        usage?: { cost?: number };
      }>('/chat/completions', body, signal);
      const choice = json.choices?.[0];
      if (!choice) throw new ModelError('no_answer', 'The model returned no answer');
      return {
        message: { role: 'assistant', content: choice.message.content ?? null, ...(choice.message.tool_calls?.length ? { tool_calls: choice.message.tool_calls } : {}) },
        finishReason: choice.finish_reason,
        model: json.model,
        cost: json.usage?.cost ?? 0,
      };
    },

    async decide(state, questions, signal) {
      const json = await post<{ answers: Record<string, Answer>; usage?: { cost?: number } }>('/systemone', { model: decisionModel, state, questions }, signal);
      for (const id of Object.keys(questions)) {
        // A missing answer must never read as a decision.
        if (!json.answers?.[id]) throw new ModelError('no_answer', `The decision model gave no answer for "${id}"`);
      }
      return { answers: json.answers as Record<keyof typeof questions & string, Answer>, cost: json.usage?.cost ?? 0 };
    },
  };
}

// ── the live catalogue ──────────────────────────────────────────────────────

export interface ModelCard {
  id: string;
  name: string;
  /** USD per input / output token. */
  prompt: number;
  completion: number;
  context: number;
  tools: boolean;
  vision: boolean;
}

const catalogs = new Map<string, Promise<ModelCard[]>>();

/**
 * OpenRouter's live model list (public, no key), cached per base url for the process. The one
 * place a price or a capability comes from — never a table in this package, which would go stale.
 */
export function modelCatalog(config: Pick<OpenRouterConfig, 'baseUrl' | 'fetch'> = {}, signal?: AbortSignal): Promise<ModelCard[]> {
  const base = (config.baseUrl ?? process.env.OPENROUTER_BASE_URL ?? OPENROUTER_URL).replace(/\/+$/, '');
  let cached = catalogs.get(base);
  if (!cached) {
    cached = (async () => {
      const res = await (config.fetch ?? globalThis.fetch)(`${base}/models`, { signal });
      if (!res.ok) throw await refusal(res);
      const json = (await res.json()) as {
        data?: { id: string; name?: string; context_length?: number; pricing?: { prompt?: string; completion?: string }; supported_parameters?: string[]; architecture?: { input_modalities?: string[] } }[];
      };
      return (json.data ?? []).map(m => ({
        id: m.id,
        name: m.name ?? m.id,
        prompt: Number(m.pricing?.prompt ?? 0),
        completion: Number(m.pricing?.completion ?? 0),
        context: m.context_length ?? 0,
        tools: (m.supported_parameters ?? []).includes('tools'),
        vision: (m.architecture?.input_modalities ?? []).includes('image'),
      }));
    })();
    catalogs.set(base, cached);
    cached.catch(() => catalogs.delete(base));
  }
  return cached;
}

export const forgetCatalog = (): void => catalogs.clear();
