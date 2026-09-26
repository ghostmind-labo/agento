// Jev offered to the worker (ask_jev) and behind the hooks (jevStopCheck, jevToolGate). Offline.
import assert from 'node:assert/strict';
import { askJevTool, askModelTool, eventLog, jevStopCheck, jevToolGate, runAgent, scriptedModel, type AgentTool, type Answer, type Question } from '../src/index.ts';

let n = 0;
const ok = (what: string) => console.log(`ok · ${++n} ${what}`);
const task = { goal: 'Tag the note as travel.', expectation: 'Say which tag.' };
const spent: number[] = [];
const ctx = { signal: new AbortController().signal, spend: (u: number) => void spent.push(u), callId: 'c' };

// 1 · ask_jev: each kind, forgiving options, cost reported
{
  const provider = scriptedModel([], {
    decideCost: 0.00002,
    decide: (_s, q) => {
      const x = q.q!;
      if (x.type === 'noul') return { q: { type: 'noul', noul: 0.91234 } };
      if (x.type === 'choice') return { q: { type: 'choice', choice: 'travel', confidence: 0.8, probabilities: { travel: 0.8, trips: 0.2 } } };
      return { q: { type: 'score', score: 1.5, confidence: 0.7, probabilities: { '0': 0.2, '1': 0.3, '2': 0.5 }, legend: { '0': 'low' } } };
    },
  });
  const t = askJevTool(provider);
  assert.deepEqual(await t.run({ question: 'Is it?', state: 'x', kind: 'yes_no' }, ctx), { yes: 0.912 });
  assert.deepEqual(await t.run({ question: 'Which?', state: 'x', kind: 'choice', options: '["travel","trips"]' }, ctx), { choice: 'travel', confidence: 0.8, probabilities: { travel: 0.8, trips: 0.2 } });
  assert.equal(((await t.run({ question: 'How?', state: 'x', kind: 'score', options: { low: 'bad', high: 'good' } }, ctx)) as { score: number }).score, 1.5);
  await assert.rejects(t.run({ question: 'Which?', state: 'x', kind: 'choice', options: ['one'] }, ctx), /at least two options/);
  assert.equal(spent.length, 3);
  assert.throws(() => askJevTool(scriptedModel([], { decide: false })), /needs a ModelProvider with decide/);
  ok('ask_jev');
}

// 2 · ask_jev is offered at every step by default (and not when turned off or without decide)
{
  let provider = scriptedModel(['ok']);
  await runAgent({ provider, task, guidance: 'off' });
  assert.deepEqual(provider.requests[0]!.tools?.map(t => t.name), ['ask_jev']);
  provider = scriptedModel(['ok']);
  await runAgent({ provider, task, askJev: false, guidance: 'off' });
  assert.equal(provider.requests[0]!.tools, undefined);
  provider = scriptedModel(['ok'], { decide: false });
  await runAgent({ provider, task });
  assert.equal(provider.requests[0]!.tools, undefined);
  ok('ask_jev offered by default');
}

// 3 · ask_model: allowlist only, cost reported
{
  const provider = scriptedModel([{ text: 'Second opinion.', cost: 0.01 }], { decide: false });
  const t = askModelTool(provider, { models: { 'v/other': 'Other' } });
  spent.length = 0;
  assert.deepEqual(await t.run({ model: 'v/other', prompt: 'Review' }, ctx), { model: 'v/other', answer: 'Second opinion.' });
  assert.deepEqual(spent, [0.01]);
  await assert.rejects(t.run({ model: 'v/nope', prompt: 'x' }, ctx), /not offered/);
  ok('ask_model');
}

// 4 · jevStopCheck: a failed check sends the worker back with that check's feedback; short state
{
  let round = 0;
  const provider = scriptedModel(['Done.', 'Tagged it "travel".'], {
    decide: (_s, q) => {
      const out: Record<string, Answer> = {};
      for (const [id, qq] of Object.entries(q) as [string, Question][]) {
        if (qq.type === 'choice') out[id] = { type: 'choice', choice: 'task', confidence: 1, probabilities: { task: 1 } };
        else out[id] = { type: 'noul', noul: id === 'answers_every_part' ? (round++ === 0 ? 0.2 : 0.9) : 0.9 };
      }
      return out;
    },
  });
  const r = await runAgent({ provider, task, guidance: 'off', hooks: { stopCheck: jevStopCheck(provider) } });
  assert.equal(r.answer, 'Tagged it "travel".');
  assert.match(String(provider.requests[1]!.messages.at(-2)!.content), /^Part of the request is not answered\./);
  const checks = provider.decisions.filter(d => 'answers_every_part' in d.questions);
  assert.deepEqual(Object.keys(checks[0]!.questions), ['answers_every_part', 'expected_form'], 'no number-comparison check');
  ok('jevStopCheck');
}

// 5 · jevToolGate: pause below the bar (default) or refuse; reads are not gated unless asked
{
  const change: AgentTool = { name: 'tag', description: 'Tag.', parameters: { type: 'object', properties: {} }, write: { describe: () => 'Tag the note' }, run: async () => 'tagged' };
  const low = () => ({ serves: { type: 'noul', noul: 0.1 } as Answer, node: { type: 'choice', choice: 'task', confidence: 1, probabilities: { task: 1 } } as Answer });
  let provider = scriptedModel([{ calls: [{ name: 'tag' }] }], { decide: low });
  let r = await runAgent({ provider, task, guidance: 'off', toolsets: [{ name: 't', description: 't', tools: [change] }], approve: async () => true, hooks: { toolGate: jevToolGate(provider) } });
  assert.equal(r.status, 'paused');
  assert.match(r.reason!, /unlikely to serve the request \(p=0\.10\)/);
  provider = scriptedModel([{ calls: [{ name: 'tag' }] }, 'I will ask first.'], { decide: low, decideCost: 0.00002 });
  const log = eventLog();
  r = await runAgent({ provider, task, guidance: 'off', toolsets: [{ name: 't', description: 't', tools: [change] }], approve: async () => true, hooks: { toolGate: jevToolGate(provider, { below: 'refuse' }) }, log });
  assert.match(r.messages.find(m => m.role === 'tool')!.content, /^Refused: Jev judged/);
  assert.ok(log.entries().some(e => e.event.type === 'spend' && e.event.on === 'jevToolGate'), 'gate cost counted');
  ok('jevToolGate');
}

console.log(`${n} cases`);
