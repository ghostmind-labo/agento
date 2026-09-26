/**
 * Budgets — every run is bounded, and says which bound it hit.
 *
 * Steps, tool calls and nudges came from Potion's Talk, each tuned against a failure seen in its
 * evaluation. The USD cap is new: Talk had none, though it already summed what each call cost —
 * OpenRouter bills `usage.cost` per call, worker and Jev alike, so a cap is a comparison, not an
 * estimate. A run that hits it ends with status 'limit' and a reason naming the figure, never a
 * silent truncation.
 */

export interface Budget {
  /** Worker turns. Default 8. The last one always answers, with tools shown but not callable. */
  maxSteps?: number;
  /** Tool calls across the run. Default 12. Once spent, the next step answers with what it has. */
  maxToolCalls?: number;
  /** How many times a stopCheck may send the model back. Default 2. */
  maxNudges?: number;
  /** USD across the run (worker, decisions, and whatever tools report through `spend`). Default: none. */
  maxUsd?: number;
  /** Extra steps granted by guide tools (reading a skill is preparation, not work). Default 4. */
  guideSteps?: number;
  /** Every this many reads, a tool result carries a "you may have enough — answer" note. Default 4. */
  readNudgeAt?: number;
  /** A tool result longer than this is truncated before the model sees it. Default 12,000 chars. */
  resultCap?: number;
}

export const DEFAULT_BUDGET = {
  maxSteps: 8,
  maxToolCalls: 12,
  maxNudges: 2,
  maxUsd: Infinity,
  guideSteps: 4,
  readNudgeAt: 4,
  resultCap: 12_000,
} satisfies Required<Budget>;

export type Limits = Required<Budget>;

export function limits(budget: Budget = {}): Limits {
  const out = { ...DEFAULT_BUDGET };
  for (const [k, v] of Object.entries(budget) as [keyof Budget, number | undefined][]) if (v !== undefined) out[k] = v;
  return out;
}

/** Money is compared in whole micro-dollars so float sums never stop a run a hair early or late. */
const micro = (usd: number) => Math.round(usd * 1e6);

/** The reason a run must stop for money, or null while there is budget left. */
export function overBudget(spent: number, maxUsd: number): string | null {
  if (!Number.isFinite(maxUsd) || micro(spent) < micro(maxUsd)) return null;
  return `Budget reached: spent $${spent.toFixed(6)} of the $${maxUsd.toFixed(6)} cap.`;
}
