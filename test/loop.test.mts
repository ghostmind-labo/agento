// The loop's guards, each against the failure it exists for. Offline: the model is scripted.
import assert from 'node:assert/strict';
import { memorySessions, runAgent, scriptedModel, type AgentTool, type Toolset } from '../src/index.ts';

let n = 0;
const ok = (what: string) => console.log(`ok · ${++n} ${what}`);
const task = { goal: 'How many apples?', expectation: 'A number.' };

const counter = () => {
  const calls: Record<string, unknown>[] = [];
  const tool: AgentTool = {
    name: 'count',
    description: 'Count a fruit.',
    parameters: { type: 'object', properties: { fruit: { type: 'string' } }, required: ['fruit'] },
    run: async args => {
      calls.push(args);
      return { fruit: args.fruit, count: 3 };
    },
  };
  return { calls, set: { name: 'fruit', description: 'Fruit.', tools: [tool] } as Toolset };
};

// 1 · a tool call, then an answer: done
{
  const { calls, set } = counter();
  const provider = scriptedModel([{ text: 'Let me count.', calls: [{ name: 'count', args: { fruit: 'apple' } }] }, 'There are 3 apples.']);
  const r = await runAgent({ provider, task, toolsets: [set] });
  assert.equal(r.status, 'done');
  assert.equal(r.answer, 'There are 3 apples.', 'the answer is the last words, not the line before a lookup');
  assert.equal(r.steps, 2);
  assert.equal(r.toolCalls, 1);
  assert.deepEqual(calls, [{ fruit: 'apple' }]);
  assert.equal(r.messages[0]!.role, 'system');
  assert.ok(r.messages.some(m => m.role === 'tool' && m.content.includes('"count":3')));
  ok('tool call then answer → done');
}

// 2 · the reminder is transient: sent at the end of every call, never kept
{
  const provider = scriptedModel(['Three.']);
  const r = await runAgent({ provider, task });
  const sent = provider.requests[0]!.messages;
  assert.match(String(sent.at(-1)!.content), /Current request: "How many apples\?"/);
  assert.ok(!r.messages.some(m => typeof m.content === 'string' && m.content.startsWith('Current request')));
  ok('reminder at the end of the context, removed after the call');
}

// 3 · step cap: the last step answers with tools shown but not callable, and a call there is not obeyed
{
  const { calls, set } = counter();
  const loop = { text: null, calls: [{ name: 'count', args: { fruit: 'pear' } }] };
  const provider = scriptedModel([
    { ...loop, calls: [{ name: 'count', args: { fruit: 'a' } }] },
    { ...loop, calls: [{ name: 'count', args: { fruit: 'b' } }] },
    { text: 'Final: 3.', calls: [{ name: 'count', args: { fruit: 'c' } }] },
  ]);
  const r = await runAgent({ provider, task, toolsets: [set], budget: { maxSteps: 3 } });
  assert.equal(provider.requests[2]!.toolChoice, 'none');
  assert.equal(provider.requests[2]!.tools?.length, 2, 'count + ask_jev still visible');
  assert.match(String(provider.requests[2]!.messages.at(-1)!.content), /^Answer now/);
  assert.equal(calls.length, 2, 'the call on the answer step never ran');
  assert.equal(r.status, 'done');
  assert.equal(r.answer, 'Final: 3.');
  ok('step cap → hard answer step (toolChoice none), calls there dropped');
}

// 4 · tool-call cap: once spent, the next step answers
{
  const { calls, set } = counter();
  const provider = scriptedModel([
    { calls: [{ name: 'count', args: { fruit: 'a' } }, { name: 'count', args: { fruit: 'b' } }] },
    'Done: 3.',
  ]);
  const r = await runAgent({ provider, task, toolsets: [set], budget: { maxToolCalls: 2 } });
  assert.equal(calls.length, 2);
  assert.equal(provider.requests[1]!.toolChoice, 'none');
  assert.equal(r.status, 'done');
  ok('tool-call cap → next step answers');
}

// 5 · out of steps entirely: limit, with a reason
{
  const provider = scriptedModel([{ calls: [{ name: 'count', args: { fruit: 'a' } }] }, '']);
  const { set } = counter();
  const r = await runAgent({ provider, task, toolsets: [set], budget: { maxSteps: 2 } });
  // step 2 is the answer step and replies empty; with no steps left it is reported as unfinished.
  assert.equal(r.status, 'unfinished');
  assert.match(r.answer!, /couldn't finish/);
  ok('empty reply on the last step → unfinished, never a blank answer');
}

// 6 · empty reply: sent back twice, then unfinished
{
  const provider = scriptedModel(['', '', '']);
  const r = await runAgent({ provider, task });
  assert.equal(r.status, 'unfinished');
  assert.equal(provider.requests.length, 3);
  assert.equal(r.messages.filter(m => m.role === 'user' && m.content.startsWith('Your reply was empty')).length, 2);
  ok('empty reply → back twice, then unfinished');
}

// 7 · empty reply then a real answer: done
{
  const provider = scriptedModel(['', 'Three.']);
  const r = await runAgent({ provider, task });
  assert.equal(r.status, 'done');
  assert.equal(r.answer, 'Three.');
  ok('one empty reply is recovered');
}

// 8 · leaked tool-call markup is read back into a real call, and never shown
{
  const { calls, set } = counter();
  const leaked = 'Checking.<｜｜DSML｜｜ invoke name="count"> <｜｜DSML｜｜ parameter name="fruit" string="true">kiwi</｜｜DSML｜｜ parameter> </｜｜DSML｜｜ invoke>';
  const deltas: string[] = [];
  const provider = scriptedModel([leaked, '3 kiwis.']);
  const r = await runAgent({ provider, task, toolsets: [set], stream: true, onEvent: e => void (e.type === 'delta' && deltas.push(e.text)) });
  assert.deepEqual(calls, [{ fruit: 'kiwi' }]);
  assert.equal(r.answer, '3 kiwis.');
  assert.ok(!deltas.join('').includes('DSML'), 'no markup streamed');
  assert.ok(!r.messages.some(m => typeof m.content === 'string' && m.content.includes('DSML')), 'no markup kept');
  ok('leaked DSML calls recovered, never shown');
}

// 9 · duplicate reads run once
{
  const { calls, set } = counter();
  const provider = scriptedModel([
    { calls: [{ name: 'count', args: { fruit: 'apple', n: { a: 1, b: 2 } } }] },
    { calls: [{ name: 'count', args: { n: { b: 2, a: 1 }, fruit: 'apple' } }] },
    'Three.',
  ]);
  const r = await runAgent({ provider, task, toolsets: [set] });
  assert.equal(calls.length, 1, 'the same call in another key order is the same call');
  assert.ok(r.messages.some(m => m.role === 'tool' && m.content.startsWith('You already ran count')));
  ok('duplicate-call guard (stable JSON)');
}

// 10 · result cap
{
  const big: AgentTool = { name: 'big', description: 'Big.', parameters: { type: 'object', properties: {} }, run: async () => 'x'.repeat(500) };
  const provider = scriptedModel([{ calls: [{ name: 'big' }] }, 'ok']);
  const r = await runAgent({ provider, task, toolsets: [{ name: 'b', description: 'b', tools: [big] }], budget: { resultCap: 100 } });
  const tool = r.messages.find(m => m.role === 'tool')!;
  assert.match(tool.content, /^x{100}\n…\(truncated, 500 characters\)$/);
  ok('long results capped');
}

// 11 · read nudge every N reads
{
  const { set } = counter();
  const provider = scriptedModel([
    { calls: [{ name: 'count', args: { fruit: 'a' } }, { name: 'count', args: { fruit: 'b' } }] },
    'Done.',
  ]);
  const r = await runAgent({ provider, task, toolsets: [set], budget: { readNudgeAt: 2 } });
  const tools = r.messages.filter(m => m.role === 'tool');
  assert.ok(!tools[0]!.content.includes('lookups so far'));
  assert.match(tools[1]!.content, /2 lookups so far/);
  ok('read nudge every readNudgeAt reads');
}

// 12 · guide tools spend no tool call and give the step back
{
  const guide: AgentTool = { name: 'use_skill', description: 'Guide.', parameters: { type: 'object', properties: {} }, run: async () => 'how-to' };
  const provider = scriptedModel([{ calls: [{ name: 'use_skill' }] }, { calls: [{ name: 'use_skill', args: { x: 1 } }] }, 'Answer.']);
  const r = await runAgent({ provider, task, toolsets: [{ name: 'g', description: 'g', tools: [guide] }], budget: { maxSteps: 2, maxToolCalls: 1 } });
  assert.equal(r.toolCalls, 0);
  assert.equal(r.status, 'done');
  assert.equal(r.steps, 3, 'two guide steps extended a two-step budget');
  ok('guide tools: no tool call spent, step given back');
}

// 13 · unknown tool and bad arguments are reported to the model, not thrown
{
  const { set } = counter();
  const provider = scriptedModel([{ calls: [{ name: 'nope' }, { name: 'count', args: '{not json' }] }, 'Sorry.']);
  const r = await runAgent({ provider, task, toolsets: [set] });
  const [a, b] = r.messages.filter(m => m.role === 'tool');
  assert.match(a!.content, /^Error: There is no tool named "nope"\. The tools are: count, ask_jev\./);
  assert.match(b!.content, /^Error: /);
  assert.equal(r.status, 'done');
  ok('unknown tool / bad JSON → error result to the model');
}

// 14 · a throwing tool is an error result, not a crash
{
  const boom: AgentTool = { name: 'boom', description: 'b', parameters: { type: 'object', properties: {} }, run: async () => { throw new Error('disk on fire'); } };
  const provider = scriptedModel([{ calls: [{ name: 'boom' }] }, 'It failed.']);
  const r = await runAgent({ provider, task, toolsets: [{ name: 'b', description: 'b', tools: [boom] }] });
  assert.equal(r.messages.find(m => m.role === 'tool')!.content, 'Error: disk on fire');
  ok('tool throw → error result');
}

// 15 · abort: stopped, and every call still has a result
{
  const ac = new AbortController();
  const slow: AgentTool = { name: 'slow', description: 's', parameters: { type: 'object', properties: {} }, run: async () => { ac.abort(); return 'late'; } };
  const provider = scriptedModel([{ calls: [{ name: 'slow' }, { name: 'slow', args: { again: true } }] }]);
  const r = await runAgent({ provider, task, toolsets: [{ name: 's', description: 's', tools: [slow] }], signal: ac.signal });
  assert.equal(r.status, 'stopped');
  const assistant = r.messages.find(m => m.role === 'assistant')!;
  const ids = (assistant as { tool_calls: { id: string }[] }).tool_calls.map(c => c.id);
  const answered = r.messages.filter(m => m.role === 'tool').map(m => (m as { tool_call_id: string }).tool_call_id);
  assert.deepEqual(answered, ids);
  ok('abort → stopped, transcript stays valid');
}

// 16 · opening: a greeting with a welcome costs no worker call
{
  const provider = scriptedModel([], { decide: () => ({ node: { type: 'choice', choice: 'greeting', confidence: 0.95, probabilities: { greeting: 0.95, task: 0.05, small_talk: 0 } } }) });
  const r = await runAgent({ provider, task: { ...task, goal: 'hey', welcome: 'Hi! Ask me anything.' } });
  assert.equal(r.status, 'greeted');
  assert.equal(r.answer, 'Hi! Ask me anything.');
  assert.equal(provider.requests.length, 0);
  ok('opening: greeting → welcome, no worker');
}

// 17 · opening: small talk → one short reply with no tools
{
  const { set } = counter();
  const provider = scriptedModel(['You are welcome!'], { decide: () => ({ node: { type: 'choice', choice: 'small_talk', confidence: 0.9, probabilities: { small_talk: 0.9, task: 0.1, greeting: 0 } } }) });
  const r = await runAgent({ provider, task: { ...task, goal: 'thanks!' }, toolsets: [set] });
  assert.equal(r.status, 'chatted');
  assert.equal(provider.requests[0]!.tools, undefined);
  assert.match(String(provider.requests[0]!.messages.at(-1)!.content), /That is not a task/);
  ok('opening: small talk → one reply, no tools');
}

// 18 · opening: an unclear call is treated as a task
{
  const provider = scriptedModel(['3.'], { decide: () => ({ node: { type: 'choice', choice: 'small_talk', confidence: 0.5, probabilities: { small_talk: 0.55, task: 0.45, greeting: 0 } } }) });
  const r = await runAgent({ provider, task: { ...task, goal: 'ok so apples?' } });
  assert.equal(r.status, 'done');
  ok('opening: below 0.7 → task');
}

// 19 · sessions: loaded before, saved after (no system message)
{
  const store = memorySessions();
  store.sessions.set('s1', [{ role: 'user', content: 'Earlier question' }, { role: 'assistant', content: 'Earlier answer' }]);
  const provider = scriptedModel(['Now.']);
  await runAgent({ provider, task, session: { store, id: 's1' } });
  const sent = provider.requests[0]!.messages;
  assert.equal(sent[1]!.content, 'Earlier question');
  const saved = store.sessions.get('s1')!;
  assert.equal(saved[0]!.role, 'user');
  assert.equal(saved.at(-1)!.content, 'Now.');
  ok('session store: load + save');
}

// 20 · memory, instructions, model notes land in the system prompt
{
  const provider = scriptedModel(['ok'], { model: 'deepseek/deepseek-chat' });
  await runAgent({ provider, task, memory: { recall: async () => ['Prefers metric units'] }, instructions: 'Be terse.' });
  const system = String(provider.requests[0]!.messages[0]!.content);
  assert.match(system, /- Prefers metric units/);
  assert.match(system, /Be terse\./);
  assert.match(system, /never write tool-call markup/);
  assert.match(system, /call ask_jev instead of guessing/);
  ok('system prompt: memory, instructions, model notes, Jev line');
}

// 21 · post-processors transform the final answer
{
  const provider = scriptedModel(['Three apples.']);
  const r = await runAgent({ provider, task, postProcessors: [a => a?.toUpperCase() ?? null, a => `${a}!`] });
  assert.equal(r.answer, 'THREE APPLES.!');
  ok('post-processors applied in order');
}

// 22 · custom prompts replace the defaults
{
  const provider = scriptedModel(['ok']);
  await runAgent({ provider, task, prompts: { system: ['You are the test agent.'], reminder: 'GO: {goal}' } });
  assert.match(String(provider.requests[0]!.messages[0]!.content), /^You are the test agent\./);
  assert.equal(provider.requests[0]!.messages.at(-1)!.content, 'GO: How many apples?');
  ok('PromptPack overrides');
}

// 23 · the worker model: the option wins over the provider default
{
  const provider = scriptedModel(['ok']);
  await runAgent({ provider, task, model: 'some/model' });
  assert.equal(provider.requests[0]!.model, 'some/model');
  ok('model option');
}

// 24 · a server tool (one the provider ran inside the model call) is logged, shown and counted like the loop's own
{
  const { set } = counter();
  const events: { type: string; [key: string]: unknown }[] = [];
  const provider = scriptedModel([
    request => {
      request.onServerTool?.({ id: 's1', name: 'vendor:shell', args: { commands: ['echo 3'] }, ok: true, result: '3' });
      return { message: { role: 'assistant', content: 'There are 3 apples.' }, finishReason: 'stop', model: 'stub/worker', cost: 0.003 };
    },
  ]);
  const r = await runAgent({ provider, task, toolsets: [set], onEvent: e => events.push(e) });
  assert.equal(r.status, 'done');
  assert.equal(r.toolCalls, 1);
  assert.equal(r.cost, 0.003);
  assert.deepEqual(
    events.filter(e => e.type === 'tool_call' || e.type === 'tool_result'),
    [{ type: 'tool_call', id: 's1', name: 'vendor:shell', args: { commands: ['echo 3'] } }, { type: 'tool_result', id: 's1', name: 'vendor:shell', ok: true, result: '3' }]
  );
  ok('server tools: a tool_call and a tool_result event each, counted in toolCalls');
}

console.log(`${n} cases`);
