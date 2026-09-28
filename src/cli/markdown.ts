/**
 * Markdown for the terminal, rendered as it streams — tables, headings, emphasis, code, lists.
 *
 * Models answer in markdown; printed raw, a table is a wall of pipes. This renders it the way
 * opencode and Claude Code do, with no dependency:
 *   - text streams LINE by line (a line is shown once it is complete, so its formatting is known);
 *   - a table is held until its last row, then drawn with box characters, columns aligned as the
 *     separator row says, fitted to the terminal width (widest columns shrink, cells wrap inside);
 *   - a fenced code block is shown with a gutter and no inline formatting.
 * Without colour (NO_COLOR, piped output) the layout stays and only the ANSI styling goes.
 */

export interface Styles {
  bold(s: string): string;
  italic(s: string): string;
  dim(s: string): string;
  underline(s: string): string;
  strike(s: string): string;
  code(s: string): string;
  heading(s: string, level: number): string;
}

const sgr = (on: string, off: string) => (s: string) => `\x1b[${on}m${s}\x1b[${off}m`;

export function styles(color: boolean): Styles {
  if (!color) {
    const id = (s: string) => s;
    return { bold: id, italic: id, dim: id, underline: id, strike: id, code: id, heading: s => s };
  }
  const bold = sgr('1', '22');
  return {
    bold,
    italic: sgr('3', '23'),
    dim: sgr('2', '22'),
    underline: sgr('4', '24'),
    strike: sgr('9', '29'),
    code: sgr('36', '39'),
    heading: (s, level) => (level <= 2 ? bold(sgr('36', '39')(s)) : bold(s)),
  };
}

// ── width ───────────────────────────────────────────────────────────────────

const ANSI = /\x1b\[[0-9;]*m/g;
export const stripAnsi = (s: string) => s.replace(ANSI, '');

/** Columns a code point takes: 2 for wide (CJK, emoji), 0 for combining marks, else 1. */
function cpWidth(cp: number): number {
  if (cp === 0x200d || (cp >= 0x300 && cp <= 0x36f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2;
  return 1;
}

export function visibleWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) w += cpWidth(ch.codePointAt(0)!);
  return w;
}

/**
 * Greedy word wrap on visible width, carrying ANSI codes through: a style open at a break is closed
 * at the end of the line and reopened on the next. A word longer than the width is cut.
 */
export function wrapAnsi(s: string, width: number): string[] {
  if (width <= 0) return [s];
  const lines: string[] = [];
  let line = '';
  let lineW = 0;
  let open: string[] = [];
  let lastSpace = -1; // index in `line` just after the last space
  let wAtSpace = 0;
  const tokens = s.split(/(\x1b\[[0-9;]*m)/).filter(Boolean);
  const reset = () => (open.length ? '\x1b[0m' : '');
  const reopen = () => open.join('');
  const breakAt = (cut: number, cutW: number) => {
    const head = line.slice(0, cut).replace(/ +$/, '');
    const tail = line.slice(cut);
    lines.push(head + reset());
    line = reopen() + tail;
    lineW = lineW - cutW;
    lastSpace = -1;
  };
  for (const t of tokens) {
    if (t.startsWith('\x1b[')) {
      line += t;
      const code = t.slice(2, -1);
      if (code === '0' || code === '') open = [];
      else if (/^(22|23|24|29|39)$/.test(code)) open = open.filter(o => !closes(code, o));
      else open.push(t);
      continue;
    }
    for (const ch of t) {
      const w = cpWidth(ch.codePointAt(0)!);
      if (lineW + w > width) {
        if (ch === ' ') {
          breakAt(line.length, lineW);
          continue;
        }
        if (lastSpace > 0) breakAt(lastSpace, wAtSpace);
        else breakAt(line.length, lineW);
      }
      line += ch;
      lineW += w;
      if (ch === ' ') {
        lastSpace = line.length;
        wAtSpace = lineW;
      }
    }
  }
  lines.push(line);
  return lines;
}

function closes(code: string, open: string): boolean {
  const o = open.slice(2, -1);
  if (code === '22') return o === '1' || o === '2';
  if (code === '23') return o === '3';
  if (code === '24') return o === '4';
  if (code === '29') return o === '9';
  return /^3\d$/.test(o); // 39: default foreground
}

// ── inline ──────────────────────────────────────────────────────────────────

/** **bold**, *italic* / _italic_, `code`, ~~strike~~, [text](url), <https://…>. Code spans are literal. */
export function inline(text: string, st: Styles): string {
  const parts = text.split(/(`+)([\s\S]*?)\1/);
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 3 === 0) out += emphasis(parts[i] ?? '', st);
    else if (i % 3 === 2) out += st.code(parts[i] ?? '');
  }
  return out;
}

function emphasis(s: string, st: Styles): string {
  return s
    .replace(/\[([^\]]+)\]\((\S+?)(?:\s+"[^"]*")?\)/g, (_, t: string, url: string) => `${st.underline(t)}${url === t ? '' : st.dim(` (${url})`)}`)
    .replace(/<(https?:\/\/[^>\s]+)>/g, (_, url: string) => st.underline(url))
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__/g, (_, a?: string, b?: string) => st.bold(a ?? b ?? ''))
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, (_, a: string) => st.strike(a))
    .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\w)/g, (_, pre: string, a: string) => pre + st.italic(a))
    .replace(/(^|[^\w_])_(?=\S)([^_]*?\S)_(?!\w)/g, (_, pre: string, a: string) => pre + st.italic(a));
}

// ── blocks ──────────────────────────────────────────────────────────────────

const TABLE_ROW = /^\s*\|.*\|\s*$|^\s*[^|`]+(\s*\|\s*[^|`]*)+\|?\s*$/;
const SEPARATOR = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/** Cells of a table row: split on unescaped pipes outside code spans. */
export function cells(row: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inCode = false;
  const s = row.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (ch === '`') {
      inCode = !inCode;
      cur += ch;
    } else if (ch === '|' && !inCode) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

type Align = 'left' | 'center' | 'right';

const pad = (s: string, w: number, align: Align) => {
  const gap = Math.max(0, w - visibleWidth(s));
  if (align === 'right') return ' '.repeat(gap) + s;
  if (align === 'center') return ' '.repeat(Math.floor(gap / 2)) + s + ' '.repeat(Math.ceil(gap / 2));
  return s + ' '.repeat(gap);
};

/** A markdown table as box-drawn lines fitted to `width`, or null if these lines are not a table. */
export function renderTable(lines: string[], width: number, st: Styles): string[] | null {
  if (lines.length < 2 || !SEPARATOR.test(lines[1]!) || !lines[1]!.includes('-')) return null;
  const head = cells(lines[0]!);
  const aligns: Align[] = cells(lines[1]!).map(c => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left'));
  const body = lines.slice(2).map(cells);
  const n = Math.max(head.length, ...body.map(r => r.length));
  const rows = [head, ...body].map(r => Array.from({ length: n }, (_, i) => inline(r[i] ?? '', st)));
  rows[0] = rows[0]!.map(c => st.bold(c));

  // Natural widths, then shrink the widest column until the table fits (│ c │ c │ = 3n+1 extra).
  const widths = Array.from({ length: n }, (_, i) => Math.max(1, ...rows.map(r => visibleWidth(r[i]!))));
  const budget = Math.max(n * 3, width - (3 * n + 1));
  while (widths.reduce((a, b) => a + b, 0) > budget) {
    const i = widths.indexOf(Math.max(...widths));
    if (widths[i]! <= 3) break;
    widths[i]!--;
  }

  const rule = (l: string, m: string, r: string) => st.dim(l + widths.map(w => '─'.repeat(w + 2)).join(m) + r);
  const out = [rule('┌', '┬', '┐')];
  rows.forEach((row, k) => {
    const wrapped = row.map((cell, i) => wrapAnsi(cell, widths[i]!));
    const height = Math.max(...wrapped.map(w => w.length));
    for (let h = 0; h < height; h++) {
      out.push(st.dim('│') + wrapped.map((w, i) => ` ${pad(w[h] ?? '', widths[i]!, k === 0 ? 'left' : (aligns[i] ?? 'left'))} `).join(st.dim('│')) + st.dim('│'));
    }
    if (k === 0) out.push(rule('├', '┼', '┤'));
  });
  out.push(rule('└', '┴', '┘'));
  return out;
}

/** One line outside tables and code blocks. */
export function renderLine(line: string, width: number, st: Styles): string {
  const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
  if (h) return st.heading(inline(h[2]!, st), h[1]!.length);
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return st.dim('─'.repeat(Math.min(width, 80)));
  const quote = /^(\s*)>\s?(.*)$/.exec(line);
  if (quote) return `${quote[1]}${st.dim('│')} ${st.italic(inline(quote[2]!, st))}`;
  const task = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
  if (task) return `${task[1]}${task[2] === ' ' ? '☐' : st.dim('☑')} ${inline(task[3]!, st)}`;
  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (bullet) return `${bullet[1]}${st.dim('•')} ${inline(bullet[2]!, st)}`;
  const num = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
  if (num) return `${num[1]}${st.dim(`${num[2]}.`)} ${inline(num[3]!, st)}`;
  return inline(line, st);
}

// ── the stream ──────────────────────────────────────────────────────────────

export interface MarkdownStream {
  /** Text as it arrives, in any pieces. */
  push(text: string): void;
  /** The end of a message: render what is held (a last line without newline, an open table). */
  flush(): void;
  /** Whether anything is held back. */
  pending(): boolean;
}

export function markdownStream(write: (s: string) => void, options: { color: boolean; width: () => number }): MarkdownStream {
  const st = styles(options.color);
  let partial = '';
  let table: string[] = [];
  let fence: { marker: string } | null = null;

  const emit = (s: string) => write(`${s}\n`);
  const flushTable = () => {
    if (!table.length) return;
    const drawn = renderTable(table, options.width(), st);
    for (const l of drawn ?? table.map(t => renderLine(t, options.width(), st))) emit(l);
    table = [];
  };
  const handle = (line: string) => {
    if (fence) {
      if (line.trim().startsWith(fence.marker)) {
        fence = null;
        return;
      }
      emit(`${st.dim('│')} ${st.code(line)}`);
      return;
    }
    const open = /^\s*(`{3,}|~{3,})\s*(\S*)/.exec(line);
    if (open) {
      flushTable();
      fence = { marker: open[1]! };
      if (open[2]) emit(st.dim(`╭─ ${open[2]}`));
      return;
    }
    // A table: rows start with a pipe; hold them until the table ends.
    if (/^\s*\|/.test(line) || (table.length && TABLE_ROW.test(line))) {
      table.push(line);
      return;
    }
    flushTable();
    emit(renderLine(line, options.width(), st));
  };

  return {
    push(text) {
      partial += text;
      let i;
      while ((i = partial.indexOf('\n')) >= 0) {
        handle(partial.slice(0, i).replace(/\r$/, ''));
        partial = partial.slice(i + 1);
      }
    },
    flush() {
      if (partial) {
        handle(partial);
        partial = '';
      }
      flushTable();
      fence = null;
    },
    pending: () => partial.length > 0 || table.length > 0,
  };
}

/** A whole markdown text, rendered (for non-streamed messages and tests). */
export function renderMarkdown(text: string, options: { color: boolean; width: number }): string {
  let out = '';
  const m = markdownStream(s => (out += s), { color: options.color, width: () => options.width });
  m.push(text);
  m.flush();
  return out;
}
