/**
 * A scrollable list in the terminal: ↑/↓ (or Ctrl+P/N) to move, PgUp/PgDn and Home/End to jump, type to
 * filter, Enter to choose, Esc to cancel. Zero dependencies: raw-mode stdin and a few ANSI codes.
 *
 * It redraws in place (cursor up, clear to end), so the transcript above is left alone, and it always
 * restores the terminal (raw mode off, cursor shown) however it ends.
 */
import { emitKeypressEvents } from 'node:readline';

export interface Item<T> {
  /** The main text, matched by the filter. */
  label: string;
  /** Dimmer text after it, also matched by the filter. */
  detail?: string;
  /** Shown at the right: a price, a mark. */
  aside?: string;
  value: T;
}

export interface PickOptions {
  title: string;
  /** The item to start on (by index into `items`). */
  initial?: number;
  /** Rows of the list shown at once. Default: fits the terminal, at most 12. */
  rows?: number;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

interface Key {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
}

const ESC = '\x1b[';
const dim = (s: string) => `${ESC}2m${s}${ESC}0m`;
const inverse = (s: string) => `${ESC}7m${s}${ESC}0m`;
const bold = (s: string) => `${ESC}1m${s}${ESC}0m`;

/** Case-insensitive, every word must appear in the label or the detail. */
export function filterItems<T>(items: Item<T>[], query: string): Item<T>[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length ? items.filter(i => words.every(w => `${i.label} ${i.detail ?? ''}`.toLowerCase().includes(w))) : items;
}

/** The first row to draw so `cursor` is visible in a window of `rows`. */
export function windowStart(cursor: number, start: number, rows: number, total: number): number {
  if (cursor < start) return cursor;
  if (cursor >= start + rows) return cursor - rows + 1;
  return Math.max(0, Math.min(start, total - rows));
}

export function pick<T>(items: Item<T>[], options: PickOptions): Promise<T | null> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (!input.isTTY) return Promise.resolve(null);
  const width = Math.max(40, (output.columns ?? 100) - 2);
  const rows = options.rows ?? Math.max(3, Math.min(12, (output.rows ?? 24) - 6));

  let query = '';
  let shown = items;
  let cursor = Math.max(0, Math.min(items.length - 1, options.initial ?? 0));
  let start = 0;
  let drawn = 0;

  const fit = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s.padEnd(n));
  const draw = () => {
    const lines: string[] = [];
    lines.push(`${bold(options.title)} ${dim('↑↓ move · type to filter · Enter choose · Esc cancel')}`);
    lines.push(query ? `  filter: ${query}${dim('▏')}` : dim('  filter: (type)'));
    start = windowStart(cursor, start, rows, shown.length);
    const slice = shown.slice(start, start + rows);
    if (!slice.length) lines.push(dim('  no match'));
    const labelW = Math.min(28, Math.max(...shown.map(i => i.label.length), 8));
    slice.forEach((item, k) => {
      const i = start + k;
      const aside = item.aside ?? '';
      const detailW = Math.max(0, width - labelW - aside.length - 6);
      const label = fit(item.label, labelW);
      const detail = fit(item.detail ?? '', detailW);
      lines.push(i === cursor ? `${bold('›')} ${inverse(`${label}  ${detail} ${aside}`)}` : `  ${label}  ${dim(detail)} ${aside}`);
    });
    const more = shown.length - rows;
    lines.push(dim(more > 0 ? `  ${cursor + 1}/${shown.length}` : ' '));
    if (drawn) output.write(`${ESC}${drawn}A`);
    output.write(`\r${ESC}0J${lines.join('\n')}\n`);
    drawn = lines.length;
  };

  return new Promise(resolve => {
    emitKeypressEvents(input);
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    output.write(`${ESC}?25l`);

    const done = (value: T | null) => {
      input.off('keypress', onKey);
      input.setRawMode(wasRaw);
      input.pause();
      if (drawn) output.write(`${ESC}${drawn}A\r${ESC}0J`);
      output.write(`${ESC}?25h`);
      resolve(value);
    };

    const refilter = () => {
      shown = filterItems(items, query);
      cursor = 0;
      start = 0;
    };

    const onKey = (str: string | undefined, key: Key = {}) => {
      if ((key.ctrl && key.name === 'c') || key.name === 'escape') return done(null);
      if (key.name === 'return' || key.name === 'enter') return done(shown[cursor]?.value ?? null);
      if (key.name === 'up' || (key.ctrl && key.name === 'p')) cursor = Math.max(0, cursor - 1);
      else if (key.name === 'down' || (key.ctrl && key.name === 'n')) cursor = Math.min(shown.length - 1, cursor + 1);
      else if (key.name === 'pageup') cursor = Math.max(0, cursor - rows);
      else if (key.name === 'pagedown') cursor = Math.min(shown.length - 1, cursor + rows);
      else if (key.name === 'home') cursor = 0;
      else if (key.name === 'end') cursor = Math.max(0, shown.length - 1);
      else if (key.name === 'backspace') {
        query = query.slice(0, -1);
        refilter();
      } else if (str && !key.ctrl && !key.meta && str.length === 1 && str >= ' ') {
        query += str;
        refilter();
      } else return;
      draw();
    };

    input.on('keypress', onKey);
    draw();
  });
}
