/**
 * Files — read, list, search, write and edit, confined to one root (the directory the CLI runs in).
 *
 * Reads run freely; writes and edits are CHANGES, so the core asks for approval with a one-line
 * account before they run. Every path is resolved against the root and refused if it escapes it,
 * so a model cannot read `~/.ssh` by asking for `../../.ssh`.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { AgentTool, Toolset } from '../index.ts';

const READ_CAP = 2000; // lines
const SKIP = new Set(['node_modules', '.git', 'dist', '.next', '.venv', '__pycache__']);

/** A path inside the root, or an error that says why not. */
export function inside(root: string, path: unknown): string {
  const p = String(path ?? '.').trim() || '.';
  const full = resolve(root, p);
  if (full !== root && !full.startsWith(root + sep)) throw new Error(`"${p}" is outside the working directory (${root}).`);
  return full;
}

const rel = (root: string, full: string) => relative(root, full) || '.';

function listDir(root: string, dir: string, depth: number): string[] {
  const out: string[] = [];
  const walk = (d: string, level: number) => {
    let entries: string[];
    try {
      entries = readdirSync(d).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (out.length >= 500) return;
      const full = join(d, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      const indent = '  '.repeat(level);
      if (st.isDirectory()) {
        out.push(`${indent}${name}/${SKIP.has(name) ? '  (skipped)' : ''}`);
        if (level + 1 < depth && !SKIP.has(name)) walk(full, level + 1);
      } else out.push(`${indent}${name}  ${st.size}b`);
    }
  };
  walk(dir, 0);
  if (out.length >= 500) out.push('…(truncated at 500 entries)');
  return out;
}

function ripgrep(root: string, pattern: string, path: string, glob: string | undefined, signal: AbortSignal): Promise<string> {
  return new Promise((ok, fail) => {
    const args = ['--line-number', '--no-heading', '--color=never', '--max-count=20', '--max-columns=300', ...(glob ? ['--glob', glob] : []), '--', pattern, path];
    const child = spawn('rg', args, { cwd: root, signal });
    let out = '';
    let err = '';
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (err += d));
    child.on('error', fail);
    child.on('close', code => {
      if (code === 0) ok(out);
      else if (code === 1) ok('');
      else fail(new Error(err.trim() || `rg exited with ${code}`));
    });
  });
}

export function fileToolset(root: string): Toolset {
  const tools: AgentTool[] = [
    {
      name: 'list_dir',
      description: 'List a directory in the working directory as a tree (depth 1–4, default 2). Skips node_modules, .git, dist.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, depth: { type: 'number' } } },
      run: async a => {
        const dir = inside(root, a.path);
        if (!statSync(dir).isDirectory()) throw new Error(`${rel(root, dir)} is not a directory.`);
        const depth = Math.min(4, Math.max(1, Number(a.depth) || 2));
        return `${rel(root, dir)}/\n${listDir(root, dir, depth).join('\n')}`;
      },
    },
    {
      name: 'read_file',
      description: `Read a text file, with line numbers. \`offset\` (1-based line) and \`limit\` (lines, default ${READ_CAP}) read part of a long file.`,
      parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['path'] },
      run: async a => {
        const file = inside(root, a.path);
        const lines = readFileSync(file, 'utf8').split('\n');
        const from = Math.max(1, Number(a.offset) || 1);
        const count = Math.max(1, Number(a.limit) || READ_CAP);
        const slice = lines.slice(from - 1, from - 1 + count).map((l, i) => `${String(from + i).padStart(5)}  ${l}`);
        const more = from - 1 + count < lines.length ? `\n…(${lines.length - (from - 1 + count)} more lines; read on with offset ${from + count})` : '';
        return `${rel(root, file)} (${lines.length} lines)\n${slice.join('\n')}${more}`;
      },
    },
    {
      name: 'search',
      description: 'Search file contents with a regular expression (ripgrep). Optional `path` to narrow, `glob` to filter files (e.g. "*.ts"). Returns file:line:text, at most 20 matches per file.',
      parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' } }, required: ['pattern'] },
      run: async (a, ctx) => {
        const where = inside(root, a.path);
        const out = await ripgrep(root, String(a.pattern ?? ''), rel(root, where), a.glob ? String(a.glob) : undefined, ctx.signal);
        if (!out.trim()) return 'No matches.';
        const lines = out.trim().split('\n');
        return lines.length > 300 ? `${lines.slice(0, 300).join('\n')}\n…(${lines.length - 300} more matches; narrow the search)` : lines.join('\n');
      },
    },
    {
      name: 'write_file',
      description: 'Create or overwrite a file with `content`. Asks the person first.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
      write: {
        describe: a => {
          const file = inside(root, a.path);
          const n = String(a.content ?? '').split('\n').length;
          return `${existsSync(file) ? 'Overwrite' : 'Create'} ${rel(root, file)} (${n} lines)`;
        },
      },
      run: async a => {
        const file = inside(root, a.path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, String(a.content ?? ''));
        return `Wrote ${rel(root, file)}.`;
      },
    },
    {
      name: 'edit_file',
      description: 'Replace exact text in a file: `old` must appear exactly once (or pass `all: true`). Copy `old` from read_file output without the line numbers. Asks the person first.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' }, all: { type: 'boolean' } }, required: ['path', 'old', 'new'] },
      write: {
        describe: a => {
          const file = inside(root, a.path);
          const oldText = String(a.old ?? '');
          const count = existsSync(file) ? readFileSync(file, 'utf8').split(oldText).length - 1 : 0;
          const first = (s: string) => JSON.stringify(s.split('\n')[0]!.slice(0, 60));
          return `Edit ${rel(root, file)}: replace ${a.all ? `${count} occurrence(s) of` : ''} ${first(oldText)} → ${first(String(a.new ?? ''))}`;
        },
      },
      run: async a => {
        const file = inside(root, a.path);
        const text = readFileSync(file, 'utf8');
        const oldText = String(a.old ?? '');
        if (!oldText) throw new Error('`old` is empty.');
        const count = text.split(oldText).length - 1;
        if (count === 0) throw new Error('`old` was not found. Read the file again and copy the text exactly (without line numbers).');
        if (count > 1 && !a.all) throw new Error(`\`old\` appears ${count} times. Add surrounding lines to make it unique, or pass all: true.`);
        writeFileSync(file, a.all ? text.split(oldText).join(String(a.new ?? '')) : text.replace(oldText, () => String(a.new ?? '')));
        return `Edited ${rel(root, file)} (${a.all ? count : 1} replacement${(a.all ? count : 1) > 1 ? 's' : ''}).`;
      },
    },
  ];
  return { name: 'files', description: `Files in the working directory (${root}).`, tools };
}

