/**
 * Hooks — where an app bends the loop without forking it.
 *
 * Frontier harnesses converged on the same design: a minimal kernel, with everything else as hooks
 * at the loop's stages (Claude Code's PreToolUse / Stop, DeepSeek's pre-execute). Four stages here:
 *
 *   beforeStep    — before each model call        go · pause (end, 'paused') · stop (end, 'stopped')
 *   toolGate      — before each tool call         go (optionally with rewritten args, or a result
 *                                                 given instead of running) · pause · stop
 *   rewriteOutput — each tool result, before the model sees it: redact, trim, annotate
 *   stopCheck     — when the model stops          stop (accept: done) · go (send it back with the
 *                                                 reason, counted as a nudge) · pause (needs_person)
 *
 * One vocabulary — go / pause / stop — on purpose: it is the same shape as ensemble's
 * `guard(step) -> go | pause | stop`, so a supervisor that speaks one speaks both. "go" always means
 * the run continues; "pause" means a person's move is next and the run can be resumed; "stop" ends.
 * A hook returning nothing is "go" — except stopCheck, where nothing means no objection: the stop
 * stands, exactly as if it had said "stop".
 */
import type { ChatMessage } from './model.ts';
import type { AgentTask } from './seams.ts';

export type Verdict = 'go' | 'pause' | 'stop';

export interface HookDecision {
  verdict: Verdict;
  /** Why — logged, returned as the result's `reason`, and (for a stopCheck "go") told to the model. */
  reason?: string;
}

export type HookReply = Verdict | HookDecision | void | undefined;
type Maybe<T> = T | Promise<T>;

export interface StepContext {
  step: number;
  /** USD so far. */
  spent: number;
  toolCalls: number;
  nudges: number;
  task: AgentTask;
  /** The conversation as the model sees it. Read-only: change the run through verdicts. */
  messages: readonly ChatMessage[];
  /** Add USD a hook spent (a Jev decision) to the run's total and budget. */
  spend(usd: number, on: string): void;
}

export interface ToolGateContext extends StepContext {
  tool: string;
  args: Record<string, unknown>;
  callId: string;
  /** The approval sentence when this call changes something, else null. */
  change: string | null;
}

export interface ToolGateDecision extends HookDecision {
  /** Run with these arguments instead. */
  args?: Record<string, unknown>;
  /** Do not run: hand the model this result instead (a refusal, a cached answer). */
  result?: string;
}

export interface OutputContext extends StepContext {
  tool: string;
  args: Record<string, unknown>;
  callId: string;
  ok: boolean;
  result: string;
}

export interface StopContext extends StepContext {
  answer: string | null;
}

export interface Hooks {
  beforeStep?(ctx: StepContext): Maybe<HookReply>;
  toolGate?(ctx: ToolGateContext): Maybe<Verdict | ToolGateDecision | void | undefined>;
  /** Return the text the model should see instead, or nothing to keep it. */
  rewriteOutput?(ctx: OutputContext): Maybe<string | void | undefined>;
  stopCheck?(ctx: StopContext): Maybe<HookReply>;
}

/** Any hook reply as a decision. Nothing is "go". */
export function readVerdict<T extends HookDecision>(reply: Verdict | T | void | undefined): T | HookDecision {
  if (!reply) return { verdict: 'go' };
  if (typeof reply === 'string') return { verdict: reply };
  return reply;
}

/**
 * Several hook sets as one. Gates run in order and the first non-"go" wins (a rewrite of args by one
 * gate is what the next one sees); output rewrites chain; for stopCheck the first objection wins.
 */
export function combineHooks(...sets: (Hooks | undefined)[]): Hooks {
  const hooks = sets.filter((h): h is Hooks => !!h);
  return {
    async beforeStep(ctx) {
      for (const h of hooks) {
        const d = readVerdict(await h.beforeStep?.(ctx));
        if (d.verdict !== 'go') return d;
      }
    },
    async toolGate(ctx) {
      let args = ctx.args;
      let rewritten = false;
      for (const h of hooks) {
        const d = readVerdict(await h.toolGate?.({ ...ctx, args })) as ToolGateDecision;
        if (d.verdict !== 'go' || d.result !== undefined) return { ...d, ...(rewritten && !d.args ? { args } : {}) };
        if (d.args) {
          args = d.args;
          rewritten = true;
        }
      }
      return rewritten ? { verdict: 'go', args } : undefined;
    },
    async rewriteOutput(ctx) {
      let result = ctx.result;
      for (const h of hooks) {
        const next = await h.rewriteOutput?.({ ...ctx, result });
        if (typeof next === 'string') result = next;
      }
      return result === ctx.result ? undefined : result;
    },
    async stopCheck(ctx) {
      // Nothing or "stop" accepts the stop; the first objection ("go" back to work, or "pause") wins.
      for (const h of hooks) {
        const reply = await h.stopCheck?.(ctx);
        if (reply && readVerdict(reply).verdict !== 'stop') return reply;
      }
    },
  };
}
