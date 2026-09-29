/**
 * A strategy: everything the harness can change about how it drives one model — the lines added
 * to its instructions, how closely Jev guides it, and its limits. Not the model's weights: the
 * system AROUND the model.
 *
 * Training keeps one champion per model, in `~/.agento/strategies/<model>.json`. agento uses it
 * whenever it runs that model, so what training learns is what you get.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Guidance } from '../../index.ts';
import { home } from '../config.ts';

export interface Strategy {
  model: string;
  /** Extra instructions, learned from failures. Short, general, at most MAX_RULES. */
  rules: string[];
  guidance: Guidance;
  maxSteps: number;
  maxToolCalls: number;
  readNudgeAt: number;
  /** The challenge level (1–5) this model trains at; it rises as the model masters one. */
  level?: number;
  /** The champion's last score (0–1) and the rounds it has survived. */
  score?: number;
  rounds?: number;
  updated?: string;
}

export const MAX_RULES = 8;

export const baseline = (model: string): Strategy => ({ model, rules: [], guidance: 'auto', maxSteps: 10, maxToolCalls: 16, readNudgeAt: 4 });

const file = (model: string) => join(home(), 'strategies', `${model.replace(/[^\w.-]+/g, '_')}.json`);

export function loadStrategy(model: string): Strategy | null {
  try {
    return existsSync(file(model)) ? ({ ...baseline(model), ...(JSON.parse(readFileSync(file(model), 'utf8')) as Partial<Strategy>), model } as Strategy) : null;
  } catch {
    return null;
  }
}

export function saveStrategy(s: Strategy): void {
  mkdirSync(join(home(), 'strategies'), { recursive: true });
  writeFileSync(`${file(s.model)}.tmp`, `${JSON.stringify(s, null, 2)}\n`);
  renameSync(`${file(s.model)}.tmp`, file(s.model));
}

/** What differs between two strategies, in a few words (for the history and the report). */
export function describeChange(from: Strategy, to: Strategy): string {
  const out: string[] = [];
  for (const r of to.rules) if (!from.rules.includes(r)) out.push(`+ rule "${r}"`);
  for (const r of from.rules) if (!to.rules.includes(r)) out.push(`− rule "${r}"`);
  if (from.guidance !== to.guidance) out.push(`guidance ${String(from.guidance)} → ${String(to.guidance)}`);
  if (from.maxSteps !== to.maxSteps) out.push(`maxSteps ${from.maxSteps} → ${to.maxSteps}`);
  if (from.maxToolCalls !== to.maxToolCalls) out.push(`maxToolCalls ${from.maxToolCalls} → ${to.maxToolCalls}`);
  if (from.readNudgeAt !== to.readNudgeAt) out.push(`readNudgeAt ${from.readNudgeAt} → ${to.readNudgeAt}`);
  return out.join('; ') || 'no change';
}
