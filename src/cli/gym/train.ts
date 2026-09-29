/**
 * Training: a cheap model, fresh challenges, and a harness that only keeps what makes it better.
 *
 * One round:
 *   1. generate challenges from the round's seed (new ones every round, so nothing is memorised);
 *   2. run the CHAMPION strategy on them, and one CANDIDATE — the champion with a single change;
 *   3. keep the candidate only if it CLEARLY did better on the same challenges: two or more more
 *      solved, or one more confirmed on a second fresh set (one challenge is within a cheap model's
 *      own randomness), or the same score for clearly less money. Otherwise the champion stays.
 *   4. move the level: up after a round the champion nearly aced, down after one it mostly failed,
 *      so the challenges stay just beyond what the model can already do.
 *
 * Where candidates come from — the model improving its own use:
 *   - a RULE: the same cheap model reads its own failures (task, what it did, what the grader said)
 *     and writes one short, general rule that would have prevented them;
 *   - a TWEAK: one limit or the guidance level, moved one notch;
 *   - a PRUNE: one learned rule removed (rules must keep earning their place).
 *
 * Everything is graded in code and capped in dollars: a round on a cheap model costs about a cent.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultPrompts, runAgent, type Guidance, type ModelProvider } from '../../index.ts';
import { home } from '../config.ts';
import { fileToolset } from '../files.ts';
import { cliSystem } from '../session.ts';
import { shellToolset } from '../shell.ts';
import { challenges, MAX_LEVEL, rng, type Challenge } from './challenges.ts';
import { baseline, describeChange, loadStrategy, MAX_RULES, saveStrategy, type Strategy } from './strategy.ts';

export interface Attempt {
  id: string;
  kind: string;
  goal: string;
  score: number;
  why: string;
  answer: string | null;
  calls: string[];
  cost: number;
  steps: number;
  status: string;
}

export interface Evaluation {
  score: number;
  cost: number;
  steps: number;
  attempts: Attempt[];
  /** True when the budget ran out before every challenge was tried. */
  cut: boolean;
}

/** Run one strategy on a set of challenges, each in its own throwaway folder. */
export async function evaluate(
  provider: ModelProvider,
  strategy: Strategy,
  set: Challenge[],
  options: { budget: () => number; perChallengeUsd: number; signal?: AbortSignal }
): Promise<Evaluation> {
  const attempts: Attempt[] = [];
  let cut = false;
  for (const ch of set) {
    if (options.budget() <= 0 || options.signal?.aborted) {
      cut = true;
      break;
    }
    const dir = mkdtempSync(join(tmpdir(), 'agento-gym-'));
    try {
      ch.setup(dir);
      const calls: string[] = [];
      const r = await runAgent({
        provider,
        model: strategy.model,
        task: { goal: ch.goal, expectation: ch.expectation },
        toolsets: [fileToolset(dir), shellToolset(dir)],
        prompts: { system: [...defaultPrompts.system, ...cliSystem(dir), ...strategy.rules] },
        guidance: strategy.guidance,
        budget: { maxSteps: strategy.maxSteps, maxToolCalls: strategy.maxToolCalls, readNudgeAt: strategy.readNudgeAt, maxUsd: Math.min(options.perChallengeUsd, options.budget()) },
        // The gym is its own sandbox: changes run without asking, and there is no small talk to detect.
        approve: async () => true,
        opening: false,
        signal: options.signal,
        onEvent: e => void (e.type === 'tool_call' && calls.push(`${e.name}(${JSON.stringify(e.args).slice(0, 80)})`)),
      }).catch(error => ({ status: 'error', answer: null, cost: 0, steps: 0, reason: error instanceof Error ? error.message : String(error) }));
      const grade = r.status === 'error' ? { score: 0, why: `error: ${(r as { reason: string }).reason.slice(0, 120)}` } : ch.check(r.answer, dir);
      attempts.push({ id: ch.id, kind: ch.kind, goal: ch.goal, score: grade.score, why: grade.why, answer: r.answer?.slice(0, 400) ?? null, calls, cost: r.cost, steps: r.steps, status: r.status });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const n = Math.max(1, attempts.length);
  return {
    score: attempts.reduce((a, t) => a + t.score, 0) / n,
    cost: attempts.reduce((a, t) => a + t.cost, 0),
    steps: attempts.reduce((a, t) => a + t.steps, 0),
    attempts,
    cut,
  };
}

/** The model reads its own failures and writes one general rule. Null when it has nothing usable. */
export async function proposeRule(provider: ModelProvider, strategy: Strategy, failures: Attempt[], signal?: AbortSignal): Promise<{ rule: string | null; cost: number }> {
  const cases = failures.slice(0, 3).map((f, i) =>
    [`Case ${i + 1}: task: ${f.goal}`, `  tools it called: ${f.calls.join(', ') || 'none'}`, `  its answer: ${f.answer ?? '(none)'}`, `  what was wrong: ${f.why}`].join('\n')
  );
  const reply = await provider.chat({
    model: strategy.model,
    maxTokens: 120,
    signal,
    messages: [
      {
        role: 'system',
        content:
          'You improve the standing instructions of an AI agent that works in a folder with file tools and a shell. You write ONE rule: short (under 25 words), general, and actionable. Never mention the specific tasks, numbers, words or file names below. Reply with the rule only.',
      },
      {
        role: 'user',
        content: `The agent got these wrong:\n\n${cases.join('\n\n')}\n\nIts current extra rules:\n${strategy.rules.map(r => `- ${r}`).join('\n') || '(none)'}\n\nWrite one new rule that would have helped.`,
      },
    ],
  });
  const text = (reply.message.content ?? '').split('\n').map(l => l.replace(/^[-*\d.)\s"'“]+|["'”]+$/g, '').trim()).find(Boolean) ?? '';
  const rule = text.length >= 12 && text.length <= 220 && !strategy.rules.includes(text) ? text : null;
  return { rule, cost: reply.cost };
}

const GUIDANCE: Guidance[] = ['off', 'light', 'normal', 'close'];

/** One parametric change, one notch, chosen by the round's seed. */
export function tweak(s: Strategy, seed: number): Strategy {
  const r = rng(seed);
  const moves = [
    () => ({ ...s, guidance: r.pick(GUIDANCE.filter(g => g !== s.guidance && !(s.guidance === 'auto' && g === 'normal'))) }),
    () => ({ ...s, maxSteps: Math.min(16, Math.max(6, s.maxSteps + r.pick([-2, 2]))) }),
    () => ({ ...s, maxToolCalls: Math.min(30, Math.max(8, s.maxToolCalls + r.pick([-4, 4]))) }),
    () => ({ ...s, readNudgeAt: Math.min(8, Math.max(2, s.readNudgeAt + r.pick([-1, 1]))) }),
  ];
  return r.pick(moves)();
}

/**
 * The ratchet's rule. 'clear': more than one challenge's worth better, or the same score for clearly
 * less. 'maybe': better by at most one challenge (worth confirming). 'no': not better.
 */
export function compare(candidate: Evaluation, champion: Evaluation): 'clear' | 'maybe' | 'no' {
  const eps = 1e-9;
  const one = 1 / Math.max(1, champion.attempts.length || candidate.attempts.length || 1);
  const diff = candidate.score - champion.score;
  if (diff > one + eps) return 'clear';
  if (diff > eps) return 'maybe';
  if (Math.abs(diff) <= eps && candidate.cost < champion.cost * 0.85 && candidate.steps <= champion.steps) return 'clear';
  return 'no';
}

/** Better on the same challenges, or as good for clearly less (no confirmation involved). */
export const better = (candidate: Evaluation, champion: Evaluation): boolean => compare(candidate, champion) !== 'no';

/** The next level: up after a near-perfect round, down after a poor one. */
export const nextLevel = (level: number, score: number): number => (score >= 0.9 ? Math.min(MAX_LEVEL, level + 1) : score <= 0.4 ? Math.max(1, level - 1) : level);

export interface Round {
  at: string;
  round: number;
  seed: number;
  model: string;
  change: string;
  level: number;
  /** A one-challenge win re-run on a second set before deciding. */
  confirmed?: boolean;
  champion: { score: number; cost: number };
  candidate: { score: number; cost: number } | null;
  kept: boolean;
  spent: number;
  failures: { id: string; why: string }[];
}

export interface TrainOptions {
  provider: ModelProvider;
  model: string;
  rounds: number;
  /** USD for the whole run; nothing starts once it is spent. */
  maxUsd: number;
  /** Challenges per round. */
  size: number;
  seed?: number;
  signal?: AbortSignal;
  onRound?: (round: Round, champion: Strategy) => void;
  onProgress?: (text: string) => void;
  /** For tests: evaluate strategies without running a model. */
  evaluate?: typeof evaluate;
}

export async function train(o: TrainOptions): Promise<{ champion: Strategy; rounds: Round[]; spent: number }> {
  const run = o.evaluate ?? evaluate;
  let champion = loadStrategy(o.model) ?? baseline(o.model);
  let spent = 0;
  const left = () => o.maxUsd - spent;
  const rounds: Round[] = [];
  const base = o.seed ?? Math.floor(Date.now() / 1000);
  const log = join(home(), 'gym', 'history.jsonl');
  mkdirSync(join(home(), 'gym'), { recursive: true });

  for (let i = 0; i < o.rounds && left() > 0 && !o.signal?.aborted; i++) {
    const seed = base + i * 7919;
    const level = champion.level ?? 1;
    const set = challenges(seed, o.size, level);
    const opts = { budget: left, perChallengeUsd: Math.max(0.002, o.maxUsd / (o.rounds * o.size)), signal: o.signal };

    o.onProgress?.(`round ${i + 1}: champion on ${set.length} challenges`);
    const champ = await run(o.provider, champion, set, opts);
    spent += champ.cost;
    if (champ.cut) break;

    // A candidate: a rule from the failures when there are any, otherwise a tweak or a prune.
    const failures = champ.attempts.filter(a => a.score < 1);
    const r = rng(seed ^ 0x5bd1e995);
    let candidate: Strategy;
    if (failures.length && r.next() < 0.6) {
      o.onProgress?.(`round ${i + 1}: the model writes a rule from ${failures.length} failure(s)`);
      const p = await proposeRule(o.provider, champion, failures, o.signal).catch(() => ({ rule: null, cost: 0 }));
      spent += p.cost;
      candidate = p.rule ? { ...champion, rules: [...champion.rules, p.rule].slice(-MAX_RULES) } : tweak(champion, seed);
    } else if (champion.rules.length && r.next() < 0.3) {
      const drop = r.int(0, champion.rules.length - 1);
      candidate = { ...champion, rules: champion.rules.filter((_, k) => k !== drop) };
    } else candidate = tweak(champion, seed);

    const change = describeChange(champion, candidate);
    o.onProgress?.(`round ${i + 1}: candidate (${change})`);
    const cand = left() > 0 ? await run(o.provider, candidate, set, opts) : null;
    if (cand) spent += cand.cost;
    const complete = cand && !cand.cut;
    let verdict = complete ? compare(cand, champ) : 'no';
    let confirmed: boolean | undefined;
    if (verdict === 'maybe' && left() > 0) {
      // One more solved is within the model's own randomness: both face a second fresh set.
      o.onProgress?.(`round ${i + 1}: close — confirming on a second set`);
      const set2 = challenges(seed + 1, o.size, level);
      const champ2 = await run(o.provider, champion, set2, opts);
      spent += champ2.cost;
      const cand2 = left() > 0 && !champ2.cut ? await run(o.provider, candidate, set2, opts) : null;
      if (cand2) spent += cand2.cost;
      confirmed = !!cand && !!cand2 && !cand2.cut && cand.score + cand2.score > champ.score + champ2.score + 1e-9;
      verdict = confirmed ? 'clear' : 'no';
    }
    const kept = verdict === 'clear';
    const score = kept ? cand!.score : champ.score;
    const now = new Date().toISOString();
    champion = kept
      ? { ...candidate, level: nextLevel(level, score), score, rounds: 0, updated: now }
      : { ...champion, level: nextLevel(level, score), score, rounds: (champion.rounds ?? 0) + 1, updated: now };
    saveStrategy(champion);

    const round: Round = {
      at: new Date().toISOString(),
      round: i + 1,
      seed,
      model: o.model,
      change,
      level,
      ...(confirmed !== undefined ? { confirmed } : {}),
      champion: { score: champ.score, cost: champ.cost },
      candidate: complete ? { score: cand.score, cost: cand.cost } : null,
      kept,
      spent,
      failures: failures.map(f => ({ id: f.id, why: f.why })),
    };
    appendFileSync(log, `${JSON.stringify(round)}\n`);
    rounds.push(round);
    o.onRound?.(round, champion);
  }
  return { champion, rounds, spent };
}
