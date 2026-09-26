// A change never runs on the model's say-so: accept, decline, and no one to ask.
import assert from 'node:assert/strict';
import { runAgent, scriptedModel, type AgentTool, type ApprovalRequest } from '../src/index.ts';

let n = 0;
const ok = (what: string) => console.log(`ok · ${++n} ${what}`);
const task = { goal: 'Rename it to B.', expectation: 'Say what changed.' };
const done: Record<string, unknown>[] = [];
const rename: AgentTool = {
  name: 'rename',
  description: 'Rename a thing.',
  parameters: { type: 'object', properties: { to: { type: 'string' }, dry: { type: 'boolean' } } },
  write: { describe: a => (a.dry ? null : `Rename the thing to "${a.to}"`) },
  run: async a => { done.push(a); return { renamed: a.to }; },
};
const set = { name: 'r', description: 'r', tools: [rename] };

// 1 · approved: runs, and the request carried the sentence
{
  done.length = 0;
  const asked: ApprovalRequest[] = [];
  const events: string[] = [];
  const r = await runAgent({
    provider: scriptedModel([{ calls: [{ name: 'rename', args: { to: 'B' } }] }, 'Renamed to B.'], { decide: false }),
    task,
    toolsets: [set],
    approve: async req => { asked.push(req); return true; },
    onEvent: e => void events.push(e.type),
  });
  assert.equal(r.status, 'done');
  assert.deepEqual(done, [{ to: 'B' }]);
  assert.equal(asked[0]!.summary, 'Rename the thing to "B"');
  assert.ok(events.indexOf('approval') < events.indexOf('approval_result'));
  ok('approve → runs');
}

// 2 · declined: nothing runs, the model is told, answers once without tools, and the run ends on the person
{
  done.length = 0;
  const provider = scriptedModel([{ calls: [{ name: 'rename', args: { to: 'B' } }] }, { text: 'OK, nothing changed. What instead?', calls: [{ name: 'rename', args: { to: 'C' } }] }], { decide: false });
  const r = await runAgent({ provider, task, toolsets: [set], approve: async () => false });
  assert.equal(done.length, 0);
  assert.match(r.messages.find(m => m.role === 'tool')!.content, /declined this change\. Nothing was changed/);
  assert.equal(provider.requests[1]!.toolChoice, 'none', 'after a decline the next step may not call tools');
  assert.equal(r.status, 'needs_person');
  assert.equal(r.answer, 'OK, nothing changed. What instead?');
  ok('decline → needs_person, never retried');
}

// 3 · a second change in the same batch after a decline is skipped without asking
{
  done.length = 0;
  let asks = 0;
  const provider = scriptedModel([{ calls: [{ name: 'rename', args: { to: 'B' } }, { name: 'rename', args: { to: 'C' } }] }, 'Nothing changed.'], { decide: false });
  const r = await runAgent({ provider, task, toolsets: [set], approve: async () => { asks++; return false; } });
  assert.equal(asks, 1);
  assert.match(r.messages.filter(m => m.role === 'tool')[1]!.content, /Skipped: the person declined/);
  ok('after a decline, later changes are skipped');
}

// 4 · no approve: a change is refused, a read of the same tool still runs
{
  done.length = 0;
  const provider = scriptedModel([{ calls: [{ name: 'rename', args: { to: 'B' } }, { name: 'rename', args: { to: 'B', dry: true } }] }, 'Could not.'], { decide: false });
  const r = await runAgent({ provider, task, toolsets: [set] });
  const results = r.messages.filter(m => m.role === 'tool').map(m => m.content);
  assert.match(results[0]!, /Changes need the person's approval/);
  assert.deepEqual(done, [{ to: 'B', dry: true }], 'describe → null means this call only reads');
  ok('no approve → changes refused, reads run');
}

// 5 · a change is never deduplicated: the same approved change twice runs twice
{
  done.length = 0;
  const provider = scriptedModel([{ calls: [{ name: 'rename', args: { to: 'B' } }] }, { calls: [{ name: 'rename', args: { to: 'B' } }] }, 'Done.'], { decide: false });
  await runAgent({ provider, task, toolsets: [set], approve: async () => true });
  assert.equal(done.length, 2);
  ok('changes are not deduplicated');
}

console.log(`${n} cases`);
