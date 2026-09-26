/**
 * Skills — guides the agent loads only when a task calls for one.
 *
 * Loaded the Agent Skills way (agentskills.io): the model sees each picked skill's name and when to
 * use it; `use_skill` brings in the full instructions and lists the reference files;
 * `read_skill_file` brings in one of those. Nothing is loaded that the task does not call for.
 *
 * Which skills a run needs is a DECISION, not a generation, so Jev makes it (`pickSkills`): one
 * choice question over every skill's description, answered in well under a second. TypeSafe
 * measured the case — an agent reading a truncated index loaded the wrong skill 16.8% of the time
 * against 7.3% when a System One model ranked them first — and it keeps the index out of the
 * prompt however many skills exist. Without a `decide`, every skill is offered.
 *
 * Reading skills and guides is preparation, not work: the loop spends no tool call on them and gives
 * the step back (see `guideTools` in the loop), because in production four guide reads once used up
 * a whole budget and the answer then dropped what the person asked for.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { ModelProvider } from './model.ts';
import type { SkillMeta, SkillSource } from './seams.ts';
import type { Toolset } from './tools.ts';

const FILE_CAP = 24_000;
const cap = (s: string) => (s.length > FILE_CAP ? `${s.slice(0, FILE_CAP)}\n…(truncated, ${s.length} characters)` : s);
const stripFrontmatter = (s: string) => s.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');

/** name and description from a SKILL.md's frontmatter (simple `key: value` lines, quotes optional). */
export function readFrontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out: Record<string, string> = {};
  if (!m?.[1]) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv?.[1]) out[kv[1]] = (kv[2] ?? '').trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
  }
  return out;
}

export interface InlineSkill {
  name: string;
  description: string;
  /** Path → content. `SKILL.md` is the instructions; everything else is a reference file. */
  files: Record<string, string>;
}

/** Skills embedded in code (generated at build time, fetched from a database…). */
export function inlineSkills(skills: InlineSkill[]): SkillSource {
  const find = (name: string) => skills.find(s => s.name === name);
  return {
    list: async () => skills.map(s => ({ name: s.name, description: s.description })),
    open: async name => {
      const s = find(name);
      return s ? { instructions: stripFrontmatter(s.files['SKILL.md'] ?? ''), files: Object.keys(s.files).filter(f => f !== 'SKILL.md') } : null;
    },
    readFile: async (name, path) => find(name)?.files[path.replace(/^\.?\//, '')] ?? null,
  };
}

function walk(dir: string, root: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, root, out);
    else out.push(relative(root, full).split(sep).join('/'));
  }
  return out;
}

/** Skills on disk: every `<dir>/<name>/SKILL.md` (Claude Code, Codex and Gemini CLI all use this layout). */
export function dirSkills(...dirs: string[]): SkillSource {
  const load = (): Map<string, { meta: SkillMeta; root: string }> => {
    const found = new Map<string, { meta: SkillMeta; root: string }>();
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir)) {
        const root = join(dir, entry);
        const file = join(root, 'SKILL.md');
        if (!existsSync(file)) continue;
        const fm = readFrontmatter(readFileSync(file, 'utf8'));
        const name = fm.name || entry;
        // The first directory that defines a name wins, so a project can override one it inherited.
        if (!found.has(name) && fm.description) found.set(name, { meta: { name, description: fm.description }, root });
      }
    }
    return found;
  };
  return {
    list: async () => [...load().values()].map(s => s.meta),
    open: async name => {
      const s = load().get(name);
      if (!s) return null;
      return { instructions: stripFrontmatter(readFileSync(join(s.root, 'SKILL.md'), 'utf8')), files: walk(s.root, s.root).filter(f => f !== 'SKILL.md') };
    },
    readFile: async (name, path) => {
      const s = load().get(name);
      const clean = path.replace(/^\.?\//, '');
      if (!s || clean.split('/').includes('..')) return null;
      const full = join(s.root, clean);
      return existsSync(full) && statSync(full).isFile() ? readFileSync(full, 'utf8') : null;
    },
  };
}

export const NO_SKILL = 'none';

/**
 * Which skills this task needs — usually none. Jev reads the message (and the last few before it)
 * against every description; a clear pick, or the two likeliest when it is torn — never "none"
 * dressed up as a skill. Without `decide`, every skill is returned. A failed decision picks none.
 */
export async function pickSkills(
  model: ModelProvider,
  skills: SkillMeta[],
  message: string,
  options: { earlier?: string[]; signal?: AbortSignal; none?: string } = {}
): Promise<{ names: string[]; cost: number }> {
  if (!skills.length) return { names: [], cost: 0 };
  if (!model.decide) return { names: skills.map(s => s.name), cost: 0 };
  const paths: Record<string, string> = {
    [NO_SKILL]: options.none ?? 'No guide is needed: the message can be handled with the tools alone. Almost every message is this.',
  };
  for (const s of skills.slice(0, 254)) paths[s.name] = s.description.slice(0, 600);
  try {
    const { answers, cost } = await model.decide(
      { message, earlier: (options.earlier ?? []).slice(-3) },
      { skill: { type: 'choice', instructions: 'Which guide does handling `message` need, if any?', criteria: paths } },
      options.signal
    );
    const a = answers.skill;
    if (a.type !== 'choice') return { names: [], cost };
    const ranked = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]);
    const names = (a.confidence >= 0.5 ? ranked.slice(0, 1) : ranked.slice(0, 2)).filter(([name, p]) => name !== NO_SKILL && p >= 0.2 && name in paths).map(([name]) => name);
    return { names, cost };
  } catch {
    return { names: [], cost: 0 };
  }
}

/** The tool names skillsToolset defines — the loop's default guide tools. */
export const SKILL_TOOLS = ['use_skill', 'read_skill_file'];

/** Tools to load the given skills (and only those). Null when there are none. */
export function skillsToolset(source: SkillSource, names: string[], options: { preface?: string } = {}): Toolset | null {
  if (!names.length) return null;
  return {
    name: 'skills',
    description: `Guides: ${names.join(', ')}. Load one when the task calls for it.`,
    tools: [
      {
        name: 'use_skill',
        description: `Load a skill's full instructions and the list of its reference files. Skills: ${names.join(', ')}.`,
        parameters: { type: 'object', properties: { name: { type: 'string', enum: names } }, required: ['name'] },
        run: async a => {
          const name = String(a.name ?? '');
          const skill = names.includes(name) ? await source.open(name) : null;
          if (!skill) throw new Error(`No skill "${name}". Skills: ${names.join(', ')}`);
          return { skill: name, ...(options.preface ? { note: options.preface } : {}), instructions: cap(skill.instructions), reference_files: skill.files };
        },
      },
      {
        name: 'read_skill_file',
        description: 'Read one reference file of a skill, as listed by use_skill.',
        parameters: { type: 'object', properties: { name: { type: 'string', enum: names }, path: { type: 'string' } }, required: ['name', 'path'] },
        run: async a => {
          const name = String(a.name ?? '');
          const path = String(a.path ?? '');
          const content = names.includes(name) ? await source.readFile(name, path) : null;
          if (content === null) {
            const skill = names.includes(name) ? await source.open(name) : null;
            throw new Error(`No file "${path}" in skill "${name}". Files: ${skill ? skill.files.join(', ') : 'unknown skill'}`);
          }
          return cap(content);
        },
      },
    ],
  };
}
