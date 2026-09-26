// The event log: append-only, and if the model saw it, it is logged.
import assert from 'node:assert/strict';
import { eventLog, runAgent, scriptedModel, type AgentTool, type ChatMessage, type LoggedEvent } from '../src/index.ts';

let n = 0;
const ok = (what: string) => console.log(`ok · ${++n} ${what}`);
const task = { goal: 'Look it up.', expectation: 'The answer.' };
const look: AgentTool = { name: 'look', description: 'Look.', parameters: { type: 'object', properties: {} }, run: async () => 'found 42' };

// 1 · entries are numbered, timestamped, deep-frozen copies
{
  const log = eventLog({ now: () => new Date('2026-09-26T00:00:00Z') });
  const message: ChatMessage = { role: 'user', content: 'hi' };
  const e = log.append({ type: 'context', message, transient: false });
  message.content = 'changed later';
  assert.equal(e.seq, 1);
  assert.equal(e.at, '2026-09-26T00:00:00.000Z');
  assert.equal((e.event as { message: ChatMessage }).message.content, 'hi', 'a later mutation does not reach the log');
  assert.throws(() => { (e.event as { message: ChatMessage }).message.content = 'x'; }, TypeError);
  (log.entries() as LoggedEvent[]).length = 0;
  assert.equal(log.entries().length, 1, 'entries() is a copy: emptying it does not touch the log');
  ok('append-only: numbered, copied, frozen');
}

// 2 · every message the model received appears as a context event, transient lines included
{
  const log = eventLog();
  const provider = scriptedModel([{ calls: [{ name: 'look' }] }, '42.'], { decide: false });
  const r = await runAgent({ provider, task, toolsets: [{ name: 'l', description: 'l', tools: [look] }], log });
  const context = log.entries().filter(e => e.event.type === 'context').map(e => e.event as { message: ChatMessage; transient: boolean });
  for (const request of provider.requests) {
    for (const sent of request.messages) {
      assert.ok(context.some(c => JSON.stringify(c.message) === JSON.stringify(sent)), `logged: ${JSON.stringify(sent).slice(0, 80)}`);
    }
  }
  const transient = context.filter(c => c.transient).map(c => String(c.message.content));
  assert.equal(transient.length, 2, 'one reminder per model call');
  assert.ok(transient.every(t => t.startsWith('Current request')));
  assert.equal(context.filter(c => !c.transient).length, r.messages.length, 'the kept conversation = the non-transient context events');
  ok('if the model saw it, it is logged');
}

// 3 · order and shape of a run: run_start first, finished last, seq strictly increasing
{
  const log = eventLog();
  const seen: string[] = [];
  await runAgent({ provider: scriptedModel(['hi'], { decide: false }), task, log, onEvent: e => void seen.push(e.type) });
  const types = log.entries().map(e => e.event.type);
  assert.deepEqual(types, seen, 'onEvent and the log see the same events');
  assert.equal(types[0], 'run_start');
  assert.equal(types.at(-1), 'finished');
  assert.ok(log.entries().every((e, i) => e.seq === i + 1));
  ok('run_start … finished, in order');
}

// 4 · since() and JSONL
{
  const log = eventLog();
  await runAgent({ provider: scriptedModel(['hi'], { decide: false }), task, log });
  const all = log.entries();
  assert.deepEqual(log.since(all.length - 1).map(e => e.seq), [all.length]);
  const lines = log.toJSONL().trim().split('\n');
  assert.equal(lines.length, all.length);
  assert.equal(JSON.parse(lines[0]!).event.type, 'run_start');
  ok('since + toJSONL');
}

// 5 · onAppend streams entries out as they happen; spend and hook events are logged
{
  const out: LoggedEvent[] = [];
  const log = eventLog({ onAppend: e => out.push(e) });
  await runAgent({ provider: scriptedModel([{ text: 'x', cost: 0.01 }, 'y'], { decide: false }), task, log, hooks: { stopCheck: c => (c.answer === 'x' ? { verdict: 'go', reason: 'more' } : undefined) } });
  assert.equal(out.length, log.entries().length);
  assert.ok(out.some(e => e.event.type === 'spend' && e.event.usd === 0.01));
  assert.ok(out.some(e => e.event.type === 'hook' && e.event.hook === 'stopCheck' && e.event.verdict === 'go'));
  assert.ok(out.some(e => e.event.type === 'nudge'));
  ok('onAppend; spend / hook / nudge events');
}

console.log(`${n} cases`);
