// Every hook, every verdict. go / pause / stop — the same vocabulary as ensemble's guard.
import assert from 'node:assert/strict';
import { combineHooks, readVerdict, runAgent, scriptedModel, type AgentTool, type Hooks } from '../src/index.ts';

let n = 0;
const ok = (what: string) => console.log(`ok · ${++n} ${what}`);
const task = { goal: 'Do it.', expectation: 'Done.' };
const ran: Record<string, unknown>[] = [];
const act: AgentTool = { name: 'act', description: 'Act.', parameters: { type: 'object', properties: { x: { type: 'number' } } }, run: async a => { ran.push(a); return `acted ${a.x}`; } };
const set = { name: 'a', description: 'a', tools: [act] };
const run = (script: Parameters<typeof scriptedModel>[0], hooks: Hooks, extra = {}) => runAgent({ provider: scriptedModel(script, { decide: false }), task, toolsets: [set], hooks, ...extra });

// 1 · readVerdict
{
  assert.deepEqual(readVerdict(undefined), { verdict: 'go' });
  assert.deepEqual(readVerdict('pause'), { verdict: 'pause' });
  assert.deepEqual(readVerdict({ verdict: 'stop', reason: 'r' }), { verdict: 'stop', reason: 'r' });
  ok('readVerdict: nothing is go');
}

// 2 · beforeStep: go / pause / stop
{
  let r = await run(['fine'], { beforeStep: () => 'go' });
  assert.equal(r.status, 'done');
  r = await run(['never'], { beforeStep: ctx => (ctx.step === 1 ? { verdict: 'pause', reason: 'waiting for review' } : 'go') });
  assert.equal(r.status, 'paused');
  assert.equal(r.reason, 'waiting for review');
  assert.equal(r.steps, 0);
  r = await run([{ calls: [{ name: 'act', args: { x: 1 } }] }, 'never'], { beforeStep: ctx => (ctx.step === 2 ? 'stop' : undefined) });
  assert.equal(r.status, 'stopped');
  assert.equal(r.reason, 'beforeStep said stop.');
  assert.equal(r.steps, 1);
  ok('beforeStep go / pause / stop');
}

// 3 · toolGate: pause and stop end the run before the call; the transcript stays valid
{
  ran.length = 0;
  let r = await run([{ calls: [{ name: 'act', args: { x: 1 } }, { name: 'act', args: { x: 2 } }] }], { toolGate: () => ({ verdict: 'pause', reason: 'needs a human' }) });
  assert.equal(r.status, 'paused');
  assert.equal(ran.length, 0);
  assert.equal(r.messages.filter(m => m.role === 'tool').length, 2);
  r = await run([{ calls: [{ name: 'act', args: { x: 1 } }] }], { toolGate: () => 'stop' });
  assert.equal(r.status, 'stopped');
  assert.equal(ran.length, 0);
  ok('toolGate pause / stop');
}

// 4 · toolGate: go with rewritten args, or with a result instead of running
{
  ran.length = 0;
  let r = await run([{ calls: [{ name: 'act', args: { x: 1 } }] }, 'ok'], { toolGate: ctx => ({ verdict: 'go', args: { x: (ctx.args.x as number) * 10 } }) });
  assert.deepEqual(ran, [{ x: 10 }]);
  r = await run([{ calls: [{ name: 'act', args: { x: 1 } }] }, 'ok'], { toolGate: () => ({ verdict: 'go', result: 'Refused: not today.' }) });
  assert.deepEqual(ran, [{ x: 10 }], 'not run');
  assert.equal(r.messages.find(m => m.role === 'tool')!.content, 'Refused: not today.');
  ok('toolGate go + args / go + result');
}

// 5 · rewriteOutput: the model sees the rewrite
{
  const provider = scriptedModel([{ calls: [{ name: 'act', args: { x: 7 } }] }, 'ok'], { decide: false });
  await runAgent({ provider, task, toolsets: [set], hooks: { rewriteOutput: ctx => ctx.result.replace('7', '[redacted]') } });
  assert.equal(provider.requests[1]!.messages.find(m => m.role === 'tool')!.content, 'acted [redacted]');
  ok('rewriteOutput');
}

// 6 · stopCheck: nothing accepts; go sends back with the reason; pause → needs_person
{
  let r = await run(['answer'], { stopCheck: () => undefined });
  assert.equal(r.status, 'done');
  r = await run(['answer'], { stopCheck: () => 'stop' });
  assert.equal(r.status, 'done');
  const provider = scriptedModel(['first try', 'second try'], { decide: false });
  r = await runAgent({ provider, task, hooks: { stopCheck: ctx => (ctx.answer === 'first try' ? { verdict: 'go', reason: 'Add the total.' } : undefined) } });
  assert.equal(r.status, 'done');
  assert.equal(r.answer, 'second try');
  assert.equal(provider.requests[1]!.messages.at(-2)!.content, 'Add the total.');
  r = await run(['which one?'], { stopCheck: () => ({ verdict: 'pause', reason: 'a real question' }) });
  assert.equal(r.status, 'needs_person');
  ok('stopCheck accept / nudge / pause');
}

// 7 · stopCheck nudges are capped, then the answer is accepted with a reason
{
  const provider = scriptedModel(['a', 'b', 'c'], { decide: false });
  const r = await runAgent({ provider, task, hooks: { stopCheck: () => ({ verdict: 'go', reason: 'Not yet.' }) }, budget: { maxNudges: 2 } });
  assert.equal(r.status, 'done');
  assert.equal(provider.requests.length, 3);
  assert.match(r.reason!, /Accepted after 2 nudges/);
  ok('maxNudges');
}

// 8 · a nudge on the last step runs out of steps: limit
{
  const provider = scriptedModel(['a', 'b'], { decide: false });
  const r = await runAgent({ provider, task, hooks: { stopCheck: () => 'go' }, budget: { maxSteps: 2, maxNudges: 5 } });
  assert.equal(r.status, 'limit');
  assert.equal(r.reason, 'Out of steps (2).');
  ok('out of steps → limit');
}

// 9 · combineHooks: first objection wins, rewrites chain
{
  const seen: string[] = [];
  const h = combineHooks(
    { beforeStep: () => void seen.push('a'), rewriteOutput: c => `${c.result}+1`, toolGate: c => ({ verdict: 'go', args: { x: (c.args.x as number) + 1 } }) },
    undefined,
    { beforeStep: () => { seen.push('b'); return { verdict: 'pause', reason: 'b says' }; }, rewriteOutput: c => `${c.result}+2`, toolGate: c => ({ verdict: 'go', args: { x: (c.args.x as number) * 2 } }) },
    { beforeStep: () => void seen.push('c') }
  );
  const base = { step: 1, spent: 0, toolCalls: 0, nudges: 0, task, messages: [], spend: () => {} };
  assert.deepEqual(await h.beforeStep!(base), { verdict: 'pause', reason: 'b says' });
  assert.deepEqual(seen, ['a', 'b']);
  assert.equal(await h.rewriteOutput!({ ...base, tool: 't', args: {}, callId: 'c', ok: true, result: 'r' }), 'r+1+2');
  assert.deepEqual(await h.toolGate!({ ...base, tool: 't', args: { x: 1 }, callId: 'c', change: null }), { verdict: 'go', args: { x: 4 } });
  ok('combineHooks');
}

console.log(`${n} cases`);
