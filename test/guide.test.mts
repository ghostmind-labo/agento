// Jev as the guide: checkpoints the loop asks itself, sized to the model, adapted, learned.
import assert from 'node:assert/strict';
import {
  eventLog,
  levelFromCard,
  levelFromProfile,
  memoryProfiles,
  runAgent,
  scriptedModel,
  type AgentTool,
  type Answer,
  type LoggedEvent,
  type Question,
  type ScriptStep,
} from '../src/index.ts';

let n = 0;
const ok = (what: string) => console.log(`ok · ${++n} ${what}`);
const task = { goal: 'Find the report about pears.', expectation: 'The report title.' };
const search: AgentTool = { name: 'search', description: 'Search documents by words.', parameters: { type: 'object', properties: { q: { type: 'string' } } }, run: async a => `results for ${a.q}` };
const save: AgentTool = {
  name: 'save',
  description: 'Save a document.',
  parameters: { type: 'object', properties: { title: { type: 'string' } } },
  write: { describe: a => `Save "${a.title}"` },
  run: async a => `saved ${a.title}`,
};
const toolsets = [{ name: 'docs', description: 'Documents.', tools: [search, save] }];

/** Jev's stub: a fixed probability per checkpoint, recognised by its question; opening → task. */
const jev = (p: { tool?: number; write?: number; answer?: number; choice?: string } = {}) => (_state: unknown, questions: Record<string, Question>) => {
  const out: Record<string, Answer> = {};
  for (const [id, q] of Object.entries(questions)) {
    const text = String(q.instructions);
    if (q.type === 'choice') {
      const keys = Object.keys(q.criteria);
      const pick = keys.includes('task') ? 'task' : p.choice && keys.includes(p.choice) ? p.choice : keys[0]!;
      out[id] = { type: 'choice', choice: pick, confidence: 0.8, probabilities: Object.fromEntries(keys.map(k => [k, k === pick ? 0.8 : 0.2 / (keys.length - 1)])) };
    } else if (q.type === 'noul') {
      const v = text.includes('move the agent closer') ? p.tool : text.includes('`change`') ? p.write : text.includes('respond to') ? p.answer : undefined;
      out[id] = { type: 'noul', noul: v ?? 0.6 };
    }
  }
  return out;
};

const checkpoints = (log: { entries(): readonly LoggedEvent[] }) => log.entries().map(e => e.event).filter(e => e.type === 'checkpoint') as Extract<LoggedEvent['event'], { type: 'checkpoint' }>[];
const levels = (log: { entries(): readonly LoggedEvent[] }) => log.entries().map(e => e.event).filter(e => e.type === 'guidance') as Extract<LoggedEvent['event'], { type: 'guidance' }>[];
const searches = (k: number): ScriptStep[] => Array.from({ length: k }, (_, i) => ({ calls: [{ name: 'search', args: { q: `pears ${i}` } }] }));

// 1 · the starting level from the catalogue: price, context, tools
{
  assert.equal(levelFromCard(null).level, 'normal');
  const card = (completion: number, extra = {}) => ({ id: 'm', name: 'm', prompt: 0, completion: completion / 1e6, context: 200_000, tools: true, vision: false, ...extra });
  assert.equal(levelFromCard(card(15)).level, 'light');
  assert.equal(levelFromCard(card(4)).level, 'normal');
  assert.equal(levelFromCard(card(0.4)).level, 'close');
  assert.equal(levelFromCard(card(15, { context: 32_000 })).level, 'normal', 'a small context tightens a notch');
  assert.equal(levelFromCard(card(4, { tools: false })).level, 'close');
  ok('levelFromCard');
}

// 2 · the starting level from history, once there is enough of it
{
  assert.equal(levelFromProfile(null), null);
  const base = { model: 'm', lastLevel: 'normal' as const, correctedRuns: 0, correctedSuccesses: 0 };
  assert.equal(levelFromProfile({ ...base, runs: 2, successes: 2, checkpoints: 10, lows: 0 }), null);
  assert.equal(levelFromProfile({ ...base, runs: 5, successes: 5, checkpoints: 20, lows: 0 })!.level, 'light');
  assert.equal(levelFromProfile({ ...base, runs: 5, successes: 4, checkpoints: 20, lows: 8 })!.level, 'close');
  assert.equal(levelFromProfile({ ...base, runs: 5, successes: 2, checkpoints: 20, lows: 1 })!.level, 'close', 'a model that keeps failing gets close guidance');
  ok('levelFromProfile');
}

// 3 · ACCEPTANCE: a weak model gets more checkpoints than a strong one, same work
{
  const script = [...searches(4), 'The report is "Pears 2026".'];
  const weakLog = eventLog();
  const strongLog = eventLog();
  await runAgent({ provider: scriptedModel(script, { decide: jev(), card: { completion: 0.3 / 1e6, context: 32_000 } }), task, toolsets, log: weakLog });
  await runAgent({ provider: scriptedModel(script, { decide: jev(), card: { completion: 15 / 1e6, context: 400_000 } }), task, toolsets, log: strongLog });
  assert.equal(levels(weakLog)[0]!.level, 'close');
  assert.equal(levels(strongLog)[0]!.level, 'light');
  const weak = checkpoints(weakLog).length;
  const strong = checkpoints(strongLog).length;
  assert.ok(weak > strong, `weak ${weak} > strong ${strong}`);
  assert.equal(checkpoints(weakLog).filter(c => c.at === 'after_tool').length, 4, 'close: after every tool result');
  assert.equal(checkpoints(strongLog).filter(c => c.at === 'after_tool').length, 0, 'light: no after_tool checks');
  ok(`weak model ${weak} checkpoints, strong ${strong}`);
}

// 4 · ACCEPTANCE: repeated low checkpoints tighten the level, and a low one steers the next call
{
  const log = eventLog();
  const provider = scriptedModel([...searches(6), 'The report is "Pears 2026".'], { decide: jev({ tool: 0.1 }) }); // no card → normal
  await runAgent({ provider, task, toolsets, log, budget: { maxSteps: 10, maxToolCalls: 20 } });
  const changes = levels(log);
  assert.equal(changes[0]!.level, 'normal');
  const tightened = changes.find(c => c.from === 'normal' && c.level === 'close');
  assert.ok(tightened, 'normal → close');
  assert.match(tightened!.reason, /2 low checkpoints in a row/);
  const steered = provider.requests.find(r => r.messages.some(m => typeof m.content === 'string' && m.content.startsWith('Guide (Jev, 10% on track)')));
  assert.ok(steered, 'the steer reached the model');
  const steeredAt = provider.requests.indexOf(steered!);
  const kept = provider.requests[steeredAt + 1]!.messages.filter(m => typeof m.content === 'string' && m.content.startsWith('Guide (Jev'));
  assert.ok(kept.length <= 1, 'a steer is transient: it rides with one call, it does not pile up');
  ok('lows tighten the level; a low after_tool steers the next call');
}

// 5 · confident passes loosen it again (auto only)
{
  const log = eventLog();
  await runAgent({ provider: scriptedModel([...searches(8), 'Found.'], { decide: jev({ tool: 0.95 }), card: { completion: 0.3 / 1e6 } }), task, toolsets, log, budget: { maxSteps: 12, maxToolCalls: 20 } });
  assert.ok(levels(log).some(c => c.from === 'close' && c.level === 'normal' && /confident/.test(c.reason)));
  ok('confident passes loosen close → normal');
}

// 6 · before_answer: a low answer is sent back (a nudge), then accepted
{
  const log = eventLog();
  let calls = 0;
  const decide = (s: unknown, q: Record<string, Question>) => {
    const out = jev()(s, q);
    for (const [id, qq] of Object.entries(q)) if (String(qq.instructions).includes('respond to')) out[id] = { type: 'noul', noul: calls++ === 0 ? 0.1 : 0.9 };
    return out;
  };
  const provider = scriptedModel(['Pears are fruit.', 'The report is "Pears 2026".'], { decide });
  const r = await runAgent({ provider, task, log });
  assert.equal(r.answer, 'The report is "Pears 2026".');
  assert.equal(r.status, 'done');
  const cps = checkpoints(log).filter(c => c.at === 'before_answer');
  assert.deepEqual(cps.map(c => c.action), ['send_back', 'pass']);
  assert.match(String(provider.requests[1]!.messages.at(-2)!.content), /^Guide \(Jev, 10%\): your answer may not respond/);
  ok('before_answer low → sent back, then passes');
}

// 7 · before_write: a doubtful change is held back once; made again, it goes to approval
{
  const log = eventLog();
  let approvals = 0;
  const provider = scriptedModel([{ calls: [{ name: 'save', args: { title: 'Apples' } }] }, { calls: [{ name: 'save', args: { title: 'Apples' } }] }, 'Saved.'], { decide: jev({ write: 0.05 }) });
  const r = await runAgent({ provider, task, toolsets, log, approve: async () => { approvals++; return true; } });
  const results = r.messages.filter(m => m.role === 'tool').map(m => m.content);
  assert.match(results[0]!, /^Not run yet — Guide \(Jev, 5%\)/);
  assert.equal(results[1], 'saved Apples');
  assert.equal(approvals, 1, 'held back before approval, never instead of it');
  assert.deepEqual(checkpoints(log).filter(c => c.at === 'before_write').map(c => c.action), ['hold']);
  ok('before_write low → held back once, then to approval');
}

// 8 · hesitation: an empty reply gets a choice over the tools, and the steer names it
{
  const log = eventLog();
  const provider = scriptedModel(['', 'The report is "Pears 2026".'], { decide: jev({ choice: 'search' }) });
  await runAgent({ provider, task, toolsets, log });
  const h = checkpoints(log).find(c => c.at === 'hesitation')!;
  assert.equal(h.choice, 'search');
  assert.ok(provider.requests[1]!.messages.some(m => m.content === 'Guide (Jev, 80%): the next step most likely to help is `search`.'));
  ok('hesitation (empty reply) → choice steer');
}

// 9 · hesitation: a repeated call
{
  const log = eventLog();
  const provider = scriptedModel([{ calls: [{ name: 'search', args: { q: 'x' } }] }, { calls: [{ name: 'search', args: { q: 'x' } }] }, 'Done.'], { decide: jev({ choice: 'answer_now' }) });
  await runAgent({ provider, task, toolsets, log });
  assert.ok(checkpoints(log).some(c => c.at === 'hesitation' && c.choice === 'answer_now'));
  assert.ok(provider.requests[2]!.messages.some(m => typeof m.content === 'string' && m.content.includes('you likely have enough — answer now')));
  ok('hesitation (repeated call) → answer-now steer');
}

// 10 · profiles: a run is recorded per model, and seeds the next run's level
{
  const profiles = memoryProfiles();
  for (let i = 0; i < 3; i++) {
    await runAgent({ provider: scriptedModel([...searches(3), 'Found.'], { decide: jev({ tool: 0.1 }), model: 'cheap/model' }), task, toolsets, guide: { profiles } });
  }
  const p = profiles.profiles.get('cheap/model')!;
  assert.equal(p.runs, 3);
  assert.ok(p.lows > 0 && p.correctedRuns === 3);
  const log = eventLog();
  await runAgent({ provider: scriptedModel(['Found.'], { decide: jev(), model: 'cheap/model', card: { completion: 50 / 1e6 } }), task, toolsets, log, guide: { profiles } });
  const first = levels(log)[0]!;
  assert.equal(first.level, 'close', 'history beats the catalogue');
  assert.match(first.reason, /^profile: 3 runs/);
  ok('per-model profile learned and used');
}

// 11 · fixed settings: off asks nothing; a named level never adapts; a number sets the period
{
  let log = eventLog();
  await runAgent({ provider: scriptedModel([...searches(3), 'Found.'], { decide: jev({ tool: 0.1 }) }), task, toolsets, log, guidance: 'off' });
  assert.equal(checkpoints(log).length, 0);
  log = eventLog();
  await runAgent({ provider: scriptedModel([...searches(4), 'Found.'], { decide: jev({ tool: 0.1 }) }), task, toolsets, log, guidance: 'normal' });
  assert.equal(levels(log).length, 0, 'no adaptation when the level is set');
  log = eventLog();
  await runAgent({ provider: scriptedModel([...searches(4), 'Found.'], { decide: jev() }), task, toolsets, log, guidance: 2 });
  assert.equal(checkpoints(log).filter(c => c.at === 'after_tool').length, 2, 'every 2nd tool result');
  ok('off / fixed level / numeric period');
}

// 12 · cost: every checkpoint is spent against the budget, and none is asked once the cap is reached
{
  const log = eventLog();
  const r = await runAgent({ provider: scriptedModel([...searches(3), 'Found.'], { decide: jev(), decideCost: 0.001, card: { completion: 0.1 / 1e6 } }), task, toolsets, log });
  const guideSpend = log.entries().map(e => e.event).filter(e => e.type === 'spend' && e.on === 'guide').length;
  assert.equal(guideSpend, checkpoints(log).length);
  assert.ok(r.cost > 0);
  const capped = eventLog();
  await runAgent({ provider: scriptedModel([{ calls: [{ name: 'search', args: { q: 'a' } }], cost: 1 }, 'Found.'], { decide: jev(), card: { completion: 0.1 / 1e6 } }), task, toolsets, log: capped, budget: { maxUsd: 0.5 } });
  assert.equal(checkpoints(capped).length, 0);
  ok('checkpoint cost counted; none past the cap');
}

// 13 · Jev's jaggedness respected: atomic questions, short state (task + latest step), no transcript
{
  const provider = scriptedModel([...searches(3), 'Found.'], { decide: jev(), card: { completion: 0.1 / 1e6 } });
  await runAgent({ provider, task, toolsets });
  for (const d of provider.decisions) {
    assert.equal(Object.keys(d.questions).length, 1, 'one question per call');
    const state = JSON.stringify(d.state);
    assert.ok(state.length < 4000, `short state (${state.length})`);
    assert.ok(!/"messages"|"work"/.test(state), 'no transcript');
  }
  ok('atomic questions, short state');
}

// 14 · without decide, nothing is asked and the loop runs as before
{
  const log = eventLog();
  const r = await runAgent({ provider: scriptedModel([...searches(2), 'Found.'], { decide: false }), task, toolsets, log });
  assert.equal(r.status, 'done');
  assert.equal(checkpoints(log).length + levels(log).length, 0);
  ok('no decide → no guide');
}

console.log(`${n} cases`);
