/**
 * Jev behind the hooks — calibrated decisions an app can add to its own gates and checks.
 *
 * The built-in guidance lives in guide.ts (checkpoints the loop asks itself, sized to the model).
 * This module is the explicit, app-owned variant.
 *
 * Jev is the engine's second model and its cheapest judge: it answers typed questions with
 * probabilities, not prose, so it cannot be talked into agreeing, and at a fraction of a cent in
 * well under a second it is affordable at every step. The loop already asks it whether there is a
 * task at all and which skills a task needs, and offers `ask_jev` to the worker. This module puts it
 * behind the hook vocabulary too, so an app can have Jev GATE a change or CHECK an answer, and a
 * supervisor reads the same go / pause / stop it would from any other hook:
 *
 *   jevStopCheck — when the worker stops, Jev answers yes/no questions about the answer against the
 *                  work (the defaults: every part answered, every fact backed by a tool result, the
 *                  expected form). A failed check sends the worker back with that check's feedback.
 *   jevToolGate  — before a change (or any call), Jev judges whether it serves the person's goal;
 *                  below the bar the run pauses for the person, or the call is refused.
 *
 * Both are opt-in: they cost a decision per stop / per gated call, and Potion's evaluation found
 * the code check (an app's own stopCheck) catches most of what a second judge would. What they spend
 * goes through the hook context's `spend`, so it counts toward the run's total and USD cap.
 */
import type { Hooks, ToolGateDecision } from './hooks.ts';
import type { ChatMessage, ModelProvider, Question } from './model.ts';

/** The work so far as a compact log for Jev — the last steps weigh most. */
export function workLog(messages: readonly ChatMessage[]) {
  const firstTask = messages.findIndex(m => m.role === 'user' && m.content.startsWith('Task: '));
  return messages
    .slice(Math.max(0, firstTask))
    .filter(m => m.role !== 'system')
    .slice(-24)
    .map(m => {
      if (m.role === 'tool') return { tool_result: m.content.slice(0, 4000) };
      if (m.role === 'assistant') return { agent: m.content?.slice(0, 1500) ?? null, calls: m.tool_calls?.map(c => `${c.function.name}(${c.function.arguments.slice(0, 300)})`) };
      return { [m.role]: m.content.slice(0, 500) };
    });
}

export interface JevCheck {
  /** A yes/no question about `task`, `final_answer` and `work`. */
  question: string;
  /** What the worker is told when the check fails. */
  feedback: string;
  /** Below this probability of yes, the check fails. Default 0.5. */
  min?: number;
}

/**
 * The answer checks from Potion's dropped verdict node, minus the one Jev is documented to be bad at:
 * "is every fact and number supported by the work" asks it to compare figures across a long
 * transcript (counting, numbers and long context are its jaggedness). Keep questions atomic.
 */
export const DEFAULT_CHECKS: Record<string, JevCheck> = {
  answers_every_part: { question: 'Does `final_answer` address every part of `task.goal`?', feedback: 'Part of the request is not answered.' },
  expected_form: { question: 'Is `final_answer` in the form `task.expectation` describes?', feedback: 'The answer is not in the expected form: re-read the expected output.' },
};

/** A stopCheck that sends the worker back when Jev finds the answer falls short. */
export function jevStopCheck(provider: ModelProvider, checks: Record<string, JevCheck> = DEFAULT_CHECKS): NonNullable<Hooks['stopCheck']> {
  if (!provider.decide) throw new Error('jevStopCheck needs a ModelProvider with decide().');
  const decide = provider.decide.bind(provider);
  return async ctx => {
    const questions: Record<string, Question> = Object.fromEntries(Object.entries(checks).map(([id, c]) => [id, { type: 'noul', instructions: c.question }]));
    // Short context on purpose: the task and the answer, plus only the last few steps of work.
    const state = { task: { goal: ctx.task.goal, expectation: ctx.task.expectation }, final_answer: (ctx.answer ?? '').slice(0, 2000), work: workLog(ctx.messages).slice(-6) };
    try {
      const { answers, cost } = await decide(state, questions);
      ctx.spend(cost, 'jevStopCheck');
      const failed = Object.entries(checks)
        .filter(([id, c]) => {
          const a = answers[id];
          return a?.type === 'noul' && a.noul < (c.min ?? 0.5);
        })
        .map(([, c]) => c.feedback);
      if (failed.length) return { verdict: 'go', reason: `${failed.join(' ')} Fix it and reply with the corrected answer.` };
    } catch {
      // No answer is not a failed check: the stop stands.
    }
  };
}

export interface JevGateOptions {
  /** The question about `goal`, `tool`, `args` and `change`. */
  question?: string;
  /** Below this probability of yes, the gate acts. Default 0.3. */
  min?: number;
  /** What happens below the bar: pause the run for the person (default), or refuse this call and go on. */
  below?: 'pause' | 'refuse';
  /** Gate every call, not only changes. Default false. */
  everyCall?: boolean;
}

/** A toolGate where Jev judges whether a call serves the person's goal. */
export function jevToolGate(provider: ModelProvider, options: JevGateOptions = {}): NonNullable<Hooks['toolGate']> {
  if (!provider.decide) throw new Error('jevToolGate needs a ModelProvider with decide().');
  const decide = provider.decide.bind(provider);
  const question = options.question ?? 'Does calling `tool` with `args` (the change: `change`) serve what the person asked in `goal`, and nothing they did not ask for?';
  const min = options.min ?? 0.3;
  return async (ctx): Promise<ToolGateDecision | undefined> => {
    if (!options.everyCall && ctx.change === null) return;
    try {
      const { answers, cost } = await decide({ goal: ctx.task.goal, tool: ctx.tool, args: ctx.args, change: ctx.change }, { serves: { type: 'noul', instructions: question } });
      ctx.spend(cost, 'jevToolGate');
      const a = answers.serves;
      if (a?.type !== 'noul' || a.noul >= min) return;
      const reason = `Jev judged ${ctx.tool} unlikely to serve the request (p=${a.noul.toFixed(2)}).`;
      return options.below === 'refuse' ? { verdict: 'go', reason, result: `Refused: ${reason} Do what the person asked, or ask them.` } : { verdict: 'pause', reason };
    } catch {
      // No answer: the gate does not act on a guess.
    }
  };
}

/** Ask Jev one question outside the loop — a convenience with the same cost accounting. */
export async function ask(provider: ModelProvider, state: unknown, question: Question, signal?: AbortSignal) {
  if (!provider.decide) throw new Error('This provider cannot decide');
  const { answers, cost } = await provider.decide(state, { q: question }, signal);
  return { answer: answers.q, cost };
}

