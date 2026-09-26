/**
 * The guide — Jev asking "is this going the right way?" so a weaker model gets through uncertainty.
 *
 * A strong worker rarely needs help; a cheap one often does, and a calibrated yes/no costs about
 * $0.00002. So the HARNESS asks Jev at fixed checkpoints — not only when the model thinks to call
 * `ask_jev` — and turns the probability into a move, in code:
 *
 *   after_tool    "does this result move toward the request?"       low → a transient steer
 *   before_write  "is this change what the person asked for?"        low → the call is held back once,
 *                                                                          with the doubt, before approval
 *   before_answer "does this answer respond to the request?"         low → sent back (a nudge)
 *   hesitation    (an empty reply, a repeated call, leaked markup)   a choice over the tools + "answer
 *                 "which next step moves the request forward?"             now" → a transient steer naming it
 *
 * The guide STEERS; it does not overrule. A held-back change goes through if the model makes it
 * again, and a person still approves it. That is the lesson of the verdict node Potion's Talk dropped
 * before its first commit ("Pi — the model decides; no second judge"): it judged the WHOLE transcript
 * and asked whether every fact and number was supported, which is exactly where Jev's documented
 * jaggedness lies (counting and numbers, long context, multi-hop). Here every question is atomic,
 * the state is the task and the latest step only, and nothing asks Jev to count or compare figures.
 *
 * How closely it watches follows the model (`guidance`, default 'auto'):
 *   1. a starting level from what the provider knows of the model (`card()`: price, context, tools —
 *      the live OpenRouter catalogue, never a list of ids);
 *   2. adapted within the run from evidence: repeated low probabilities tighten it, a run of confident
 *      passes loosens it — each change an event;
 *   3. learned across runs: a per-model profile (how often Jev corrected it, and whether corrected runs
 *      still succeeded) in a pluggable store, which seeds the next run's level.
 * Every checkpoint is an event with its question, probability and action, and its cost is spent
 * against the run's budget, so the value of guidance can be measured (see bench/).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentEvent } from './events.ts';
import type { ModelCard, ModelProvider, Question } from './model.ts';
import type { AgentStatus, AgentTask } from './seams.ts';
import type { AgentTool } from './tools.ts';

export type GuidanceLevel = 'off' | 'light' | 'normal' | 'close';
/** 'auto' starts from the model and adapts; a named level is fixed; a number N checks after every Nth tool result, fixed. */
export type Guidance = 'auto' | GuidanceLevel | number;

export type Checkpoint = 'after_tool' | 'before_write' | 'before_answer' | 'hesitation';

export interface Thresholds {
  /** after_tool: below this, steer. Default 0.35. */
  onTrack: number;
  /** before_write: below this, hold the change back once. Default 0.3. */
  write: number;
  /** before_answer: below this, send back. Default 0.35. */
  answer: number;
  /** At or above this a pass counts as confident (for loosening). Default 0.85. */
  confident: number;
  /** This many lows in a row tighten the level. Default 2. */
  tightenAfter: number;
  /** This many confident passes in a row loosen it. Default 4. */
  loosenAfter: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { onTrack: 0.35, write: 0.3, answer: 0.35, confident: 0.85, tightenAfter: 2, loosenAfter: 4 };

const ORDER: GuidanceLevel[] = ['off', 'light', 'normal', 'close'];

/** What each level checks. `afterTool` is a period: every Nth tool result (0 = never). */
export const LEVELS: Record<GuidanceLevel, { afterTool: number; beforeWrite: boolean; beforeAnswer: boolean; hesitation: boolean }> = {
  off: { afterTool: 0, beforeWrite: false, beforeAnswer: false, hesitation: false },
  light: { afterTool: 0, beforeWrite: true, beforeAnswer: true, hesitation: false },
  normal: { afterTool: 3, beforeWrite: true, beforeAnswer: true, hesitation: true },
  close: { afterTool: 1, beforeWrite: true, beforeAnswer: true, hesitation: true },
};

// ── profiles: learning which models need help ───────────────────────────────

export interface GuideProfile {
  model: string;
  runs: number;
  /** Runs that ended 'done'. */
  successes: number;
  checkpoints: number;
  /** Checkpoints below their threshold. */
  lows: number;
  /** Runs where the guide steered at least once, and how many of those still ended 'done'. */
  correctedRuns: number;
  correctedSuccesses: number;
  /** The level the last run ended at. */
  lastLevel: GuidanceLevel;
}

export interface ProfileStore {
  get(model: string): Promise<GuideProfile | null>;
  put(profile: GuideProfile): Promise<void>;
}

export function memoryProfiles(): ProfileStore & { profiles: Map<string, GuideProfile> } {
  const profiles = new Map<string, GuideProfile>();
  return { profiles, get: async m => (profiles.has(m) ? { ...profiles.get(m)! } : null), put: async p => void profiles.set(p.model, { ...p }) };
}

/** Profiles in one JSON file (written atomically). Good for a CLI or a single server. */
export function fileProfiles(path: string): ProfileStore {
  const read = (): Record<string, GuideProfile> => {
    try {
      return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, GuideProfile>) : {};
    } catch {
      return {};
    }
  };
  return {
    get: async m => read()[m] ?? null,
    put: async p => {
      const all = read();
      all[p.model] = p;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(`${path}.tmp`, JSON.stringify(all, null, 2));
      renameSync(`${path}.tmp`, path);
    },
  };
}

// ── the starting level ──────────────────────────────────────────────────────

/**
 * From what the catalogue says of a model. Price is the strongest cheap signal of capability a
 * catalogue gives; a small context or no tool support tightens one more notch. Unknown → normal.
 */
export function levelFromCard(card: ModelCard | null): { level: GuidanceLevel; why: string } {
  if (!card) return { level: 'normal', why: 'nothing known about the model' };
  const perMillion = card.completion * 1e6;
  let i = perMillion >= 10 ? 1 : perMillion >= 2 ? 2 : 3;
  const weak: string[] = [];
  if (!card.tools) weak.push('no tool support');
  if (card.context > 0 && card.context < 64_000) weak.push(`${card.context} context`);
  if (weak.length) i = Math.min(3, i + 1);
  const level = ORDER[i]!;
  return { level, why: `$${perMillion.toFixed(2)}/M output${weak.length ? `, ${weak.join(', ')}` : ''}` };
}

/** From a model's history, once there is enough of it (3+ runs); null otherwise. */
export function levelFromProfile(p: GuideProfile | null): { level: GuidanceLevel; why: string } | null {
  if (!p || p.runs < 3 || p.checkpoints === 0) return null;
  const lowRate = p.lows / p.checkpoints;
  const success = p.successes / p.runs;
  const why = `${p.runs} runs, ${Math.round(lowRate * 100)}% low checkpoints, ${Math.round(success * 100)}% done`;
  if (lowRate > 0.3 || success < 0.6) return { level: 'close', why };
  if (lowRate > 0.12) return { level: 'normal', why };
  if (success >= 0.8) return { level: 'light', why };
  return { level: 'normal', why };
}

// ── the runtime the loop drives ─────────────────────────────────────────────

export interface GuideOptions {
  guidance?: Guidance;
  thresholds?: Partial<Thresholds>;
  profiles?: ProfileStore;
}

export interface GuideDeps {
  provider: ModelProvider;
  model: string | undefined;
  task: AgentTask;
  signal: AbortSignal;
  emit(event: AgentEvent): void;
  spend(usd: number, on: string): void;
  /** False once the run is over its USD cap: checkpoints are skipped then. */
  affordable(): boolean;
}

export interface Guide {
  readonly level: GuidanceLevel;
  readonly active: boolean;
  start(): Promise<void>;
  /** After a batch of tool results: a steer for the next call, or null. */
  afterTools(results: { tool: string; args: Record<string, unknown>; result: string; ok: boolean }[]): Promise<string | null>;
  /** Before a change: a held-back result to hand the model instead, or null to proceed. */
  beforeWrite(tool: string, args: Record<string, unknown>, change: string, key: string): Promise<string | null>;
  /** Before accepting the final answer: a reason to send it back, or null. */
  beforeAnswer(answer: string | null): Promise<string | null>;
  /** When the model hesitates: a steer naming the likeliest next step, or null. */
  hesitation(why: 'empty_reply' | 'repeated_call' | 'leaked_call', last: string, tools: AgentTool[]): Promise<string | null>;
  finish(status: AgentStatus): Promise<void>;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const firstSentence = (d: string) => clip(d.trim().split(/(?<=\.)\s/)[0] ?? d, 200);
const callText = (tool: string, args: Record<string, unknown>) => clip(`${tool}(${JSON.stringify(args)})`, 400);

export const ANSWER_NOW = 'answer_now';

export function createGuide(options: GuideOptions, deps: GuideDeps): Guide {
  const T: Thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  const setting = options.guidance ?? 'auto';
  const decide = deps.provider.decide?.bind(deps.provider);
  const adaptive = setting === 'auto';
  const period = typeof setting === 'number' ? Math.max(1, Math.round(setting)) : null;
  let level: GuidanceLevel = typeof setting === 'number' ? 'close' : setting === 'auto' ? 'normal' : setting;
  const active = () => !!decide && level !== 'off';

  let results = 0;
  let lowStreak = 0;
  let confidentStreak = 0;
  let checkpoints = 0;
  let lows = 0;
  let corrections = 0;
  const heldBack = new Set<string>();

  const setLevel = (next: GuidanceLevel, reason: string) => {
    if (next === level) return;
    deps.emit({ type: 'guidance', from: level, level: next, reason });
    level = next;
  };

  /** Record a probability: counts, streaks, and (auto) tightening or loosening. */
  const observe = (p: number, threshold: number) => {
    checkpoints++;
    if (p < threshold) {
      lows++;
      lowStreak++;
      confidentStreak = 0;
      if (adaptive && lowStreak >= T.tightenAfter && level !== 'close') {
        setLevel(ORDER[ORDER.indexOf(level) + 1]!, `${lowStreak} low checkpoints in a row`);
        lowStreak = 0;
      }
    } else {
      lowStreak = 0;
      confidentStreak = p >= T.confident ? confidentStreak + 1 : 0;
      if (adaptive && confidentStreak >= T.loosenAfter && ORDER.indexOf(level) > 1) {
        setLevel(ORDER[ORDER.indexOf(level) - 1]!, `${confidentStreak} confident checkpoints in a row`);
        confidentStreak = 0;
      }
    }
  };

  const ask = async <K extends string>(state: unknown, questions: Record<K, Question>) => {
    if (!decide || !deps.affordable() || deps.signal.aborted) return null;
    try {
      const reply = await decide(state, questions, deps.signal);
      deps.spend(reply.cost, 'guide');
      return reply.answers;
    } catch {
      return null; // No answer is never read as a verdict.
    }
  };

  const yesNo = async (at: Checkpoint, question: string, state: unknown, threshold: number, lowAction: 'steer' | 'hold' | 'send_back') => {
    const answers = await ask(state, { q: { type: 'noul', instructions: question } });
    const a = answers?.q;
    if (!a || a.type !== 'noul') {
      deps.emit({ type: 'checkpoint', at, question, p: null, action: 'none', level });
      return null;
    }
    const low = a.noul < threshold;
    deps.emit({ type: 'checkpoint', at, question, p: a.noul, action: low ? lowAction : 'pass', level });
    observe(a.noul, threshold);
    if (low) corrections++;
    return { p: a.noul, low };
  };

  const pct = (p: number) => `${Math.round(p * 100)}%`;

  return {
    get level() {
      return level;
    },
    get active() {
      return active();
    },

    async start() {
      if (!decide || !adaptive) return;
      const model = deps.model ?? '';
      const learned = options.profiles && model ? levelFromProfile(await options.profiles.get(model).catch(() => null)) : null;
      const from = learned ?? levelFromCard(model && deps.provider.card ? await deps.provider.card(model, deps.signal).catch(() => null) : null);
      deps.emit({ type: 'guidance', from: null, level: from.level, reason: `${learned ? 'profile' : 'catalogue'}: ${from.why}` });
      level = from.level;
    },

    async afterTools(batch) {
      if (!active() || !batch.length) return null;
      const every = period ?? LEVELS[level].afterTool;
      const due = batch.filter(() => every > 0 && ++results % every === 0);
      if (!due.length) return null;
      // Judge the last result that fell due: the latest step, not the transcript.
      const last = due.at(-1)!;
      const question = 'Does `result` (what `call` returned) move the agent closer to doing what `goal` asks?';
      const out = await yesNo('after_tool', question, { goal: clip(deps.task.goal, 600), call: callText(last.tool, last.args), result: clip(last.result, 1500) }, T.onTrack, 'steer');
      if (!out?.low) return null;
      return `Guide (Jev, ${pct(out.p)} on track): the last result may not move toward the request "${clip(deps.task.goal, 200)}". Before the next call, reconsider: another tool, other arguments, or answering with what you have.`;
    },

    async beforeWrite(tool, args, change, key) {
      if (!active() || !LEVELS[level].beforeWrite || heldBack.has(key)) return null;
      const question = 'Is `change` something `goal` asks for?';
      const out = await yesNo('before_write', question, { goal: clip(deps.task.goal, 600), change: clip(change, 400), call: callText(tool, args) }, T.write, 'hold');
      if (!out?.low) return null;
      // Held back once: the same change made again goes on to approval.
      heldBack.add(key);
      return `Not run yet — Guide (Jev, ${pct(out.p)}): this change may not be what the person asked for ("${clip(deps.task.goal, 200)}"). If it is, make the same call again; otherwise choose another action or ask the person.`;
    },

    async beforeAnswer(answer) {
      if (!active() || !LEVELS[level].beforeAnswer || !answer) return null;
      const question = 'Does `answer` respond to what `goal` asks for?';
      const out = await yesNo('before_answer', question, { goal: clip(deps.task.goal, 600), expected: clip(deps.task.expectation, 400), answer: clip(answer, 2000) }, T.answer, 'send_back');
      if (!out?.low) return null;
      return `Guide (Jev, ${pct(out.p)}): your answer may not respond to the request "${clip(deps.task.goal, 200)}". Check what was asked, fix what is missing, and reply with the corrected answer.`;
    },

    async hesitation(why, last, tools) {
      if (!active() || !LEVELS[level].hesitation) return null;
      const criteria: Record<string, string> = { [ANSWER_NOW]: 'Enough is known: answer now with what the tools returned.' };
      for (const t of tools.slice(0, 250)) criteria[t.name] = firstSentence(t.description);
      const question = 'Which next step most helps do what `goal` asks, given `last`?';
      const answers = await ask({ goal: clip(deps.task.goal, 600), last: clip(last, 1200), hesitation: why }, { q: { type: 'choice', instructions: question, criteria } });
      const a = answers?.q;
      if (!a || a.type !== 'choice' || !(a.choice in criteria)) {
        deps.emit({ type: 'checkpoint', at: 'hesitation', question, p: null, action: 'none', level });
        return null;
      }
      checkpoints++;
      corrections++;
      deps.emit({ type: 'checkpoint', at: 'hesitation', question, p: a.confidence, choice: a.choice, action: 'steer', level });
      return a.choice === ANSWER_NOW
        ? `Guide (Jev, ${pct(a.confidence)}): you likely have enough — answer now from what the tools returned.`
        : `Guide (Jev, ${pct(a.confidence)}): the next step most likely to help is \`${a.choice}\`.`;
    },

    async finish(status) {
      const model = deps.model;
      if (!options.profiles || !model || !decide || checkpoints === 0) return;
      const p = (await options.profiles.get(model).catch(() => null)) ?? { model, runs: 0, successes: 0, checkpoints: 0, lows: 0, correctedRuns: 0, correctedSuccesses: 0, lastLevel: level };
      const done = status === 'done';
      await options.profiles
        .put({
          model,
          runs: p.runs + 1,
          successes: p.successes + (done ? 1 : 0),
          checkpoints: p.checkpoints + checkpoints,
          lows: p.lows + lows,
          correctedRuns: p.correctedRuns + (corrections ? 1 : 0),
          correctedSuccesses: p.correctedSuccesses + (corrections && done ? 1 : 0),
          lastLevel: level,
        })
        .catch(() => {});
    },
  };
}
