// Tool helpers: folding, forgiving arguments, MCP sessions as toolsets.
import assert from 'node:assert/strict';
import { foldTools, forgivingArgs, mcpToolset, readCall, runAgent, scriptedModel, stableJson, type AgentTool, type McpLike } from '../src/index.ts';

let n = 0;
const ok = (what: string) => console.log(`ok · ${++n} ${what}`);
const ctx = { signal: new AbortController().signal, spend: () => {}, callId: 'c1' };

// 1 · stableJson: key order never matters, nested arguments survive
{
  assert.equal(stableJson({ b: 1, a: { d: [1, { f: 2, e: 1 }], c: undefined } }), '{"a":{"d":[1,{"e":1,"f":2}]},"b":1}');
  ok('stableJson');
}

// 2 · forgivingArgs and readCall read every shape models send
{
  assert.deepEqual(forgivingArgs('{"tags":"[\\"a\\"]","n":3}'), { tags: ['a'], n: 3 });
  assert.deepEqual(forgivingArgs({ q: '{not json' }), { q: '{not json' });
  assert.deepEqual(readCall({ action: 'find', args: { q: 'x' } }), { name: 'find', args: { q: 'x' } });
  assert.deepEqual(readCall({ action: 'find', q: 'x' }), { name: 'find', args: { q: 'x' } }, 'arguments beside action');
  assert.deepEqual(readCall({ action: 'find<arg_key>args</arg_key><arg_value>{"q":"x","n":2}</arg_value>' }), { name: 'find', args: { q: 'x', n: 2 } }, 'GLM packs args into the name');
  ok('forgivingArgs + readCall');
}

// 3 · foldTools: one tool, a reference of every action, writes still ask approval
{
  const saved: unknown[] = [];
  const find: AgentTool = { name: 'find', description: 'Find items. More words.', parameters: { type: 'object', properties: { q: { type: 'string' }, n: { type: 'number' } }, required: ['q'] }, run: async a => `found ${a.q}` };
  const put: AgentTool = { name: 'put', description: 'Store an item.', parameters: { type: 'object', properties: { item: { type: 'string' } } }, write: { describe: a => `Store ${a.item}` }, run: async a => { saved.push(a); return 'stored'; } };
  const one = foldTools([{ name: 'items', description: 'Items.', tools: [find, put] }], { name: 'app', description: 'Everything in the app.', appendix: 'Grammar: …' });
  assert.equal(one.name, 'app');
  assert.match(one.description, /find \{ q, n\? \} — Find items\./);
  assert.match(one.description, /put \{ item\? \} \[asks approval\]/);
  assert.match(one.description, /Grammar: …$/);
  assert.equal(await one.write!.describe({ action: 'find', args: { q: 'a' } }), null);
  assert.equal(await one.write!.describe({ action: 'put', item: 'x' }), 'Store x');
  assert.equal(await one.run({ action: 'find', args: '{"q":"a"}' }, ctx), 'found a');
  await assert.rejects(one.run({ action: 'nope' }, ctx), /no action "nope"\. Actions: find, put/);

  const approvals: string[] = [];
  const provider = scriptedModel([{ calls: [{ name: 'app', args: { action: 'put', args: { item: 'pear' } } }] }, 'Stored.'], { decide: false });
  await runAgent({ provider, task: { goal: 'store a pear', expectation: 'ok' }, toolsets: [{ name: 'a', description: 'a', tools: [one] }], approve: async r => { approvals.push(r.summary); return true; } });
  assert.deepEqual(approvals, ['Store pear']);
  assert.deepEqual(saved, [{ item: 'pear' }]);
  ok('foldTools');
}

// 4 · mcpToolset: an MCP session (ensemble's shape) becomes a toolset; errors and writes carried
{
  const calls: [string, Record<string, unknown>][] = [];
  const session: McpLike = {
    name: 'files',
    listTools: async () => [
      { name: 'read_file', description: 'Read a file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
      { name: 'write_file', description: 'Write a file.' },
      { name: 'secret', description: 'Hidden.' },
    ],
    call: async (tool, args) => {
      calls.push([tool, args]);
      if (args.path === 'missing') return { text: 'ENOENT', isError: true };
      return tool === 'read_file' ? { text: 'hello', isError: false } : { text: 'ok', data: { written: true }, isError: false };
    },
  };
  const set = await mcpToolset(session, { only: ['read_file', 'write_file'], writes: t => (t === 'write_file' ? 'Write a file' : null) });
  assert.equal(set.name, 'files');
  assert.deepEqual(set.tools.map(t => t.name), ['read_file', 'write_file']);
  assert.equal(await set.tools[0]!.run({ path: 'a' }, ctx), 'hello');
  assert.deepEqual(await set.tools[1]!.run({ path: 'a' }, ctx), { written: true }, 'structured content wins');
  await assert.rejects(set.tools[0]!.run({ path: 'missing' }, ctx), /ENOENT/);
  assert.equal(await set.tools[0]!.write!.describe({}), null);
  assert.equal(await set.tools[1]!.write!.describe({}), 'Write a file');
  ok('mcpToolset');
}

console.log(`${n} cases`);
