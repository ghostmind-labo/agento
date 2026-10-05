// The OpenRouter client against a mocked fetch: chat, streaming, Jev, errors, the catalogue. Offline.
import assert from 'node:assert/strict';
import { forgetCatalog, hostedShell, ModelError, modelCatalog, openrouter, type ChatMessage, type ServerToolCall } from '../src/index.ts';

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
    assert.equal(await code(openrouter({ apiKey: 'k', model: 'm', fetch: m.fetch, retryDelayMs: 1 }).chat({ messages: [] })), want);
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

// 6 · passing failures are retried: a 429, a provider relaying a rate limit, a stream that fails before any text
{
  const limited = { error: { message: 'Provider returned error', code: 429, metadata: { provider_name: 'Alibaba', raw: 'qwen/x is temporarily rate-limited upstream' } } };
  let calls = 0;
  const ok200 = () => json({ model: 'm', choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], usage: { cost: 0.001 } });
  let m = mock(() => (++calls < 3 ? json(limited, 429) : ok200()));
  const r = await openrouter({ apiKey: 'k', model: 'm', fetch: m.fetch, retryDelayMs: 1 }).chat({ messages: [] });
  assert.equal(r.message.content, 'hi');
  assert.equal(calls, 3, 'two 429s, then an answer');

  calls = 0;
  m = mock(() => (++calls < 2 ? json(limited, 200) : ok200())); // an error body on a 200
  assert.equal((await openrouter({ apiKey: 'k', model: 'm', fetch: m.fetch, retryDelayMs: 1 }).chat({ messages: [] })).message.content, 'hi');

  calls = 0;
  const good = [`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}`, 'data: [DONE]'].join('\n');
  m = mock(() => new Response(++calls < 2 ? `data: ${JSON.stringify(limited)}\n` : good));
  const deltas: string[] = [];
  const sr = await openrouter({ apiKey: 'k', model: 'm', fetch: m.fetch, retryDelayMs: 1 }).chat({ messages: [], onDelta: d => deltas.push(d) });
  assert.equal(sr.message.content, 'ok');
  assert.deepEqual(deltas, ['ok'], 'nothing was shown twice');

  calls = 0;
  m = mock(() => (++calls, json(limited, 429)));
  const err = await openrouter({ apiKey: 'k', model: 'm', fetch: m.fetch, retries: 2, retryDelayMs: 1 }).chat({ messages: [] }).catch((e: unknown) => e);
  assert.ok(err instanceof ModelError && err.code === 'rate_limited');
  assert.match((err as Error).message, /\[Alibaba\]: qwen\/x is temporarily rate-limited upstream \(after 2 retries\)$/);
  assert.equal(calls, 3);

  calls = 0;
  m = mock(() => (++calls, json({ error: { message: 'bad request' } }, 400)));
  await openrouter({ apiKey: 'k', model: 'm', fetch: m.fetch, retryDelayMs: 1 }).chat({ messages: [] }).catch(() => {});
  assert.equal(calls, 1, 'a 400 is not retried');
  ok('retries: 429, error-on-200, stream before text; gives up with rate_limited; 400 not retried');
}

// 7 · a dropped connection is retried (longer than a rate limit), then reported as 'network' — never a bare TypeError
{
  let calls = 0;
  const drop = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  const flaky = (async () => {
    if (++calls < 3) throw drop();
    return json({ model: 'm', choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], usage: { cost: 0 } });
  }) as unknown as typeof globalThis.fetch;
  const r = await openrouter({ apiKey: 'k', model: 'm', fetch: flaky, retryDelayMs: 1 }).chat({ messages: [] });
  assert.equal(r.message.content, 'hi');
  assert.equal(calls, 3, 'two dropped connections, then an answer');

  calls = 0;
  const dead = (async () => { calls++; throw drop(); }) as unknown as typeof globalThis.fetch;
  const err = await openrouter({ apiKey: 'k', model: 'm', fetch: dead, retries: 2, retryDelayMs: 1 }).chat({ messages: [] }).catch((e: unknown) => e);
  assert.ok(err instanceof ModelError && err.code === 'network');
  assert.match((err as Error).message, /Cannot reach OpenRouter \(ENOTFOUND\).*\(after 2 retries\)$/);
  assert.equal(calls, 3);

  // The caller's own abort is not a network problem and is not retried.
  calls = 0;
  const ac = new AbortController();
  const aborting = (async () => { calls++; ac.abort(); throw new DOMException('aborted', 'AbortError'); }) as unknown as typeof globalThis.fetch;
  const aborted = await openrouter({ apiKey: 'k', model: 'm', fetch: aborting, retryDelayMs: 1 }).chat({ messages: [], signal: ac.signal }).catch((e: unknown) => e);
  assert.ok(!(aborted instanceof ModelError), 'the abort surfaces as itself');
  assert.equal(calls, 1);
  ok('network errors: retried, then code network; an abort is left alone');
}

// The shapes below are OpenRouter's own, as a live call returned them (2026-10-05).
const shellItem = (id: string, command: string, stdout: string, exit = 0) => ({
  type: 'openrouter:shell', id: `st_${id}`, status: 'completed', call_id: id, container_id: 'gen_x',
  action: { commands: [command], max_output_length: null, timeout_ms: null },
  output: [{ stdout, stderr: '', outcome: { type: 'exit', exit_code: exit } }],
  arguments: JSON.stringify({ commands: [command] }),
});
const reasoning = { id: 'rs_1', type: 'reasoning', status: 'completed', content: [{ type: 'reasoning_text', text: 'thinking' }], summary: [] };
const said = (text: string) => ({ id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });

// 8 · the Responses API: server tools beside function tools, the conversation as input items, what a server tool did reported and carried on
{
  const replies = [
    { model: 'vendor/m-2026', status: 'completed', output: [reasoning, shellItem('c1', 'python3 -c "print(17*23)"', '391\n'), { id: 'fc_1', type: 'function_call', status: 'completed', call_id: 'f1', name: 'f', arguments: '{"x":1}' }], usage: { cost: 0.0032, cost_details: { server_tool_cost: 0.003 } } },
    { model: 'vendor/m-2026', status: 'completed', output: [said('391, and f says ok.')], usage: { cost: 0.0001 } },
  ];
  const m = mock(() => json(replies.shift()));
  const p = openrouter({ apiKey: 'k', model: 'vendor/m', fetch: m.fetch, serverTools: [hostedShell()] });
  const seen: ServerToolCall[] = [];
  const tools = [{ name: 'f', description: 'F', parameters: { type: 'object' } }];
  const messages: ChatMessage[] = [{ role: 'system', content: 'S' }, { role: 'user', content: 'go' }];
  const first = await p.chat({ messages, tools, onServerTool: call => seen.push(call) });

  const sent = JSON.parse(String(m.seen[0]!.init.body));
  assert.equal(m.seen[0]!.url, 'https://openrouter.ai/api/v1/responses');
  assert.deepEqual(sent.input, [{ role: 'system', content: 'S' }, { role: 'user', content: 'go' }]);
  assert.deepEqual(sent.tools, [{ type: 'openrouter:shell', parameters: { engine: 'openrouter' } }, { type: 'function', name: 'f', description: 'F', parameters: { type: 'object' } }]);
  assert.equal(sent.tool_choice, 'auto');
  assert.equal(sent.max_output_tokens, 4096);
  assert.deepEqual(sent.provider, { require_parameters: true });
  assert.ok(!('messages' in sent) && !('stream' in sent));

  // the function call is the loop's to run; the shell call already ran, and is reported with its output
  assert.deepEqual(first.message, { role: 'assistant', content: null, tool_calls: [{ id: 'f1', type: 'function', function: { name: 'f', arguments: '{"x":1}' } }] });
  assert.equal(first.finishReason, 'tool_calls');
  assert.equal(first.cost, 0.0032, 'the cost is the call as billed, sandbox time included');
  assert.equal(first.model, 'vendor/m-2026');
  assert.deepEqual(seen, [{ id: 'c1', name: 'openrouter:shell', args: { commands: ['python3 -c "print(17*23)"'], max_output_length: null, timeout_ms: null }, ok: true, result: '391' }]);

  // the next step: nothing is kept on OpenRouter's side, so the shell item goes back as it came, before that step's own call
  messages.push(first.message, { role: 'tool', tool_call_id: 'f1', content: 'ok' });
  const second = await p.chat({ messages, tools, toolChoice: 'none' });
  const next = JSON.parse(String(m.seen[1]!.init.body));
  assert.deepEqual(next.input.slice(2), [shellItem('c1', 'python3 -c "print(17*23)"', '391\n'), { type: 'function_call', call_id: 'f1', name: 'f', arguments: '{"x":1}' }, { type: 'function_call_output', call_id: 'f1', output: 'ok' }]);
  assert.equal(next.tool_choice, 'none');
  assert.deepEqual(second.message, { role: 'assistant', content: '391, and f says ok.' });
  assert.equal(second.finishReason, 'stop');

  // a command that failed, one that timed out; `api: 'responses'` alone (no server tool); a chat provider is unchanged
  const bad = mock(() => json({ status: 'completed', output: [shellItem('c2', 'false', '', 1), { ...shellItem('c3', 'sleep 999', ''), output: [{ stdout: 'x', stderr: 'late', outcome: { type: 'timeout' } }] }, said('done')], usage: { cost: 0 } }));
  const calls: ServerToolCall[] = [];
  await openrouter({ apiKey: 'k', model: 'm', fetch: bad.fetch, serverTools: [hostedShell({ environment: { type: 'container_auto' } })] }).chat({ messages: [], onServerTool: c => calls.push(c) });
  assert.deepEqual(calls.map(c => [c.ok, c.result]), [[false, '(exit code 1)'], [false, 'x\nstderr: late\n(timed out)']]);
  assert.deepEqual(JSON.parse(String(bad.seen[0]!.init.body)).tools[0], { type: 'openrouter:shell', parameters: { engine: 'openrouter', environment: { type: 'container_auto' } } });
  const plain = mock(() => json({ status: 'completed', output: [said('hi')], usage: { cost: 0 } }));
  await openrouter({ apiKey: 'k', model: 'm', fetch: plain.fetch, api: 'responses' }).chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.ok(plain.seen[0]!.url.endsWith('/responses') && !('tools' in JSON.parse(String(plain.seen[0]!.init.body))));
  assert.throws(() => openrouter({ apiKey: 'k', api: 'chat', serverTools: [hostedShell()] }), /Server tools need the Responses API/);
  // a reply that may call nothing and is shown no tool (small talk) is not offered the shell
  const quiet = mock(() => json({ status: 'completed', output: [said('hello')], usage: { cost: 0 } }));
  await openrouter({ apiKey: 'k', model: 'm', fetch: quiet.fetch, serverTools: [hostedShell()] }).chat({ messages: [{ role: 'user', content: 'hi' }], toolChoice: 'none' });
  assert.ok(!('tools' in JSON.parse(String(quiet.seen[0]!.init.body))));
  const failed = mock(() => json({ status: 'failed', error: { message: 'no provider runs this tool' }, output: [] }));
  await assert.rejects(openrouter({ apiKey: 'k', model: 'm', fetch: failed.fetch, api: 'responses' }).chat({ messages: [] }), /no provider runs this tool/);
  ok('responses: server tools + function tools, input items, shell calls reported and carried to the next step, cost as billed');
}

// 9 · the Responses API, streamed: text as it comes, a server tool the moment it has its result (once), the reply from the last event
{
  const item = shellItem('c1', 'echo hi', 'hi\n');
  const done = { model: 'vendor/m-2026', status: 'completed', output: [reasoning, item, said('It printed hi.')], usage: { cost: 0.0031 } };
  const events = [
    { type: 'response.created', response: { status: 'in_progress', output: [] } },
    { type: 'response.reasoning_text.delta', delta: 'thinking' },
    { type: 'response.output_item.done', item: reasoning },
    { type: 'response.output_item.done', item },
    { type: 'response.output_text.delta', delta: 'It printed ' },
    { type: 'response.output_text.delta', delta: 'hi.' },
    { type: 'response.completed', response: done },
  ];
  const sse = (list: unknown[]) => new Response(list.map(e => `: keep-alive\n\ndata: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  const order: string[] = [];
  const m = mock(() => sse(events));
  const r = await openrouter({ apiKey: 'k', model: 'vendor/m', fetch: m.fetch, serverTools: [hostedShell()] }).chat({
    messages: [{ role: 'user', content: 'run echo hi' }],
    onDelta: text => order.push(`delta:${text}`),
    onServerTool: call => order.push(`tool:${call.name}:${call.result}`),
  });
  assert.equal(JSON.parse(String(m.seen[0]!.init.body)).stream, true);
  assert.deepEqual(order, ['tool:openrouter:shell:hi', 'delta:It printed ', 'delta:hi.']);
  assert.deepEqual(r, { message: { role: 'assistant', content: 'It printed hi.' }, finishReason: 'stop', model: 'vendor/m-2026', cost: 0.0031 });

  // a stream that fails before anything arrived is tried again; one that fails after is not
  let tries = 0;
  const flaky = mock(() => (++tries === 1 ? sse([{ type: 'response.failed', response: { error: { message: 'overloaded', code: 529 } } }]) : sse(events)));
  await openrouter({ apiKey: 'k', model: 'm', fetch: flaky.fetch, api: 'responses', retryDelayMs: 1 }).chat({ messages: [], onDelta: () => {} });
  assert.equal(tries, 2);
  const late = mock(() => sse([events[4], { type: 'error', error: { message: 'overloaded', code: 529 } }]));
  const error = await openrouter({ apiKey: 'k', model: 'm', fetch: late.fetch, api: 'responses', retryDelayMs: 1 }).chat({ messages: [], onDelta: () => {} }).catch((e: unknown) => e);
  assert.ok(error instanceof ModelError && !error.retryable && late.seen.length === 1);
  ok('responses, streamed: deltas, the server tool once and as soon as it ran, retried only before anything arrived');
}

console.log(`${n} cases`);
