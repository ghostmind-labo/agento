// The USD cap: a run that hits it ends with 'limit' and says why. Offline: costs are scripted.
import assert from 'node:assert/strict';
import { limits, overBudget, runAgent, scriptedModel, subagentTool, type AgentTool } from '../src/index.ts';

let n = 0;
const ok = (what: string) => console.log(`ok · ${++n} ${what}`);
const task = { goal: 'Find it.', expectation: 'The thing.' };
const look: AgentTool = { name: 'look', description: 'Look.', parameters: { type: 'object', properties: { q: { type: 'string' } } }, run: async a => `saw ${a.q}` };
const set = { name: 'l', description: 'l', tools: [look] };

// 1 · defaults and overrides
{
  const l = limits({ maxSteps: 3 });
  assert.equal(l.maxSteps, 3);
  assert.equal(l.maxToolCalls, 12);
  assert.equal(l.maxUsd, Infinity);
  assert.equal(overBudget(5, Infinity), null);
  assert.equal(overBudget(0.1 + 0.2, 0.3) !== null, true, 'micro-dollar comparison: 0.1+0.2 reaches 0.3');
  ok('limits + overBudget');
}

// 2 · the cap stops the run before the next model call, with the figure in the reason
{
  const provider = scriptedModel([
    { calls: [{ name: 'look', args: { q: 'a' } }], cost: 0.004 },
    { calls: [{ name: 'look', args: { q: 'b' } }], cost: 0.004 },
    'never reached',
  ]);
  const r = await runAgent({ provider, task, toolsets: [set], budget: { maxUsd: 0.008 } });
  assert.equal(r.status, 'limit');
  assert.match(r.reason!, /Budget reached: spent \$0\.008000 of the \$0\.008000 cap\./);
  assert.equal(provider.requests.length, 2);
  assert.equal(r.cost, 0.008);
  ok('USD cap → limit with reason');
}

// 3 · under the cap, the run finishes normally and reports what it spent (worker + Jev)
{
  const provider = scriptedModel([{ text: 'Found.', cost: 0.001 }], { decideCost: 0.00002 });
  const r = await runAgent({ provider, task, budget: { maxUsd: 1 } });
  assert.equal(r.status, 'done');
  assert.equal(Number(r.cost.toFixed(6)), 0.00104, 'opening decision + worker + the guide\'s before_answer checkpoint');
  ok('cost sums worker and Jev');
}

// 4 · spend reported by a tool counts, and stops the remaining calls of the batch
{
  const pricey: AgentTool = { name: 'pricey', description: 'p', parameters: { type: 'object', properties: { i: { type: 'number' } } }, run: async (_a, ctx) => { ctx.spend(0.5); return 'ok'; } };
  let ran = 0;
  const counted: AgentTool = { ...pricey, run: async (a, ctx) => { ran++; return pricey.run(a, ctx); } };
  const provider = scriptedModel([{ calls: [{ name: 'pricey', args: { i: 1 } }, { name: 'pricey', args: { i: 2 } }] }]);
  const r = await runAgent({ provider, task, toolsets: [{ name: 'p', description: 'p', tools: [counted] }], budget: { maxUsd: 0.5 } });
  assert.equal(ran, 1);
  assert.equal(r.status, 'limit');
  const results = r.messages.filter(m => m.role === 'tool').map(m => m.content);
  assert.equal(results.length, 2, 'the skipped call still has a result');
  assert.match(results[1]!, /^Not run: Budget reached/);
  ok('tool spend counts; the rest of the batch is skipped with a result');
}

// 5 · a sub-agent's spend rolls up into the parent's total and cap; its transcript stays its own
{
  const child = scriptedModel([{ calls: [{ name: 'look', args: { q: 'deep' } }], cost: 0.2 }, { text: 'Child found it.', cost: 0.2 }], { decide: false });
  const helper = subagentTool({ name: 'research', description: 'Research a question.', expectation: 'A finding.', options: { provider: child, toolsets: [set] } });
  const parent = scriptedModel([{ calls: [{ name: 'research', args: { goal: 'dig' } }], cost: 0.1 }, { text: 'Parent done.', cost: 0.1 }], { decide: false });
  const r = await runAgent({ provider: parent, task, toolsets: [{ name: 'h', description: 'h', tools: [helper] }] });
  assert.equal(r.status, 'done');
  assert.equal(Number(r.cost.toFixed(6)), 0.6);
  const toolMsg = r.messages.find(m => m.role === 'tool')!;
  assert.deepEqual(JSON.parse(toolMsg.content), { status: 'done', answer: 'Child found it.' });
  assert.ok(!r.messages.some(m => m.role === 'tool' && m.content.includes('saw deep')), "the child's tool results never reach the parent");
  ok('sub-agent: isolated transcript, cost rolled up');
}

// 6 · a cap already spent by the opening decision stops before the worker
{
  const provider = scriptedModel(['x'], { decideCost: 1 });
  const r = await runAgent({ provider, task, budget: { maxUsd: 0.5 } });
  assert.equal(r.status, 'limit');
  assert.equal(provider.requests.length, 0);
  ok('cap checked before the first worker call');
}

console.log(`${n} cases`);
