/**
 * What the person sees: the agent's events as terminal lines, with plain ANSI (no dependency).
 *
 * The CLI is a test bench, so it shows the engine's inner life that an app would hide: every tool
 * call and result, every Jev checkpoint with its probability and what the loop did, level changes,
 * nudges, and each turn's status, steps and cost.
 */
import type { AgentEvent, AgentResult } from '../index.ts';

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = {
  dim: paint('2'),
  bold: paint('1'),
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  blue: paint('34'),
  magenta: paint('35'),
  cyan: paint('36'),
};

const short = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
};

export interface Printer {
  (event: AgentEvent): void;
  /** Whether text has been streamed since the last newline. */
  midLine(): boolean;
}

export function printer(write: (s: string) => void, options: { stream: boolean; verbose: boolean }): Printer {
  let mid = false;
  const line = (s: string) => {
    if (mid) write('\n');
    mid = false;
    write(`${s}\n`);
  };
  const print = ((e: AgentEvent) => {
    switch (e.type) {
      case 'delta':
        if (options.stream) {
          write(e.text);
          mid = !e.text.endsWith('\n');
        }
        return;
      case 'message':
        if (!options.stream) line(e.text);
        return;
      case 'skills':
        if (e.names.length) line(c.cyan(`· skills picked by Jev: ${e.names.join(', ')}`));
        return;
      case 'opening':
        if (e.path !== 'task') line(c.cyan(`· Jev: ${e.path} (${e.confidence.toFixed(2)})`));
        return;
      case 'tool_call':
        line(c.blue(`→ ${e.name}`) + c.dim(` ${short(JSON.stringify(e.args), 140)}`));
        return;
      case 'tool_result':
        line(`  ${e.ok ? c.green('✓') : c.red('✗')} ${c.dim(short(e.result, options.verbose ? 600 : 120))}`);
        return;
      case 'checkpoint': {
        const p = e.p === null ? '—' : e.p.toFixed(2);
        const what = e.choice ? `${e.choice} ` : '';
        const col = e.action === 'pass' || e.action === 'none' ? c.dim : c.magenta;
        line(col(`· Jev ${e.at} ${what}p=${p} → ${e.action} [${e.level}]`));
        return;
      }
      case 'guidance':
        line(c.magenta(`· guidance ${e.from ?? 'start'} → ${e.level} (${e.reason})`));
        return;
      case 'nudge':
        line(c.yellow(`↺ ${short(e.reason, 160)}`));
        return;
      case 'hook':
        if (e.verdict !== 'go') line(c.yellow(`· ${e.hook}: ${e.verdict}${e.reason ? ` (${e.reason})` : ''}`));
        return;
      case 'context':
        if (options.verbose && e.transient) line(c.dim(`  [said to the model] ${short(String(e.message.content ?? ''), 200)}`));
        return;
      default:
        return;
    }
  }) as Printer;
  print.midLine = () => mid;
  return print;
}

export function summary(r: AgentResult, total: number): string {
  const tone = r.status === 'done' || r.status === 'greeted' || r.status === 'chatted' ? c.green : r.status === 'needs_person' || r.status === 'paused' ? c.yellow : c.red;
  return c.dim(`${tone(r.status)} · ${r.steps} steps · ${r.toolCalls} tool calls · $${r.cost.toFixed(5)} (session $${total.toFixed(5)})${r.reason ? ` · ${r.reason}` : ''}`);
}
