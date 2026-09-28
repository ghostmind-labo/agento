/**
 * What the person sees: the agent's events as terminal lines, with plain ANSI (no dependency).
 *
 * The CLI is a test bench, so it shows the engine's inner life that an app would hide: every tool
 * call and result, every Jev checkpoint with its probability and what the loop did, level changes,
 * nudges, and each turn's status, steps and cost.
 */
import type { AgentEvent, AgentResult } from '../index.ts';
import { markdownStream, renderMarkdown } from './markdown.ts';

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

/** How much of the engine's work is shown. */
export type Style = 'minimal' | 'normal' | 'verbose';
export const STYLES: Style[] = ['minimal', 'normal', 'verbose'];
export const isStyle = (s: unknown): s is Style => STYLES.includes(s as Style);

export interface Printer {
  (event: AgentEvent): void;
  /** Render whatever text is held back (before a prompt, or at the end of a turn). */
  flush(): void;
  style: Style;
}

/** A tool call in a few words: its name and its main argument, not its JSON. */
export function describeCall(name: string, args: Record<string, unknown>): string {
  if (typeof args.action === 'string') return `${name}.${args.action}`;
  const key = ['pattern', 'command', 'path', 'query', 'url', 'name', 'goal', 'id'].find(k => typeof args[k] === 'string' && args[k]);
  let what = key ? String(args[key]) : '';
  if (name === 'search' && typeof args.path === 'string' && key === 'pattern') what = `"${what}" in ${args.path}`;
  else if (name === 'search' && key === 'pattern') what = `"${what}"`;
  return what ? `${name} ${short(what, 80)}` : name;
}

/**
 * Three styles:
 *   minimal  the answers; approvals and failures still show (they need you or explain a gap)
 *   normal   + one short line per tool call (the default)
 *   verbose  + every result, every Jev checkpoint with its probability and level, level changes,
 *            nudges, what was said to the model, and each turn's steps and cost
 * Jev works in every style; only verbose shows its scoring.
 */
export function printer(write: (s: string) => void, options: { stream: boolean; style: Style; color?: boolean; width?: () => number }): Printer {
  const color = options.color ?? tty;
  const width = options.width ?? (() => Math.max(40, (process.stdout.columns ?? 100) - 1));
  // The answer is markdown: rendered line by line as it streams (tables once complete).
  const md = markdownStream(write, { color, width });
  let afterTools = false;
  const line = (s: string) => {
    md.flush();
    write(`${s}\n`);
  };
  const activity = (s: string) => {
    line(s);
    afterTools = true;
  };
  const print = ((e: AgentEvent) => {
    const v = print.style === 'verbose';
    const calls = print.style !== 'minimal';
    switch (e.type) {
      case 'delta':
        if (options.stream) {
          // A blank line between the tool activity and the words that follow it.
          if (afterTools) {
            md.flush();
            write('\n');
          }
          afterTools = false;
          md.push(e.text);
        }
        return;
      case 'message':
        // The model's words are complete: render what the stream still holds (or all of it).
        if (options.stream) md.flush();
        else write(renderMarkdown(e.text, { color, width: width() }));
        return;
      case 'finished':
        md.flush();
        return;
      case 'skills':
        if (calls && e.names.length) activity(c.dim(`  · using skill ${e.names.join(', ')}`));
        return;
      case 'opening':
        if (v && e.path !== 'task') activity(c.cyan(`· Jev: ${e.path} (${e.confidence.toFixed(2)})`));
        return;
      case 'tool_call':
        // Whatever the style, words after a tool call start on their own line.
        afterTools = true;
        if (v) activity(c.blue(`→ ${e.name}`) + c.dim(` ${short(JSON.stringify(e.args), 140)}`));
        else if (calls) activity(c.dim(`  · ${describeCall(e.name, e.args)}`));
        return;
      case 'tool_result':
        if (v) activity(`  ${e.ok ? c.green('✓') : c.red('✗')} ${c.dim(short(e.result, 600))}`);
        else if (!e.ok) activity(`    ${c.red('✗')} ${c.dim(short(e.result.replace(/^Error: /, ''), 110))}`);
        return;
      case 'checkpoint': {
        if (!v) return;
        const p = e.p === null ? '—' : e.p.toFixed(2);
        const col = e.action === 'pass' || e.action === 'none' ? c.dim : c.magenta;
        activity(col(`· Jev ${e.at} ${e.choice ? `${e.choice} ` : ''}p=${p} → ${e.action} [${e.level}]`));
        return;
      }
      case 'guidance':
        if (v) activity(c.magenta(`· guidance ${e.from ?? 'start'} → ${e.level} (${e.reason})`));
        return;
      case 'nudge':
        if (v) activity(c.yellow(`↺ ${short(e.reason, 160)}`));
        return;
      case 'hook':
        if (calls && e.verdict !== 'go') activity(c.yellow(`  · ${e.hook}: ${e.verdict}${e.reason ? ` (${e.reason})` : ''}`));
        return;
      case 'context':
        // Only the unusual lines (steers, "answer now"), not the routine per-step reminder.
        if (v && e.transient && !String(e.message.content ?? '').startsWith('Current request:')) activity(c.dim(`  [said to the model] ${short(String(e.message.content ?? ''), 200)}`));
        return;
      default:
        return;
    }
  }) as Printer;
  print.flush = () => md.flush();
  print.style = options.style;
  return print;
}

/**
 * After a turn. minimal/normal: nothing when it simply finished; the status and why when it did not.
 * verbose: status, steps, tool calls and cost every time.
 */
export function summary(r: AgentResult, total: number, style: Style): string {
  const verbose = style === 'verbose';
  const fine = r.status === 'done' || r.status === 'greeted' || r.status === 'chatted';
  if (!verbose) return fine ? '' : c.yellow(`(${r.status.replace('_', ' ')}${r.reason ? `: ${r.reason}` : ''})`);
  const tone = fine ? c.green : r.status === 'needs_person' || r.status === 'paused' ? c.yellow : c.red;
  return c.dim(`${tone(r.status)} · ${r.steps} steps · ${r.toolCalls} tool calls · $${r.cost.toFixed(5)} (session $${total.toFixed(5)})${r.reason ? ` · ${r.reason}` : ''}`);
}
