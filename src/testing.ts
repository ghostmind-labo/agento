/**
 * A scripted ModelProvider — the engine's own tests, and any app's, run offline on it.
 *
 * The worker replies from a script, in order; Jev answers through a function (or picks the first
 * option of every choice, which is "task" for the opening decision and "none" for skills). Every
 * request is recorded, so a test can assert what the model was shown. It spends nothing unless the
 * script says a step cost something — which is how a budget cap is tested without a key.
 */
import type { Answer, ChatReply, ChatRequest, ModelCard, ModelProvider, Question, ToolCall } from './model.ts';

export type ScriptStep =
  | string
  | { text?: string | null; calls?: { name: string; args?: Record<string, unknown> | string }[]; cost?: number }
  | ((request: ChatRequest) => ChatReply | Promise<ChatReply>);

export type ScriptedDecide = (state: unknown, questions: Record<string, Question>) => Record<string, Answer> | Promise<Record<string, Answer>>;

export interface ScriptedModel extends ModelProvider {
  /** Every chat request, in order (messages copied as they were at the time). */
  requests: ChatRequest[];
  /** Every decide call, in order. */
  decisions: { state: unknown; questions: Record<string, Question> }[];
}

/** Jev's default stub: the first option of every choice, 0.5 for yes/no, the first level of a score. */
export const firstOption: ScriptedDecide = (_state, questions) =>
  Object.fromEntries(
    Object.entries(questions).map(([id, q]) => {
      if (q.type === 'noul') return [id, { type: 'noul', noul: 0.5 }];
      if (q.type === 'choice') {
        const keys = Object.keys(q.criteria);
        const first = keys[0] ?? '';
        return [id, { type: 'choice', choice: first, confidence: 1, probabilities: Object.fromEntries(keys.map(k => [k, k === first ? 1 : 0])) }];
      }
      return [id, { type: 'score', score: 0, confidence: 1, probabilities: { '0': 1 }, legend: { '0': String(q.criteria[0] ?? '') } }];
    })
  );

let seq = 0;

export function scriptedModel(script: ScriptStep[], options: { decide?: ScriptedDecide | false; decideCost?: number; model?: string; /** What `card()` says of the worker (how the guide sizes it up). */ card?: Partial<ModelCard> } = {}): ScriptedModel {
  const queue = [...script];
  const requests: ChatRequest[] = [];
  const decisions: ScriptedModel['decisions'] = [];
  const provider: ScriptedModel = {
    defaultModel: options.model ?? 'stub/worker',
    requests,
    decisions,
    async chat(request) {
      request.signal?.throwIfAborted();
      requests.push({ ...request, messages: structuredClone(request.messages) });
      const step = queue.shift();
      if (step === undefined) throw new Error(`The script ran out after ${requests.length - 1} replies.`);
      if (typeof step === 'function') return step(request);
      const s = typeof step === 'string' ? { text: step } : step;
      const calls: ToolCall[] = (s.calls ?? []).map(c => ({
        id: `call_${++seq}`,
        type: 'function',
        function: { name: c.name, arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args ?? {}) },
      }));
      const text = s.text ?? null;
      if (text && request.onDelta) request.onDelta(text);
      return {
        message: { role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls } : {}) },
        finishReason: calls.length ? 'tool_calls' : 'stop',
        model: request.model ?? provider.defaultModel ?? 'stub/worker',
        cost: s.cost ?? 0,
      };
    },
  };
  if (options.card) {
    const card = options.card;
    provider.card = async model => ({ id: model, name: model, prompt: 0, completion: 0, context: 128_000, tools: true, reasoning: true, vision: false, ...card });
  }
  if (options.decide !== false) {
    const answer = options.decide ?? firstOption;
    provider.decide = async (state, questions, signal) => {
      signal?.throwIfAborted();
      decisions.push({ state: structuredClone(state), questions: structuredClone(questions) });
      return { answers: (await answer(state, questions)) as Record<keyof typeof questions & string, Answer>, cost: options.decideCost ?? 0 };
    };
  }
  return provider;
}
