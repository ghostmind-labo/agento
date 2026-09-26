/**
 * Two ways for the worker to ask for help mid-task.
 *
 *   ask_jev   — Jev, the decision model: a yes/no (probability), a pick from options (with every
 *               option's probability), or a score on a scale. Fast, calibrated, a fraction of a
 *               cent. Meant to be offered at EVERY step (`alwaysTools`): whenever an answer is a
 *               judgement, not prose — which existing option fits, is this a duplicate, how relevant.
 *   ask_model — another model, consulted in plain text with no tools. Only from an allowlist the app
 *               gives, because which models a person may spend on is the app's decision.
 *
 * What each costs is reported through the tool context's `spend`, so it counts toward the run's
 * total and its USD cap.
 */
import type { ModelProvider, Question } from './model.ts';
import { forgivingArgs, type AgentTool } from './tools.ts';

export function askJevTool(model: ModelProvider): AgentTool {
  if (!model.decide) throw new Error('ask_jev needs a ModelProvider with decide().');
  const decide = model.decide.bind(model);
  return {
    name: 'ask_jev',
    description:
      'Ask Jev, a fast decision model, one typed question about some state and get probabilities back (no prose). kind "yes_no": the probability of yes. kind "choice": pick one of `options` (an array of labels, or { label: description }), with every option\'s probability — use it to match a phrase to what EXISTS instead of guessing. kind "score": a position on `options` read as ordered levels, low to high. Use it freely whenever the answer is a judgement.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question, referring to fields of `state` in backticks, e.g. "Which of `options` fits `item.title`?"' },
        state: { description: 'What Jev judges: text or an object' },
        kind: { type: 'string', enum: ['yes_no', 'choice', 'score'] },
        options: { description: 'For choice / score: labels (array) or { label: description }' },
      },
      required: ['question', 'state', 'kind'],
    },
    run: async (args, ctx) => {
      // Models often send `options` and `state` as JSON text; read them as what they mean.
      const a = forgivingArgs(args);
      const kind = String(a.kind);
      const raw = a.options;
      const labels: Record<string, string | null> = Array.isArray(raw)
        ? Object.fromEntries((raw as unknown[]).map(o => [String(o), null]))
        : raw && typeof raw === 'object'
          ? Object.fromEntries(Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, v == null ? null : String(v)]))
          : {};
      let q: Question;
      if (kind === 'yes_no') q = { type: 'noul', instructions: String(a.question) };
      else if (kind === 'choice') {
        if (Object.keys(labels).length < 2) throw new Error('A choice needs at least two options');
        q = { type: 'choice', instructions: String(a.question), criteria: labels };
      } else if (kind === 'score') {
        const levels = Object.entries(labels).map(([k, v]) => (v ? `${k}: ${v}` : k));
        if (levels.length < 2) throw new Error('A score needs at least two ordered levels in `options`');
        q = { type: 'score', instructions: String(a.question), criteria: levels.slice(0, 10) };
      } else throw new Error('kind must be yes_no, choice or score');
      const { answers, cost } = await decide(a.state ?? '', { q }, ctx.signal);
      ctx.spend(cost);
      const ans = answers.q;
      if (ans.type === 'noul') return { yes: Number(ans.noul.toFixed(3)) };
      if (ans.type === 'choice') return { choice: ans.choice, confidence: Number(ans.confidence.toFixed(3)), probabilities: ans.probabilities };
      return { score: Number(ans.score.toFixed(3)), confidence: Number(ans.confidence.toFixed(3)), levels: ans.legend, probabilities: ans.probabilities };
    },
  };
}

export interface AskModelOptions {
  /** The models that may be consulted: id → label. */
  models: Record<string, string>;
  /** The consulted model's system line. */
  system?: string;
  maxTokens?: number;
}

export function askModelTool(model: ModelProvider, options: AskModelOptions): AgentTool {
  const ids = Object.keys(options.models);
  return {
    name: 'ask_model',
    description: `Send one self-contained prompt to another model and get its text answer (it has no tools and sees nothing else). Only when the person asked for that model. Models: ${ids.map(id => `${id} (${options.models[id]})`).join(', ')}.`,
    parameters: { type: 'object', properties: { model: { type: 'string', enum: ids }, prompt: { type: 'string' } }, required: ['model', 'prompt'] },
    run: async (a, ctx) => {
      const id = String(a.model ?? '');
      if (!ids.includes(id)) throw new Error(`"${id}" is not offered. Models: ${ids.join(', ')}`);
      const reply = await model.chat({
        model: id,
        maxTokens: options.maxTokens ?? 2000,
        signal: ctx.signal,
        messages: [
          { role: 'system', content: options.system ?? "You are consulted by another agent on a person's behalf. Answer the prompt directly and concisely." },
          { role: 'user', content: String(a.prompt ?? '') },
        ],
      });
      ctx.spend(reply.cost);
      return { model: id, answer: reply.message.content ?? '' };
    },
  };
}
