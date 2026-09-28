// Markdown in the terminal: tables, inline styles, blocks, streaming in pieces, wide characters.
import assert from 'node:assert/strict';
import { cells, inline, markdownStream, renderMarkdown, stripAnsi, styles, visibleWidth, wrapAnsi } from '../src/cli/markdown.ts';

let n = 0;
const ok = (what: string) => console.log(`ok · ${++n} ${what}`);
const plain = (md: string, width = 80) => renderMarkdown(md, { color: false, width });

// 1 · a table: boxed, header, alignment from the separator row
{
  const out = plain('| Model | Price | Notes |\n|:--|--:|:-:|\n| GLM 5.3 Flash | $0.50 | cheap |\n| Claude Sonnet 5 | $10.00 | strong |\n');
  assert.equal(
    out,
    [
      '┌─────────────────┬────────┬────────┐',
      '│ Model           │ Price  │ Notes  │',
      '├─────────────────┼────────┼────────┤',
      '│ GLM 5.3 Flash   │  $0.50 │ cheap  │',
      '│ Claude Sonnet 5 │ $10.00 │ strong │',
      '└─────────────────┴────────┴────────┘',
      '',
    ].join('\n')
  );
  ok('table: box, header, left/right/center');
}

// 2 · too wide: the widest column shrinks and its cells wrap inside the column
{
  const long = 'a fairly long description that will not fit in a narrow terminal at all';
  const out = plain(`| Key | Description |\n|---|---|\n| k1 | ${long} |\n`, 40);
  const lines = out.trimEnd().split('\n');
  assert.ok(lines.every(l => visibleWidth(l) <= 40), `every line fits 40:\n${out}`);
  assert.ok(lines.length > 5, 'the long cell wrapped onto several lines');
  assert.equal(stripAnsi(lines.slice(3, -1).map(l => l.split('│')[2]!.trim()).join(' ')), long, 'nothing lost in the wrap');
  ok('table fits the width, cells wrap');
}

// 3 · cells: escaped pipes and pipes inside code spans stay in the cell; missing cells are empty
{
  assert.deepEqual(cells('| a \\| b | `x | y` | c |'), ['a | b', '`x | y`', 'c']);
  const out = plain('| a | b |\n|---|---|\n| only one |\n');
  assert.match(out, /│ only one │ +│/);
  ok('cells');
}

// 4 · inline styles (with colour), and code spans are literal
{
  const st = styles(true);
  const s = inline('**bold** and *it* and `**not bold**` and ~~gone~~ and [site](https://x.dev) and snake_case_name', st);
  assert.ok(s.includes('\x1b[1mbold\x1b[22m'));
  assert.ok(s.includes('\x1b[3mit\x1b[23m'));
  assert.ok(s.includes('\x1b[36m**not bold**\x1b[39m'), 'inside backticks nothing is formatted');
  assert.ok(s.includes('\x1b[9mgone\x1b[29m'));
  assert.equal(stripAnsi(s), 'bold and it and **not bold** and gone and site (https://x.dev) and snake_case_name', 'snake_case is not italic');
  ok('inline');
}

// 5 · blocks: headings, bullets, tasks, numbers, quotes, rules, code fences
{
  const out = plain('# Title\n- one\n  - nested\n- [ ] todo\n- [x] done\n1. first\n> quoted\n---\n```ts\nconst x = **1**;\n```\nafter\n', 20);
  assert.equal(out, 'Title\n• one\n  • nested\n☐ todo\n☑ done\n1. first\n│ quoted\n' + '─'.repeat(20) + '\n╭─ ts\n│ const x = **1**;\nafter\n');
  ok('blocks');
}

// 6 · streaming: the same output whatever the pieces; a table waits for its last row
{
  const md = 'Here:\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nDone **now**.';
  const whole = plain(md);
  let pieces = '';
  const s = markdownStream(t => (pieces += t), { color: false, width: () => 80 });
  const seenBeforeEnd: string[] = [];
  for (const ch of md) {
    s.push(ch);
    seenBeforeEnd.push(pieces);
  }
  assert.ok(!seenBeforeEnd.some(p => p.includes('│ 1')) || seenBeforeEnd.at(-1)!.includes('│ 1'));
  assert.ok(!pieces.includes('Done'), 'a line shows once it is complete');
  s.flush();
  assert.equal(pieces, whole);
  assert.ok(!s.pending());
  ok('streaming in pieces = whole');
}

// 7 · width: wide characters count double; wrap keeps styles across breaks
{
  assert.equal(visibleWidth('日本'), 4);
  assert.equal(visibleWidth('\x1b[1mab\x1b[22m'), 2);
  const wrapped = wrapAnsi('\x1b[1mone two three\x1b[22m', 7);
  assert.deepEqual(wrapped.map(stripAnsi), ['one two', 'three']);
  assert.ok(wrapped[1]!.startsWith('\x1b[1m'), 'bold reopened on the next line');
  assert.equal(plain('| 名前 | x |\n|---|---|\n| 日本語 | y |\n').split('\n')[1], '│ 名前   │ x │');
  ok('wide characters + ANSI-aware wrap');
}

console.log(`${n} cases`);
