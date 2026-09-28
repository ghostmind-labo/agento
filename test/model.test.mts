// The OpenRouter client against a mocked fetch: chat, streaming, Jev, errors, the catalogue. Offline.
import assert from 'node:assert/strict';
import { forgetCatalog, ModelError, modelCatalog, openrouter } from '../src/index.ts';

let n = 0;
const ok = (what: string) => console.log(`ok · ${++n} ${what}`);
delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENROUTER_BASE_URL;

type Seen = { url: string; init: RequestInit & { headers: Record<string, string> } };
const mock = (respond: (url: string, body: any) => Response) => {
  const seen: Seen[] = [];
  const fetch = (async (url: string, init: any) => {
    seen.push({ url, init });
    return respond(url, init?.body ? JSON.parse(init.body) : null);
  }) as unknown as typeof globalThis.fetch;
  return { seen, fetch };
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// 1 · chat: body shape, key, extra headers, tool calls, cost
{
  const m = mock(() => json({ model: 'vendor/m-2026', choices: [{ message: { content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{}' } }] }, finish_reason: 'tool_calls' }], usage: { cost: 0.0012 } }));
  const p = openrouter({ apiKey: 'k', model: 'vendor/m', fetch: m.fetch, headers: { 'X-Title': 'MyApp' } });
  const r = await p.chat({ messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'f', description: 'F', parameters: { type: 'object' } }], toolChoice: 'none' });
  const sent = JSON.parse(String(m.seen[0]!.init.body));
  assert.equal(m.seen[0]!.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(m.seen[0]!.init.headers.Authorization, 'Bearer k');
  assert.equal(m.seen[0]!.init.headers['X-Title'], 'MyApp');
  assert.equal(sent.model, 'vendor/m');
  assert.equal(sent.tool_choice, 'none');
  assert.deepEqual(sent.provider, { require_parameters: true });
  assert.equal(r.message.tool_calls![0]!.function.name, 'f');
  assert.equal(r.cost, 0.0012);
  assert.equal(r.model, 'vendor/m-2026');
  ok('chat');
}

// 2 · streaming: text deltas, tool calls assembled from pieces, cost from the last chunk
{
  const lines = [
    ': keep-alive',
    `data: ${JSON.stringify({ model: 'v/m', choices: [{ delta: { content: 'Hel' } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'lo', tool_calls: [{ index: 0, id: 'c1', function: { name: 'lo', arguments: '{"a"' } }] } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'ok', arguments: ':1}' } }] }, finish_reason: 'tool_calls' }], usage: { cost: 0.5 } })}`,
    'data: [DONE]',
  ];
  const m = mock(() => new Response(lines.join('\n') + '\n'));
  const deltas: string[] = [];
  const r = await openrouter({ apiKey: 'k', fetch: m.fetch }).chat({ model: 'v/m', messages: [], onDelta: t => deltas.push(t) });
  assert.deepEqual(deltas, ['Hel', 'lo']);
  assert.equal(r.message.content, 'Hello');
  assert.deepEqual(r.message.tool_calls, [{ id: 'c1', type: 'function', function: { name: 'look', arguments: '{"a":1}' } }]);
  assert.equal(r.cost, 0.5);
  assert.equal(r.finishReason, 'tool_calls');
  assert.equal(JSON.parse(String(m.seen[0]!.init.body)).stream, true);
  ok('stream');
}

// 3 · decide: Jev through /systemone, default alias, a missing answer is an error
{
  const m = mock((_u, body) => json({ answers: { a: { type: 'noul', noul: 0.8 } }, usage: { cost: 0.00002 }, _model: body.model }));
  const p = openrouter({ apiKey: 'k', fetch: m.fetch });
  const r = await p.decide!({ x: 1 }, { a: { type: 'noul', instructions: 'Is it?' } });
  assert.equal(m.seen[0]!.url, 'https://openrouter.ai/api/v1/systemone');
  assert.equal(JSON.parse(String(m.seen[0]!.init.body)).model, 'jev-latest');
  assert.deepEqual(r.answers.a, { type: 'noul', noul: 0.8 });
  assert.equal(r.cost, 0.00002);
  await assert.rejects(p.decide!({}, { a: { type: 'noul', instructions: 'x' }, b: { type: 'noul', instructions: 'y' } }), (e: unknown) => e instanceof ModelError && e.code === 'no_answer');
  ok('decide');
}

// 4 · errors: no key, no model, credits, auth, failure — each with a code an app can map
{
  const code = async (p: Promise<unknown>) => p.then(() => 'none', (e: unknown) => (e instanceof ModelError ? e.code : 'other'));
  assert.equal(await code(openrouter({ model: 'm' }).chat({ messages: [] })), 'no_key');
  assert.equal(await code(openrouter({ apiKey: 'k' }).chat({ messages: [] })), 'no_model');
  for (const [status, want] of [[402, 'credits'], [401, 'auth'], [403, 'auth'], [500, 'failed']] as const) {
    const m = mock(() => json({ error: { message: 'nope' } }, status));
    assert.equal(await code(openrouter({ apiKey: 'k', model: 'm', fetch: m.fetch }).chat({ messages: [] })), want);
  }
  ok('errors carry codes');
}

// 5 · the catalogue: parsed, cached per base url, and what card() reads
{
  forgetCatalog();
  const m = mock(() =>
    json({ data: [{ id: 'v/big', name: 'Big', context_length: 200000, pricing: { prompt: '0.000003', completion: '0.000015' }, supported_parameters: ['tools', 'reasoning'], architecture: { input_modalities: ['text', 'image'] } }] })
  );
  const cards = await modelCatalog({ fetch: m.fetch });
  await modelCatalog({ fetch: m.fetch });
  assert.equal(m.seen.length, 1, 'cached');
  assert.deepEqual(cards[0], { id: 'v/big', name: 'Big', prompt: 0.000003, completion: 0.000015, context: 200000, tools: true, reasoning: true, vision: true });
  const card = await openrouter({ apiKey: 'k', fetch: m.fetch }).card!('v/big');
  assert.equal(card?.name, 'Big');
  assert.equal(await openrouter({ apiKey: 'k', fetch: m.fetch }).card!('v/unknown'), null);
  ok('catalogue + card');
}

console.log(`${n} cases`);
