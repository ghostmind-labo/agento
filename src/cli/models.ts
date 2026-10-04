/**
 * The handful of models agento offers — the one place in this package that names model ids.
 *
 * The engine (everything outside src/cli/) never names a model; an app chooses. agento is an app, and
 * like Potion's Talk it offers a short, curated list rather than the whole catalogue: models that call
 * tools and reason, each proven in an agent loop. The list mirrors the one Potion's Talk offers (as
 * checked 2026-09-23); prices come live from OpenRouter, and a model the catalogue no longer lists
 * (or that lost tools or reasoning) is dropped from the picker rather than offered broken.
 *
 * Anything else is still reachable: "Other model…" in the picker searches the full catalogue (tools +
 * reasoning only), and `--model <id>` takes any id.
 */
import type { ModelCard } from '../index.ts';

export interface Curated {
  id: string;
  label: string;
  maker: string;
  /** A few words on why you would pick it. */
  note: string;
}

export const CURATED: Curated[] = [
  { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5', maker: 'Anthropic', note: 'Balanced: strong and quick' },
  { id: 'anthropic/claude-opus-5.5', label: 'Claude Opus 5.5', maker: 'Anthropic', note: 'The most capable Claude' },
  { id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5', maker: 'Anthropic', note: 'Fast and inexpensive' },
  { id: 'openai/gpt-6-sol', label: 'GPT-6 Sol', maker: 'OpenAI', note: 'Strong generalist' },
  { id: 'openai/gpt-6-luna', label: 'GPT-6 Luna', maker: 'OpenAI', note: 'Very inexpensive' },
  { id: 'google/gemini-3.8-flash', label: 'Gemini 3.8 Flash', maker: 'Google', note: 'Fast, long context' },
  { id: 'x-ai/grok-4.7', label: 'Grok 4.7', maker: 'xAI', note: 'Strong generalist' },
  { id: 'deepseek/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', maker: 'DeepSeek', note: 'Open weights, very inexpensive' },
  { id: 'deepseek/deepseek-v4-pro-0813', label: 'DeepSeek V4 Pro', maker: 'DeepSeek', note: 'Open weights, strong' },
  { id: 'qwen/qwen3.8-max-0902', label: 'Qwen 3.8 Max', maker: 'Qwen', note: 'Strong, slower' },
  { id: 'qwen/qwen3.8-flash', label: 'Qwen 3.8 Flash', maker: 'Qwen', note: 'Very inexpensive' },
  { id: 'moonshotai/kimi-k3', label: 'Kimi K3', maker: 'Moonshot', note: 'Open weights, strong, slower' },
  { id: 'z-ai/glm-5.3', label: 'GLM 5.3', maker: 'Zhipu', note: 'Open weights, inexpensive' },
  { id: 'z-ai/glm-5.3-flash', label: 'GLM 5.3 Flash', maker: 'Zhipu', note: 'Open weights, very inexpensive' },
  { id: 'minimax/minimax-m3', label: 'MiniMax M3', maker: 'MiniMax', note: 'Open weights, inexpensive, slower' },
  { id: 'mistralai/mistral-medium-3-5', label: 'Mistral Medium 3.5', maker: 'Mistral', note: 'Strong generalist' },
];

/**
 * What an editor gets until the person picks a model (`agento model`, or the model selector the
 * editor shows): cheap, tested live in the gym, and on the list above.
 */
export const STARTER = 'qwen/qwen3.8-flash';

/** A model agento can drive: it calls tools and it reasons. */
export const capable = (m: ModelCard): boolean => m.tools && m.reasoning;

export interface Offered extends Curated {
  card: ModelCard;
}

/**
 * The curated list as offered now: in the live catalogue, still capable, in the list's order. With
 * no catalogue (offline), nothing can be priced or checked, so nothing is offered.
 */
export function offered(cards: ModelCard[]): Offered[] {
  const byId = new Map(cards.map(c => [c.id, c] as const));
  return CURATED.flatMap(m => {
    const card = byId.get(m.id);
    return card && capable(card) ? [{ ...m, card }] : [];
  });
}

export const labelOf = (id: string): string => CURATED.find(m => m.id === id)?.label ?? id;
