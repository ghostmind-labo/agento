/**
 * Events — what happened in a run, and the log that keeps it.
 *
 * The rule: IF THE MODEL SAW IT, IT IS LOGGED. Every message added to the model's context emits a
 * `context` event — the system prompt, the task, each tool result as the model received it (after
 * truncation and rewriting), and the transient lines (reminders, "answer now") that are sent once and
 * never stay in the conversation. A run can therefore be replayed and audited from its log alone,
 * which is not true of `messages`, where transient lines leave no trace.
 *
 * The log is append-only in the strict sense: an entry is a deep copy, frozen, numbered in order.
 * Nothing that happens later in the run — a message mutated, a result rewritten — can change what
 * was recorded.
 */
import type { ChatMessage } from './model.ts';
import type { AgentResult, AgentTask } from './seams.ts';
import type { Verdict } from './hooks.ts';
import type { Checkpoint, GuidanceLevel } from './guide.ts';

export type AgentEvent =
  | { type: 'run_start'; task: AgentTask; model: string | null }
  | { type: 'context'; message: ChatMessage; transient: boolean }
  | { type: 'opening'; path: 'task' | 'greeting' | 'small_talk'; confidence: number }
  | { type: 'skills'; names: string[] }
  | { type: 'step'; step: number; answerNow: boolean }
  | { type: 'delta'; text: string }
  | { type: 'message'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'approval'; id: string; tool: string; summary: string; args: Record<string, unknown> }
  | { type: 'approval_result'; id: string; approved: boolean }
  | { type: 'tool_result'; id: string; name: string; ok: boolean; result: string }
  | { type: 'hook'; hook: 'beforeStep' | 'toolGate' | 'stopCheck'; verdict: Verdict; reason: string | null }
  | { type: 'nudge'; reason: string }
  | { type: 'spend'; usd: number; total: number; on: string }
  /** A Jev checkpoint the guide asked: the question, the probability (or chosen step) and what the loop did. */
  | { type: 'checkpoint'; at: Checkpoint; question: string; p: number | null; choice?: string; action: 'pass' | 'steer' | 'hold' | 'send_back' | 'none'; level: GuidanceLevel }
  /** The guidance level was set (from: null) or changed, and why. */
  | { type: 'guidance'; from: GuidanceLevel | null; level: GuidanceLevel; reason: string }
  | { type: 'finished'; result: AgentResult };

export interface LoggedEvent {
  /** 1, 2, 3… in the order they happened. */
  seq: number;
  /** ISO time. */
  at: string;
  event: AgentEvent;
}

export interface EventLog {
  append(event: AgentEvent): LoggedEvent;
  entries(): readonly LoggedEvent[];
  /** Entries after `seq` — for a reader that tails the log. */
  since(seq: number): readonly LoggedEvent[];
  /** One JSON object per line. */
  toJSONL(): string;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

export interface EventLogOptions {
  /** Called with each entry as it is appended — write it to a file, a database, a socket. */
  onAppend?: (entry: LoggedEvent) => void;
  now?: () => Date;
}

export function eventLog(options: EventLogOptions = {}): EventLog {
  const list: LoggedEvent[] = [];
  const now = options.now ?? (() => new Date());
  return {
    append(event) {
      const entry = deepFreeze({ seq: list.length + 1, at: now().toISOString(), event: structuredClone(event) });
      list.push(entry);
      options.onAppend?.(entry);
      return entry;
    },
    entries: () => list.slice(),
    since: seq => list.filter(e => e.seq > seq),
    toJSONL: () => list.map(e => JSON.stringify(e)).join('\n') + (list.length ? '\n' : ''),
  };
}
