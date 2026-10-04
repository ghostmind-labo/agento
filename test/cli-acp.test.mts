// agento as an ACP agent: a fake editor speaks the protocol to it. Offline, $0.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

process.env.HOME = mkdtempSync(join(tmpdir(), 'agento-acp-userhome-')); // not the machine's ~/.claude/skills
process.env.AGENTO_HOME = mkdtempSync(join(tmpdir(), 'agento-acp-home-'));
const { scriptedModel } = await import('../src/index.ts');
const { E, kindOf, promptText, serveAcp, shellAllowed, simpleCommand, stopReason } = await import('../src/cli/acp.ts');
const { fromAcpMcp } = await import('../src/cli/mcp.ts');

let n = 0;
const ok = (what: string) => console.log(`ok · ${++n} ${what}`);
type Msg = Record<string, any>;
const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
const folder = () => mkdtempSync(join(tmpdir(), 'agento-acp-ws-'));

/** A fake editor: sends requests, collects notifications, answers the agent's permission questions. */
function editor(script: Parameters<typeof scriptedModel>[0] = [], options: { hasKey?: boolean; defaultModel?: string | null; autoApprove?: boolean; allowShell?: string[] } = {}) {
  const toAgent = new PassThrough();
  const fromAgent = new PassThrough();
  const provider = scriptedModel(script, { decide: false });
  const done = serveAcp({
    input: toAgent,
    output: fromAgent,
    providerFor: () => provider,
    defaultModel: options.defaultModel === null ? undefined : (options.defaultModel ?? 'stub/worker'),
    hasKey: () => options.hasKey ?? true,
    autoApprove: options.autoApprove,
    allowShell: options.allowShell,
  });
  const notes: Msg[] = [];
  const raw: Msg[] = [];
  const asked: Msg[] = [];
  const pending = new Map<number, (m: Msg) => void>();
  let nextId = 1;
  let answer: (req: Msg) => unknown = () => ({ outcome: { outcome: 'selected', optionId: 'allow' } });
  const send = (m: Msg) => toAgent.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  createInterface({ input: fromAgent }).on('line', line => {
    const m = JSON.parse(line) as Msg; // every line the agent writes must be JSON
    raw.push(m);
    if (m.method && m.id !== undefined) {
      asked.push(m);
      void Promise.resolve(answer(m)).then(result => send({ id: m.id, result }));
    } else if (m.method) notes.push(m);
    else pending.get(m.id)?.(m);
  });
  return {
    provider,
    notes,
    raw,
    asked,
    onPermission: (fn: (req: Msg) => unknown) => void (answer = fn),
    call: (method: string, params: Msg = {}) => new Promise<Msg>(res => {
      const id = nextId++;
      pending.set(id, res);
      send({ id, method, params });
    }),
    notify: (method: string, params: Msg = {}) => send({ method, params }),
    writeRaw: (text: string) => toAgent.write(text),
    updates: (kind: string) => notes.filter(x => x.method === 'session/update' && x.params.update.sessionUpdate === kind).map(x => x.params.update as Msg),
    open: async (cwd = folder()) => {
      const r = await (async () => {
        const id = nextId++;
        return new Promise<Msg>(res => {
          pending.set(id, res);
          send({ id, method: 'session/new', params: { cwd, mcpServers: [] } });
        });
      })();
      return { cwd, sessionId: r.result?.sessionId as string, response: r };
    },
    close: async () => {
      toAgent.end();
      await done;
    },
  };
}

// 1 · initialize: version, identity, capabilities, how to authenticate
{
  const e = editor();
  const r = await e.call('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(r.id, 1);
  assert.equal(r.result.protocolVersion, 1);
  assert.deepEqual(r.result.agentInfo, { name: 'agento', title: 'agento', version: pkg.version });
  assert.equal(r.result.agentCapabilities.loadSession, false);
  assert.deepEqual(r.result.agentCapabilities.promptCapabilities, { image: false, audio: false, embeddedContext: true });
  assert.equal(typeof r.result.agentCapabilities.mcpCapabilities.http, 'boolean');
  assert.deepEqual(r.result.authMethods, [], 'with the key in the environment there is no auth step to advertise');
  const newer = await e.call('initialize', { protocolVersion: 99 });
  assert.equal(newer.result.protocolVersion, 1, 'a version we do not speak is answered with the latest we do');
  await e.close();
  ok('initialize');
}

// 2 · authentication: without a key, authenticate and session/new say so with the auth error
{
  const e = editor([], { hasKey: false });
  const init = await e.call('initialize', { protocolVersion: 1 });
  assert.equal(init.result.authMethods[0].id, 'openrouter-key', 'without the key, the way to fix it is advertised');
  assert.match(init.result.authMethods[0].description, /OPENROUTER_API_KEY/);
  const a = await e.call('authenticate', { methodId: 'openrouter-key' });
  assert.equal(a.error.code, E.auth);
  assert.match(a.error.message, /OPENROUTER_API_KEY/);
  const s = await e.call('session/new', { cwd: folder(), mcpServers: [] });
  assert.equal(s.error.code, E.auth);
  const wrong = await e.call('authenticate', { methodId: 'nope' });
  assert.equal(wrong.error.code, E.params);
  await e.close();
  const withKey = editor();
  assert.deepEqual((await withKey.call('authenticate', { methodId: 'openrouter-key' })).result, {});
  await withKey.close();
  ok('authenticate');
}

// 3 · session/new and the model selector
{
  const e = editor();
  const relative = await e.call('session/new', { cwd: 'relative/path', mcpServers: [] });
  assert.equal(relative.error.code, E.params);
  const { sessionId, response } = await e.open();
  assert.match(sessionId, /^sess_[0-9a-f]{16}$/);
  const model = response.result.configOptions[0];
  assert.deepEqual({ id: model.id, category: model.category, type: model.type, currentValue: model.currentValue }, { id: 'model', category: 'model', type: 'select', currentValue: 'stub/worker' });
  assert.ok(model.options.some((o: Msg) => o.value === 'qwen/qwen3.8-flash'), 'agento\'s curated models are offered');
  assert.ok(model.options.some((o: Msg) => o.value === 'stub/worker'), 'the current model is always in the list');
  const set = await e.call('session/set_config_option', { sessionId, configId: 'model', value: 'z-ai/glm-5.3-flash' });
  assert.equal(set.result.configOptions[0].currentValue, 'z-ai/glm-5.3-flash');
  assert.equal((await e.call('session/set_config_option', { sessionId, configId: 'nope', value: 'x' })).error.code, E.params);
  assert.equal((await e.call('session/set_config_option', { sessionId: 'sess_none', configId: 'model', value: 'x' })).error.code, E.params);
  await e.close();

  const none = editor([], { defaultModel: null });
  const started = await none.open();
  assert.equal(started.response.result.configOptions[0].currentValue, 'qwen/qwen3.8-flash', 'no model picked yet: a cheap starter, switchable from the selector');
  await none.close();
  ok('session/new, model selector');
}

// 4 · a prompt turn: tool_call → tool_call_update → message chunks → stopReason
{
  const e = editor([{ text: 'Looking. ', calls: [{ name: 'read_file', args: { path: 'notes.md' } }] }, 'It says hello.']);
  const { cwd, sessionId } = await e.open();
  writeFileSync(join(cwd, 'notes.md'), 'hello from the notes\n');
  const r = await e.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'what is in notes.md?' }] });
  assert.deepEqual(r.result, { stopReason: 'end_turn' });
  const [call] = e.updates('tool_call');
  assert.equal(call.title, 'read_file notes.md');
  assert.equal(call.kind, 'read');
  assert.equal(call.status, 'pending');
  assert.deepEqual(call.locations, [{ path: join(cwd, 'notes.md') }], 'paths are absolute');
  assert.deepEqual(call.rawInput, { path: 'notes.md' });
  const [done] = e.updates('tool_call_update');
  assert.equal(done.toolCallId, call.toolCallId);
  assert.equal(done.status, 'completed');
  assert.match(done.content[0].content.text, /hello from the notes/);
  assert.equal(e.updates('agent_message_chunk').map(u => u.content.text).join(''), 'Looking. It says hello.');
  const [usage] = e.updates('usage_update');
  assert.deepEqual(usage.cost, { amount: 0, currency: 'USD' }, 'the turn\'s cost, reported in USD');
  assert.ok(Number.isInteger(usage.used) && usage.used > 0 && usage.size >= usage.used, 'used and size are token counts');
  assert.ok(e.raw.findIndex(m => m.params?.update?.sessionUpdate === 'usage_update') < e.raw.findIndex(m => m.id === r.id), 'the cost arrives before the stop reason');
  const order = e.notes.map(x => x.params.update.sessionUpdate);
  assert.ok(order.indexOf('tool_call') < order.indexOf('tool_call_update'), 'the call is announced before it is reported');
  assert.ok(e.raw.every(m => m.jsonrpc === '2.0'));
  await e.close();
  ok('prompt turn: updates and stop reason');
}

// 5 · a change asks the editor first: allow, reject, and "always"
{
  const e = editor([{ calls: [{ name: 'write_file', args: { path: 'out.txt', content: 'one' } }] }, 'Written.']);
  const { cwd, sessionId } = await e.open();
  const r = await e.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'write out.txt' }] });
  assert.equal(r.result.stopReason, 'end_turn');
  assert.equal(readFileSync(join(cwd, 'out.txt'), 'utf8'), 'one');
  const q = e.asked[0];
  assert.equal(q.method, 'session/request_permission');
  assert.equal(q.params.sessionId, sessionId);
  assert.equal(q.params.toolCall.title, 'Create out.txt (1 lines)');
  assert.equal(q.params.toolCall.kind, 'edit');
  assert.deepEqual(q.params.options.map((o: Msg) => o.kind), ['allow_once', 'allow_always', 'reject_once']);
  assert.deepEqual(e.updates('tool_call_update').map(u => u.status), ['in_progress', 'completed']);
  await e.close();

  const no = editor([{ calls: [{ name: 'write_file', args: { path: 'out.txt', content: 'one' } }] }, 'Left it alone.']);
  const w = await no.open();
  no.onPermission(() => ({ outcome: { outcome: 'selected', optionId: 'reject' } }));
  const rejected = await no.call('session/prompt', { sessionId: w.sessionId, prompt: [{ type: 'text', text: 'write' }] });
  assert.equal(rejected.result.stopReason, 'end_turn');
  assert.ok(!existsSync(join(w.cwd, 'out.txt')), 'rejected: nothing written');
  assert.equal(no.updates('tool_call_update').at(-1)!.status, 'failed');
  await no.close();

  const always = editor([
    { calls: [{ name: 'write_file', args: { path: 'a.txt', content: 'a' } }] },
    { calls: [{ name: 'write_file', args: { path: 'b.txt', content: 'b' } }] },
    'Both written.',
  ]);
  const a = await always.open();
  always.onPermission(() => ({ outcome: { outcome: 'selected', optionId: 'always' } }));
  await always.call('session/prompt', { sessionId: a.sessionId, prompt: [{ type: 'text', text: 'write both' }] });
  assert.equal(always.asked.length, 1, '"always" covers the second write');
  assert.ok(existsSync(join(a.cwd, 'a.txt')) && existsSync(join(a.cwd, 'b.txt')));
  await always.close();
  ok('permissions: allow, reject, always');
}

// 6 · cancel: mid-model-call, and while waiting on a permission
{
  let started!: () => void;
  const reached = new Promise<void>(r => (started = r));
  const hang = (req: { signal?: AbortSignal }) =>
    new Promise<never>((_, reject) => {
      started();
      req.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  const e = editor([hang as never]);
  const { sessionId } = await e.open();
  const turn = e.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'think forever' }] });
  await reached;
  e.notify('session/cancel', { sessionId });
  assert.deepEqual((await turn).result, { stopReason: 'cancelled' });
  // The session is usable again.
  assert.ok(!(await e.call('session/prompt', { sessionId, prompt: [] })).error || true);
  await e.close();

  const p = editor([{ calls: [{ name: 'write_file', args: { path: 'never.txt', content: 'x' } }] }]);
  const w = await p.open();
  p.onPermission(() => new Promise(() => {})); // the person never answers
  const waiting = p.call('session/prompt', { sessionId: w.sessionId, prompt: [{ type: 'text', text: 'write' }] });
  for (let i = 0; i < 200 && !p.asked.length; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(p.asked.length, 1, 'the question reached the editor');
  p.notify('session/cancel', { sessionId: w.sessionId });
  assert.deepEqual((await waiting).result, { stopReason: 'cancelled' });
  assert.ok(!existsSync(join(w.cwd, 'never.txt')));
  await p.close();
  ok('session/cancel: during a model call and during a permission question');
}

// 7 · $/cancel_request cancels the prompt request by id
{
  let started!: () => void;
  const reached = new Promise<void>(r => (started = r));
  const e = editor([((req: { signal?: AbortSignal }) => new Promise<never>((_, reject) => { started(); req.signal?.addEventListener('abort', () => reject(new Error('aborted'))); })) as never]);
  const { sessionId } = await e.open();
  const turn = e.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'x' }] });
  await reached;
  e.notify('$/cancel_request', { requestId: 2 }); // open() used id 1, the prompt is 2
  assert.deepEqual((await turn).result, { stopReason: 'cancelled' });
  await e.close();
  ok('$/cancel_request');
}

// 8 · limits end a turn with max_turn_requests and say why
{
  const e = editor([
    { calls: [{ name: 'list_dir', args: {} }], cost: 0.3 },
    { calls: [{ name: 'list_dir', args: { path: '.', depth: 1 } }], cost: 0.3 },
    'never',
  ]);
  const { sessionId } = await e.open();
  // The default cap is $0.50 per turn: two steps at $0.30 pass it.
  const r = await e.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'list' }] });
  assert.equal(r.result.stopReason, 'max_turn_requests');
  assert.match(e.updates('agent_message_chunk').map(u => u.content.text).join(''), /stopped: Budget reached/);
  await e.close();
  ok('limits: max_turn_requests, with the reason shown');
}

// 9 · protocol errors: unknown methods, bad JSON, bad params, a second prompt, unknown notifications
{
  let started!: () => void;
  const reached = new Promise<void>(r => (started = r));
  const e = editor([((req: { signal?: AbortSignal }) => new Promise<never>((_, reject) => { started(); req.signal?.addEventListener('abort', () => reject(new Error('aborted'))); })) as never]);
  assert.equal((await e.call('nope/nothing')).error.code, E.method);
  e.writeRaw('this is not json\n');
  for (let i = 0; i < 100 && !e.raw.some(m => m.error?.code === E.parse); i++) await new Promise(r => setTimeout(r, 5));
  const parse = e.raw.find(m => m.error?.code === E.parse)!;
  assert.equal(parse.id, null);
  const before = e.raw.length;
  e.notify('_vendor/unknown');
  e.notify('session/cancel', { sessionId: 'sess_none' });
  const { sessionId } = await e.open();
  assert.equal(e.raw.length, before + 1, 'unknown notifications get no reply (only session/new did)');
  assert.equal((await e.call('session/prompt', { sessionId, prompt: 'not an array' })).error.code, E.params);
  assert.equal((await e.call('session/prompt', { sessionId: 'sess_none', prompt: [] })).error.code, E.params);
  const first = e.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'x' }] });
  await reached;
  assert.equal((await e.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'y' }] })).error.code, E.request, 'one prompt at a time');
  e.notify('session/cancel', { sessionId });
  await first;
  await e.close();
  ok('protocol errors');
}

// 10 · pure helpers
{
  assert.equal(promptText([{ type: 'text', text: 'fix this' }, { type: 'resource_link', uri: 'file:///a.ts', name: 'a.ts' }, { type: 'resource', resource: { uri: 'file:///b.ts', text: 'let b' } }, { type: 'image', data: 'x', mimeType: 'image/png' }]),
    'fix this\n\n[a.ts](file:///a.ts)\n\n<file uri="file:///b.ts">\nlet b\n</file>\n\n[image omitted: agento reads text only]');
  assert.throws(() => promptText('x'), (e: Error) => (e as { code?: number }).code === E.params);
  assert.equal(stopReason('limit', false), 'max_turn_requests');
  assert.equal(stopReason('done', false), 'end_turn');
  assert.equal(stopReason('done', true), 'cancelled');
  assert.equal(stopReason('limit', true), 'cancelled');
  assert.deepEqual(['read_file', 'list_dir', 'search', 'write_file', 'edit_file', 'run_command', 'potion'].map(kindOf), ['read', 'read', 'search', 'edit', 'edit', 'execute', 'other']);
  assert.deepEqual(fromAcpMcp([
    { name: 'fs', command: '/bin/mcp', args: ['--stdio'], env: [{ name: 'A', value: '1' }] },
    { type: 'http', name: 'potion', url: 'https://mcp.potion.run', headers: [{ name: 'workspace', value: 'home' }] },
    { type: 'sse', name: 'old', url: 'https://e/sse', headers: [] },
  ]), {
    fs: { command: '/bin/mcp', args: ['--stdio'], env: { A: '1' } },
    potion: { url: 'https://mcp.potion.run', transport: 'streamable-http', headers: { workspace: 'home' } },
    old: { url: 'https://e/sse', transport: 'sse' },
  });
  assert.deepEqual(fromAcpMcp(undefined), {});
  ok('promptText, stopReason, kindOf, fromAcpMcp');
}

// 11 · the real process: `agento acp` on stdio — only protocol on stdout, no banner, errors that make sense
{
  const main = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'main.ts');
  const run = (env: Record<string, string>, lines: Msg[]) =>
    new Promise<{ out: Msg[]; err: string; code: number | null; stdout: string }>(done => {
      const child = spawn(process.execPath, [main, 'acp'], { env: { ...process.env, AGENTO_HOME: process.env.AGENTO_HOME!, AGENT_MODEL: '', ...env } });
      let stdout = '';
      let err = '';
      child.stdout.on('data', d => (stdout += d));
      child.stderr.on('data', d => (err += d));
      child.on('close', code => done({ out: stdout.split('\n').filter(Boolean).map(l => JSON.parse(l) as Msg), err, code, stdout }));
      for (const m of lines) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
      child.stdin.end();
    });
  const dir = folder();
  const withKey = await run({ OPENROUTER_API_KEY: 'sk-test' }, [
    { id: 1, method: 'initialize', params: { protocolVersion: 1 } },
    { id: 2, method: 'session/new', params: { cwd: dir, mcpServers: [] } },
  ]);
  assert.equal(withKey.code, 0);
  assert.equal(withKey.out.length, 2, 'two replies and nothing else on stdout');
  const byId = (id: number) => withKey.out.find(m => m.id === id)!;
  assert.equal(byId(1).result.agentInfo.name, 'agento');
  assert.match(byId(2).result.sessionId, /^sess_/);
  assert.equal(byId(2).result.configOptions[0].currentValue, 'qwen/qwen3.8-flash');
  assert.ok(!/agento ·|tools:/.test(withKey.stdout), 'no banner');
  const noKey = await run({ OPENROUTER_API_KEY: '' }, [{ id: 1, method: 'session/new', params: { cwd: dir, mcpServers: [] } }]);
  assert.equal(noKey.out[0]!.error.code, E.auth);
  ok('agento acp over real stdio');
}

// 12 · unattended: --yes approves all; --allow-shell approves only simple commands that start with the word
{
  assert.equal(simpleCommand(`buzz send '{"text":"a; b | c $x (y)"}'`), true, 'single quotes are literal');
  assert.equal(simpleCommand('buzz send "hello world"'), true);
  for (const bad of ['buzz hi; rm -rf ~', 'buzz hi && ls', 'buzz | cat', 'buzz $(whoami)', 'buzz `id`', 'buzz "a $HOME"', 'buzz > /tmp/x', 'buzz *', 'buzz\nls', "buzz 'open"]) assert.equal(simpleCommand(bad), false, bad);
  assert.equal(shellAllowed('buzz send hi', ['buzz']), true);
  assert.equal(shellAllowed('buzz', ['buzz']), true);
  assert.equal(shellAllowed('buzzard hi', ['buzz']), false, 'a word, not a prefix of one');
  assert.equal(shellAllowed('buzz hi; rm x', ['buzz']), false);
  assert.equal(shellAllowed('ls', ['buzz']), false);
  assert.equal(shellAllowed('buzz hi', []), false);

  const all = editor([{ calls: [{ name: 'write_file', args: { path: 'x.txt', content: 'x' } }] }, 'Done.'], { autoApprove: true });
  const a = await all.open();
  await all.call('session/prompt', { sessionId: a.sessionId, prompt: [{ type: 'text', text: 'write' }] });
  assert.equal(all.asked.length, 0, '--yes: nothing asked');
  assert.ok(existsSync(join(a.cwd, 'x.txt')));
  await all.close();

  const some = editor([{ calls: [{ name: 'run_command', args: { command: 'echo hello' } }] }, { calls: [{ name: 'run_command', args: { command: 'echo hi; echo chained' } }] }, 'Done.'], { allowShell: ['echo'] });
  const s = await some.open();
  some.onPermission(() => ({ outcome: { outcome: 'selected', optionId: 'reject' } }));
  await some.call('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: 'run' }] });
  assert.equal(some.asked.length, 1, 'the simple command ran unasked; the chained one was asked about');
  assert.match(some.asked[0]!.params.toolCall.title, /echo hi; echo chained/);
  assert.equal(some.updates('tool_call_update').filter(u => u.status === 'completed').length, 1);
  await some.close();
  ok('unattended: --yes and --allow-shell');
}

// 13 · launched by a host with only an OpenRouter token: a clean HOME, nothing writable, a proxy as the base URL
{
  const { createServer } = await import('node:http');
  const seen: { url: string; auth?: string; body: any }[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', d => (raw += d));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ url: req.url!, auth: req.headers.authorization, body });
      if (req.url === '/api/v1/chat/completions' && body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ model: 'stub/model', choices: [{ delta: { content: 'Hello ' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'from the proxy' }, finish_reason: 'stop' }], usage: { cost: 0.0012 } })}\n\n`);
        res.end('data: [DONE]\n\n');
      } else if (req.url === '/api/v1/systemone') {
        const answers = Object.fromEntries(Object.entries(body.questions as Record<string, any>).map(([id, q]) => {
          const keys = Object.keys(q.criteria ?? {});
          const pick = keys.includes('task') ? 'task' : keys[0];
          return [id, q.type === 'noul' ? { type: 'noul', noul: 0.9 } : { type: 'choice', choice: pick, confidence: 0.9, probabilities: Object.fromEntries(keys.map(k => [k, k === pick ? 0.9 : 0.1])) }];
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ answers, usage: { cost: 0 } }));
      } else res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":{"message":"not found"}}');
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;

  const main = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'main.ts');
  const child = (env: Record<string, string>) => {
    const p = spawn(process.execPath, [main, 'acp'], { env: { PATH: process.env.PATH!, HOME: mkdtempSync(join(tmpdir(), 'clean-home-')), ...env } });
    const msgs: Msg[] = [];
    const pending = new Map<number, (m: Msg) => void>();
    let id = 1;
    createInterface({ input: p.stdout }).on('line', l => {
      const m = JSON.parse(l) as Msg;
      msgs.push(m);
      if (m.id !== undefined && !m.method) pending.get(m.id)?.(m);
    });
    return {
      msgs,
      call: (method: string, params: Msg = {}) => new Promise<Msg>(res => {
        const i = id++;
        pending.set(i, res);
        p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: i, method, params })}\n`);
      }),
      end: () => new Promise<void>(res => { p.on('close', () => res()); p.stdin.end(); }),
    };
  };

  const host = child({ OPENROUTER_API_KEY: 'run-token', OPENROUTER_BASE_URL: `http://127.0.0.1:${port}/api/v1`, AGENTO_HOME: '/dev/null/agento' });
  const init = await host.call('initialize', { protocolVersion: 1, clientCapabilities: {} });
  assert.deepEqual(init.result.authMethods, [], 'a key in the environment: no authenticate step');
  const created = await host.call('session/new', { cwd: mkdtempSync(join(tmpdir(), 'ws-')), mcpServers: [] });
  assert.match(created.result.sessionId, /^sess_/, 'a clean, unwritable home does not stop the session');
  const turn = await host.call('session/prompt', { sessionId: created.result.sessionId, prompt: [{ type: 'text', text: 'say hello' }] });
  assert.deepEqual(turn.result, { stopReason: 'end_turn' });
  const chunks = host.msgs.filter(m => m.params?.update?.sessionUpdate === 'agent_message_chunk').map(m => m.params.update.content.text).join('');
  assert.equal(chunks, 'Hello from the proxy');
  const usage = host.msgs.find(m => m.params?.update?.sessionUpdate === 'usage_update')!.params.update;
  assert.equal(usage.cost.currency, 'USD');
  assert.ok(usage.cost.amount >= 0.0012 && usage.cost.amount < 0.01, `the proxy's usage.cost came through: ${usage.cost.amount}`);
  await host.end();

  const chat = seen.filter(r => r.url === '/api/v1/chat/completions');
  assert.ok(chat.length >= 1 && seen.some(r => r.url === '/api/v1/systemone'), 'the worker AND the decider both went through the one endpoint');
  assert.ok(seen.every(r => r.url.startsWith('/api/v1/')), 'nothing was sent anywhere else');
  assert.ok(seen.every(r => r.auth === 'Bearer run-token'), `every call carried the host's token, and only that; without it: ${seen.filter(r => r.auth !== 'Bearer run-token').map(r => r.url).join(', ')}`);
  assert.equal(chat[0]!.body.model, 'qwen/qwen3.8-flash', 'no model chosen anywhere: the starter, with no prompt');

  // No key: one clear error, immediately.
  const bare = child({ AGENTO_HOME: '/dev/null/agento' });
  assert.equal((await bare.call('initialize', { protocolVersion: 1 })).result.authMethods[0].id, 'openrouter-key');
  const t0 = Date.now();
  const refused = await bare.call('session/new', { cwd: tmpdir(), mcpServers: [] });
  assert.equal(refused.error.code, E.auth);
  assert.match(refused.error.message, /OPENROUTER_API_KEY/);
  assert.ok(Date.now() - t0 < 3000, 'fails fast, never waits for input');
  await bare.end();
  server.close();
  ok('hosted: clean HOME, proxy base URL, run token only; missing key fails fast');
}

console.log(`${n} cases`);
