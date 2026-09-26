// Skills: sources, Jev's pick, the two loading tools, and guide reads inside the loop.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirSkills, inlineSkills, pickSkills, readFrontmatter, runAgent, scriptedModel, skillsToolset, type Answer, type Question } from '../src/index.ts';

let n = 0;
const ok = (what: string) => console.log(`ok · ${++n} ${what}`);
const ctx = { signal: new AbortController().signal, spend: () => {}, callId: 'c' };

const charts = { name: 'charts', description: 'How to draw a chart.', files: { 'SKILL.md': '---\nname: charts\ndescription: How to draw a chart.\n---\n# Charts\nUse bars.', 'references/colors.md': 'Blue first.' } };
const tables = { name: 'tables', description: 'How to lay out a table.', files: { 'SKILL.md': '# Tables' } };

// 1 · frontmatter + inline source
{
  assert.deepEqual(readFrontmatter('---\nname: "a"\ndescription: Does b.\n---\nbody'), { name: 'a', description: 'Does b.' });
  const src = inlineSkills([charts, tables]);
  assert.deepEqual((await src.list()).map(s => s.name), ['charts', 'tables']);
  assert.deepEqual(await src.open('charts'), { instructions: '# Charts\nUse bars.', files: ['references/colors.md'] });
  assert.equal(await src.readFile('charts', './references/colors.md'), 'Blue first.');
  ok('inlineSkills');
}

// 2 · a directory source; the first directory wins a name; no escaping the skill folder
{
  const a = mkdtempSync(join(tmpdir(), 'skills-a-'));
  const b = mkdtempSync(join(tmpdir(), 'skills-b-'));
  for (const [dir, body] of [[a, 'project version'], [b, 'global version']] as const) {
    mkdirSync(join(dir, 'charts', 'references'), { recursive: true });
    writeFileSync(join(dir, 'charts', 'SKILL.md'), `---\nname: charts\ndescription: Charts.\n---\n${body}`);
    writeFileSync(join(dir, 'charts', 'references', 'c.md'), 'ref');
  }
  const src = dirSkills(a, b);
  assert.equal((await src.list()).length, 1);
  assert.equal((await src.open('charts'))!.instructions, 'project version');
  assert.deepEqual((await src.open('charts'))!.files, ['references/c.md']);
  assert.equal(await src.readFile('charts', '../../etc/passwd'), null);
  ok('dirSkills');
}

// 3 · Jev picks: a clear pick, two when torn, never "none"; all skills without decide
{
  const say = (probabilities: Record<string, number>, confidence: number) => scriptedModel([], { decide: () => ({ skill: { type: 'choice', choice: Object.keys(probabilities)[0]!, confidence, probabilities } as Answer }) });
  const list = [charts, tables];
  assert.deepEqual((await pickSkills(say({ charts: 0.9, none: 0.05, tables: 0.05 }, 0.9), list, 'draw')).names, ['charts']);
  assert.deepEqual((await pickSkills(say({ charts: 0.4, tables: 0.35, none: 0.25 }, 0.4), list, 'draw')).names, ['charts', 'tables']);
  assert.deepEqual((await pickSkills(say({ none: 0.9, charts: 0.1 }, 0.9), list, 'hi')).names, []);
  assert.deepEqual((await pickSkills(scriptedModel([], { decide: false }), list, 'x')).names, ['charts', 'tables']);
  ok('pickSkills');
}

// 4 · the loading tools
{
  const set = skillsToolset(inlineSkills([charts]), ['charts'], { preface: 'Adapted.' })!;
  const [use, read] = set.tools;
  assert.deepEqual(await use!.run({ name: 'charts' }, ctx), { skill: 'charts', note: 'Adapted.', instructions: '# Charts\nUse bars.', reference_files: ['references/colors.md'] });
  assert.equal(await read!.run({ name: 'charts', path: 'references/colors.md' }, ctx), 'Blue first.');
  await assert.rejects(read!.run({ name: 'charts', path: 'nope.md' }, ctx), /Files: references\/colors\.md/);
  assert.equal(skillsToolset(inlineSkills([charts]), []), null);
  ok('skillsToolset');
}

// 5 · in the loop: picked skills are indexed in the system prompt and reading them costs no tool call
{
  const decide = (_s: unknown, q: Record<string, Question>) => {
    const out: Record<string, Answer> = {};
    for (const [id, qq] of Object.entries(q)) {
      if (qq.type !== 'choice') { out[id] = { type: 'noul', noul: 0.7 }; continue; }
      const keys = Object.keys(qq.criteria);
      const pick = keys.includes('charts') ? 'charts' : keys.includes('task') ? 'task' : keys[0]!;
      out[id] = { type: 'choice', choice: pick, confidence: 0.9, probabilities: Object.fromEntries(keys.map(k => [k, k === pick ? 0.9 : 0.1 / (keys.length - 1)])) };
    }
    return out;
  };
  const provider = scriptedModel([{ calls: [{ name: 'use_skill', args: { name: 'charts' } }] }, 'Here is a bar chart.'], { decide });
  const events: string[] = [];
  const r = await runAgent({ provider, task: { goal: 'Draw my sales', expectation: 'A chart.' }, skills: inlineSkills([charts, tables]), onEvent: e => void (e.type === 'skills' && events.push(e.names.join(','))) });
  assert.deepEqual(events, ['charts']);
  assert.match(String(r.messages[0]!.content), /- charts: How to draw a chart\./);
  assert.ok(!String(r.messages[0]!.content).includes('tables'));
  assert.equal(r.toolCalls, 0);
  assert.equal(r.status, 'done');
  ok('skills in the loop');
}

console.log(`${n} cases`);
