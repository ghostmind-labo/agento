// agento as an A2A server (Agent2Agent 1.0): the card, both bindings, the task life cycle. Offline, $0.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A clean home: the skills loader reads ~/.claude/skills, and a test must not depend on the machine it runs on.
process.env.HOME = mkdtempSync(join(tmpdir(), 'agento-a2a-userhome-'));
process.env.AGENTO_HOME = mkdtempSync(join(tmpdir(), 'agento-a2a-home-'));
const { scriptedModel } = await import('../src/index.ts');
const { a2aHandler, agentoExecutor, fileHistory, fileStore, serveA2a, CARD_PATH } = await import('../src/cli/a2a.ts');
type Executor = Parameters<typeof serveA2a>[0]['executor'];

let n = 0;
const ok = (what: string) => console.log(`ok · ${++n} ${what}`);
type Msg = Record<string, any>;
const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
const folder = () => mkdtempSync(join(tmpdir(), 'agento-a2a-ws-'));
const V = { 'A2A-Version': '1.0', 'Content-Type': 'application/json' };
let ids = 0;
const user = (text: string, extra: Msg = {}) => ({ role: 'ROLE_USER', messageId: `m-${++ids}`, parts: [{ text }], ...extra });

/** A caller over real HTTP on a free port. */
async function caller(executor: Executor, options: Msg = {}) {
  const server = await serveA2a({ executor, ...options });
  const rpc = async (method: string, params: Msg = {}, headers: Msg = V) => (await (await fetch(`${server.url}/`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()) as Msg;
  /** A streaming call, read to the end: the events in order. */
  const events = async (method: string, params: Msg, path = '/', wrap = true) => {
    const res = await fetch(`${server.url}${path}`, { method: 'POST', headers: V, body: JSON.stringify(wrap ? { jsonrpc: '2.0', id: 7, method, params } : params) });
    assert.match(res.headers.get('content-type') ?? '', /^text\/event-stream/);
    return (await res.text()).split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)) as Msg).map(e => (wrap ? e.result : e));
  };
  return { server, rpc, events, send: (text: string, extra: Msg = {}, config?: Msg) => rpc('SendMessage', { message: user(text, extra), ...(config ? { configuration: config } : {}) }) };
}
const agento = (script: Parameters<typeof scriptedModel>[0], options: Msg = {}) => {
  const provider = scriptedModel(script, { decide: false });
  return { provider, executor: agentoExecutor({ providerFor: () => provider, defaultModel: 'stub/worker', hasKey: () => true, cwd: folder(), ...options }) };
};
const reason = (r: Msg) => r.error.data.find((d: Msg) => d['@type'].endsWith('ErrorInfo'))?.reason;

// 1 · the Agent Card: where callers look, what it must say, and that it can be cached
{
  const c = await caller(async () => {});
  const res = await fetch(`${c.server.url}${CARD_PATH}`);
  const card = (await res.json()) as Msg;
  assert.equal(CARD_PATH, '/.well-known/agent-card.json');
  for (const field of ['name', 'description', 'version', 'supportedInterfaces', 'capabilities', 'defaultInputModes', 'defaultOutputModes', 'skills']) assert.ok(field in card, `the card has ${field}`);
  assert.equal(card.version, pkg.version);
  assert.deepEqual(card.supportedInterfaces.map((i: Msg) => [i.protocolBinding, i.protocolVersion, i.url]), [['JSONRPC', '1.0', `${c.server.url}/`], ['HTTP+JSON', '1.0', c.server.url]]);
  assert.deepEqual(card.capabilities, { streaming: true, pushNotifications: false, extendedAgentCard: false }, 'the card promises only what is built');
  assert.ok(!('securitySchemes' in card), 'no token, no scheme');
  for (const s of card.skills) for (const field of ['id', 'name', 'description', 'tags']) assert.ok(field in s);
  assert.equal((await fetch(`${c.server.url}${CARD_PATH}`, { headers: { 'If-None-Match': res.headers.get('etag')! } })).status, 304);
  assert.match(res.headers.get('cache-control') ?? '', /max-age/);
  await c.server.close();
  ok('agent card');
}

// 2 · a task, run by agento: the answer is an artifact, the cost is in the metadata, nothing changes files
{
  const a = agento([{ calls: [{ name: 'list_dir', args: {} }], cost: 0.002 }, { text: 'Found it.', cost: 0.002 }]);
  const c = await caller(a.executor);
  const r = await c.send('look around');
  const task = r.result.task;
  assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
  assert.match(task.status.timestamp, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
  assert.deepEqual(task.artifacts.map((x: Msg) => [x.name, x.parts]), [['answer', [{ text: 'Found it.' }]]]);
  assert.deepEqual({ ...task.metadata.agento, cost: Number(task.metadata.agento.cost.toFixed(6)) }, { status: 'done', reason: null, steps: 2, toolCalls: 1, cost: 0.004, model: 'stub/worker' });
  assert.equal(task.history[0].role, 'ROLE_USER');
  assert.ok(task.history.some((m: Msg) => m.role === 'ROLE_AGENT' && m.parts[0].text === 'Using list_dir'), 'what it did is said along the way');
  const offered = (a.provider.requests[0]?.tools ?? []).map(t => t.name);
  assert.ok(offered.includes('read_file') && !offered.includes('write_file') && !offered.includes('run_command'), 'nobody to approve: changes are not offered');
  await c.server.close();

  const yes = agento(['ok'], { autoApprove: true });
  const c2 = await caller(yes.executor);
  await c2.send('x');
  assert.ok((yes.provider.requests[0]?.tools ?? []).some(t => t.name === 'write_file'), '--yes offers changes');
  await c2.server.close();
  ok('SendMessage runs agento: artifact, cost, read-only by default');
}

// 3 · one contextId is one conversation; a task that ended takes no more messages
{
  const a = agento(['First answer.', 'Second answer.']);
  const c = await caller(a.executor);
  const first = (await c.send('remember 42')).result.task;
  const second = (await c.send('what number?', { contextId: first.contextId })).result.task;
  assert.equal(second.contextId, first.contextId);
  assert.notEqual(second.id, first.id);
  assert.ok(a.provider.requests[1]!.messages.some(m => m.content === 'First answer.'), 'the second task saw the first turn');
  const again = await c.send('more', { taskId: first.id });
  assert.deepEqual([again.error.code, reason(again)], [-32004, 'UNSUPPORTED_OPERATION']);
  await c.server.close();
  ok('context carries the conversation; a finished task is closed');
}

// 4 · what goes wrong, in the protocol's own words
{
  const a = agento([{ calls: [{ name: 'list_dir' }], cost: 0.3 }, { calls: [{ name: 'list_dir', args: { depth: 1 } }], cost: 0.3 }, 'never']);
  const c = await caller(a.executor);
  const cut = (await c.send('x')).result.task;
  assert.equal(cut.status.state, 'TASK_STATE_FAILED', 'a run that hit its cap did not complete');
  assert.match(cut.status.message.parts[0].text, /^Budget reached/);
  assert.equal(cut.metadata.agento.status, 'limit');

  const none = await c.rpc('SendMessage', { message: user('x') }, { 'Content-Type': 'application/json' });
  assert.deepEqual([none.error.code, reason(none)], [-32009, 'VERSION_NOT_SUPPORTED'], 'no header means 0.3, which is not spoken here');
  assert.match(none.error.message, /A2A-Version: 1\.0/, 'and the error says what to send');
  const patch = await c.rpc('GetTask', { id: cut.id }, { ...V, 'A2A-Version': '1.0.3' });
  assert.equal(patch.result.id, cut.id, 'a patch number does not matter');

  const missing = await c.rpc('GetTask', { id: 'nope' });
  assert.deepEqual([missing.error.code, reason(missing), missing.error.data[0].domain], [-32001, 'TASK_NOT_FOUND', 'a2a-protocol.org']);
  assert.equal((await c.rpc('SendMessage', { message: user('x', { taskId: 'nope' }) })).error.code, -32001);
  assert.equal((await c.rpc('CancelTask', { id: 'nope' })).error.code, -32001);
  assert.deepEqual([(await c.rpc('CancelTask', { id: cut.id })).error.code], [-32002], 'a task that ended cannot be cancelled');
  assert.equal((await c.rpc('SubscribeToTask', { id: cut.id })).error.code, -32004);
  for (const bad of [{}, { message: { role: 'ROLE_USER', parts: [{ text: 'x' }] } }, { message: { ...user('x'), parts: [] } }, { message: { ...user('x'), role: 'ROLE_AGENT' } }, { message: { ...user('x'), parts: [{ text: 'a', url: 'b' }] } }]) {
    assert.equal((await c.rpc('SendMessage', bad)).error.code, -32602);
  }
  assert.equal((await c.rpc('SendMessage', { message: user('x', { taskId: cut.id, contextId: 'another' }) })).error.code, -32602, 'a contextId that is not the task\'s');
  const media = await c.rpc('SendMessage', { message: { ...user('x'), parts: [{ raw: 'dGNr', mediaType: 'image/png' }] } });
  assert.deepEqual([media.error.code, reason(media)], [-32005, 'CONTENT_TYPE_NOT_SUPPORTED']);
  assert.equal((await c.rpc('Nope')).error.code, -32601);
  assert.equal((await c.rpc('CreateTaskPushNotificationConfig', { taskId: cut.id })).error.code, -32003);
  assert.equal((await c.rpc('GetExtendedAgentCard')).error.code, -32004);
  const parse = (await (await fetch(`${c.server.url}/`, { method: 'POST', headers: V, body: '{' })).json()) as Msg;
  assert.deepEqual([parse.error.code, parse.id], [-32700, null]);
  assert.equal(((await (await fetch(`${c.server.url}/`, { method: 'POST', headers: V, body: '[]' })).json()) as Msg).error.code, -32600);
  await c.server.close();

  const keyless = await caller(agentoExecutor({ providerFor: () => scriptedModel([]), hasKey: () => false, cwd: folder() }));
  const noKey = (await keyless.send('x')).result.task;
  assert.equal(noKey.status.state, 'TASK_STATE_FAILED');
  assert.match(noKey.status.message.parts[0].text, /OPENROUTER_API_KEY/);
  await keyless.server.close();
  ok('errors: version, not found, bad params, media, unsupported, limits, missing key');
}

// 5 · a task that asks back, and the answer that carries it on; a reply with no task at all
{
  const c = await caller(async t => {
    if (t.text === 'hello') return t.reply('Hi.');
    if (t.first) return t.status('TASK_STATE_INPUT_REQUIRED', 'Which folder?');
    t.artifact(`Used ${t.text}`);
    t.status('TASK_STATE_COMPLETED');
  });
  const direct = await c.send('hello');
  assert.deepEqual([direct.result.message.role, direct.result.message.parts, 'task' in direct.result], ['ROLE_AGENT', [{ text: 'Hi.' }], false]);
  assert.equal((await c.rpc('ListTasks')).result.totalSize, 0, 'a plain reply leaves no task behind');
  const asked = (await c.send('clean up')).result.task;
  assert.deepEqual([asked.status.state, asked.status.message.parts[0].text], ['TASK_STATE_INPUT_REQUIRED', 'Which folder?'], 'a blocking send returns when the task waits on the caller');
  const done = (await c.send('src', { taskId: asked.id })).result.task;
  assert.deepEqual([done.id, done.contextId, done.status.state, done.artifacts[0].parts[0].text], [asked.id, asked.contextId, 'TASK_STATE_COMPLETED', 'Used src']);
  assert.deepEqual(done.history.map((m: Msg) => m.role), ['ROLE_USER', 'ROLE_AGENT', 'ROLE_USER']);
  await c.server.close();
  ok('input required → the next message continues the same task; a direct Message');
}

// 6 · streaming: the Task first, then every update in order, closed when the task rests
{
  let release!: () => void;
  const c = await caller(async t => {
    t.status('TASK_STATE_WORKING');
    t.artifact('chunk-1 ', { artifactId: 'a', lastChunk: false });
    t.artifact('chunk-2', { artifactId: 'a', append: true, lastChunk: true });
    if (t.text === 'slow') await new Promise<void>(r => (release = r));
    t.status('TASK_STATE_COMPLETED');
  });
  const ev = await c.events('SendStreamingMessage', { message: user('go') });
  assert.deepEqual(ev.map(e => Object.keys(e)[0]), ['task', 'statusUpdate', 'artifactUpdate', 'artifactUpdate', 'statusUpdate']);
  assert.deepEqual([ev[0]!.task.status.state, ev[1]!.statusUpdate.status.state, ev[4]!.statusUpdate.status.state], ['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING', 'TASK_STATE_COMPLETED']);
  assert.deepEqual(ev.slice(2, 4).map(e => [e.artifactUpdate.append, e.artifactUpdate.lastChunk]), [[false, false], [true, true]]);
  const got = (await c.rpc('GetTask', { id: ev[0]!.task.id })).result;
  assert.deepEqual(got.artifacts[0].parts, [{ text: 'chunk-1 ' }, { text: 'chunk-2' }], 'appended chunks are one artifact');

  // returnImmediately, then a second watcher on the task while it works
  const started = (await c.rpc('SendMessage', { message: user('slow'), configuration: { returnImmediately: true } })).result.task;
  assert.equal(started.status.state, 'TASK_STATE_WORKING', 'a non-blocking send does not wait');
  const watching = c.events('SubscribeToTask', { id: started.id });
  await new Promise(r => setTimeout(r, 60));
  release();
  const seen = await watching;
  assert.deepEqual([Object.keys(seen[0]!)[0], seen.at(-1)!.statusUpdate.status.state], ['task', 'TASK_STATE_COMPLETED']);
  const rest = await c.events('', { message: user('go') }, '/message:stream', false);
  assert.deepEqual(rest.map(e => Object.keys(e)[0]), ['task', 'statusUpdate', 'artifactUpdate', 'artifactUpdate', 'statusUpdate'], 'the REST stream carries the same events, bare');
  await c.server.close();
  ok('SendStreamingMessage, SubscribeToTask, returnImmediately');
}

// 7 · cancel a task in flight: the executor is told, and nothing it says afterwards counts
{
  let late!: () => void;
  let aborted = false;
  const c = await caller(async t => {
    t.status('TASK_STATE_WORKING');
    await new Promise<void>(r => { late = r; t.signal.addEventListener('abort', () => { aborted = true; }); });
    t.artifact('too late');
    t.status('TASK_STATE_COMPLETED');
  });
  const started = (await c.rpc('SendMessage', { message: user('long'), configuration: { returnImmediately: true } })).result.task;
  const cancelled = (await c.rpc('CancelTask', { id: started.id })).result;
  assert.equal(cancelled.status.state, 'TASK_STATE_CANCELED');
  assert.equal(aborted, true);
  late();
  await new Promise(r => setTimeout(r, 20));
  const after = (await c.rpc('GetTask', { id: started.id })).result;
  assert.deepEqual([after.status.state, after.artifacts], ['TASK_STATE_CANCELED', undefined]);
  assert.equal((await c.rpc('CancelTask', { id: started.id })).error.code, -32002);
  await c.server.close();
  ok('CancelTask');
}

// 8 · ListTasks: newest first, pages by cursor, filters; history on request
{
  const c = await caller(async t => t.status(t.text === 'ask' ? 'TASK_STATE_INPUT_REQUIRED' : 'TASK_STATE_COMPLETED', 'said'));
  const made: Msg[] = [];
  for (const text of ['a', 'b', 'ask', 'd', 'e']) made.push((await c.send(text, text === 'd' ? { contextId: 'ctx-d' } : {})).result.task);
  const page1 = (await c.rpc('ListTasks', { pageSize: 2 })).result;
  assert.deepEqual([page1.tasks.map((t: Msg) => t.id), page1.pageSize, page1.totalSize], [[made[4]!.id, made[3]!.id], 2, 5]);
  assert.ok(!('history' in page1.tasks[0]) && !('artifacts' in page1.tasks[0]), 'a listing is light unless asked');
  const page2 = (await c.rpc('ListTasks', { pageSize: 2, pageToken: page1.nextPageToken })).result;
  const page3 = (await c.rpc('ListTasks', { page_size: 2, page_token: page2.nextPageToken })).result;
  assert.deepEqual([...page2.tasks, ...page3.tasks].map((t: Msg) => t.id), [made[2]!.id, made[1]!.id, made[0]!.id]);
  assert.equal(page3.nextPageToken, '', 'the last page says so with an empty token');
  assert.deepEqual((await c.rpc('ListTasks', { contextId: 'ctx-d' })).result.tasks.map((t: Msg) => t.id), [made[3]!.id]);
  assert.deepEqual((await c.rpc('ListTasks', { status: 'TASK_STATE_INPUT_REQUIRED' })).result.tasks.map((t: Msg) => t.id), [made[2]!.id]);
  for (const bad of [{ pageSize: 0 }, { pageSize: 101 }, { pageToken: 'junk' }, { status: 'done' }]) assert.equal((await c.rpc('ListTasks', bad)).error.code, -32602);
  assert.equal((await c.rpc('GetTask', { id: made[0]!.id })).result.history.length, 2);
  assert.equal((await c.rpc('GetTask', { id: made[0]!.id, historyLength: 1 })).result.history.length, 1);
  assert.ok(!('history' in (await c.rpc('GetTask', { id: made[0]!.id, history_length: 0 })).result), 'the proto spelling of a field is read too');
  assert.ok(!('history' in (await c.send('x', {}, { historyLength: 0 })).result.task));
  await c.server.close();
  ok('ListTasks pagination and filters; historyLength');
}

// 9 · the REST binding, and a token
{
  const c = await caller(async t => t.status('TASK_STATE_COMPLETED', 'ok'), { token: 's3cret' });
  const auth = { ...V, Authorization: 'Bearer s3cret' };
  const card = (await (await fetch(`${c.server.url}${CARD_PATH}`)).json()) as Msg;
  assert.deepEqual(Object.keys(card.securitySchemes), ['bearer'], 'the card is public and says a token is needed');
  const refused = await fetch(`${c.server.url}/message:send`, { method: 'POST', headers: V, body: JSON.stringify({ message: user('x') }) });
  assert.deepEqual([refused.status, refused.headers.get('www-authenticate')], [401, 'Bearer']);
  assert.equal((await fetch(`${c.server.url}/`, { method: 'POST', headers: V, body: '{}' })).status, 401);
  const sent = await fetch(`${c.server.url}/message:send`, { method: 'POST', headers: auth, body: JSON.stringify({ message: user('x') }) });
  const task = ((await sent.json()) as Msg).task;
  assert.deepEqual([sent.status, task.status.state], [200, 'TASK_STATE_COMPLETED']);
  assert.equal(((await (await fetch(`${c.server.url}/tasks/${task.id}?historyLength=0`, { headers: auth })).json()) as Msg).id, task.id);
  assert.equal(((await (await fetch(`${c.server.url}/tasks?pageSize=1`, { headers: auth })).json()) as Msg).totalSize, 1);
  const gone = await fetch(`${c.server.url}/tasks/nope`, { headers: auth });
  const body = (await gone.json()) as Msg;
  assert.deepEqual([gone.status, body.error.code, body.error.status, body.error.details[0].reason], [404, 404, 'NOT_FOUND', 'TASK_NOT_FOUND']);
  assert.equal((await fetch(`${c.server.url}/tasks/${task.id}:cancel`, { method: 'POST', headers: auth })).status, 409);
  assert.equal((await fetch(`${c.server.url}/tasks?pageSize=zero`, { headers: auth })).status, 400);
  assert.equal((await fetch(`${c.server.url}/message:send`, { method: 'POST', headers: { ...auth, 'Content-Type': 'text/plain' }, body: 'hi' })).status, 415);
  assert.equal((await fetch(`${c.server.url}/tasks/${task.id}/pushNotificationConfigs`, { headers: auth })).status, 400);
  assert.equal((await fetch(`${c.server.url}/elsewhere`, { headers: auth })).status, 404);
  await c.server.close();
  ok('HTTP+JSON binding; bearer token');
}

// 10 · the real process, as a host would run it: only a key and a clean home; and it will not open up unguarded
{
  const main = join(here, '..', 'src', 'cli', 'main.ts');
  const env = { PATH: process.env.PATH!, HOME: mkdtempSync(join(tmpdir(), 'clean-home-')), AGENTO_HOME: '/dev/null/agento', OPENROUTER_API_KEY: '' };
  const p = spawn(process.execPath, [main, 'a2a', '--port', '0'], { env });
  let stdout = '';
  p.stdout.on('data', d => (stdout += d));
  const url = await new Promise<string>((found, fail) => {
    let err = '';
    p.stderr.on('data', d => { err += d; const m = /agento a2a on (http:\/\/\S+)/.exec(err); if (m) found(m[1]!); });
    p.on('close', () => fail(new Error(`agento a2a exited early: ${err}`)));
  });
  const card = (await (await fetch(`${url}${CARD_PATH}`)).json()) as Msg;
  assert.equal(card.name, 'agento');
  const r = (await (await fetch(card.supportedInterfaces[0].url, { method: 'POST', headers: V, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: user('x') } }) })).json()) as Msg;
  assert.equal(r.result.task.status.state, 'TASK_STATE_FAILED');
  assert.match(r.result.task.status.message.parts[0].text, /OPENROUTER_API_KEY/);
  const closed = new Promise<number | null>(done => p.on('close', done));
  p.kill('SIGTERM');
  assert.equal(await closed, 0);
  assert.equal(stdout, '', 'nothing on stdout');

  const open = await new Promise<{ code: number | null; out: string }>(done => {
    const q = spawn(process.execPath, [main, 'a2a', '--port', '0', '--host', '0.0.0.0', '--yes'], { env });
    let out = '';
    q.stdout.on('data', d => (out += d));
    q.on('close', code => done({ code, out }));
  });
  assert.equal(open.code, 1);
  assert.match(open.out, /A2A_TOKEN/);
  ok('agento a2a as a process: keyless failure is said in the task; no open port with --yes and no token');
}

// ---------- serverless: no port, no instance that lasts ----------
type Handler = ReturnType<typeof a2aHandler>;
const ask = async (h: Handler, method: string, params: Msg = {}) => (await (await h.fetch(new Request('http://instance/', { method: 'POST', headers: V, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }))).json()) as Msg;
const watch = async (h: Handler, method: string, params: Msg) => (await (await h.fetch(new Request('http://instance/', { method: 'POST', headers: V, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }))).text()).split('\n').filter(l => l.startsWith('data: ')).map(l => (JSON.parse(l.slice(6)) as Msg).result as Msg);

// 11 · the handler alone: a Request in, a Response out, nothing from Node
{
  assert.ok(!/^import /m.test(readFileSync(join(here, '..', 'src', 'cli', 'a2a-handler.ts'), 'utf8')), 'the protocol imports nothing, so it runs where Node is not');
  const h = a2aHandler({ executor: async t => t.status('TASK_STATE_COMPLETED', 'ok'), streaming: false });
  const card = (await (await h.fetch(new Request(`http://10.0.0.7:8080${CARD_PATH}`, { headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'agent.example.com' } }))).json()) as Msg;
  assert.deepEqual(card.supportedInterfaces.map((i: Msg) => i.url), ['https://agent.example.com/', 'https://agent.example.com'], 'behind a proxy that ends TLS, the card gives the public address');
  assert.equal(card.capabilities.streaming, false);
  const kept: Promise<unknown>[] = [];
  const sent = await h.fetch(new Request('http://instance/message:send', { method: 'POST', headers: V, body: JSON.stringify({ message: user('x') }) }), { waitUntil: p => void kept.push(p) });
  assert.deepEqual([sent.status, ((await sent.json()) as Msg).task.status.state, kept.length], [200, 'TASK_STATE_COMPLETED', 1], 'the turn is handed to waitUntil, for a host that freezes after the response');
  await kept[0];
  const noStream = await h.fetch(new Request('http://instance/message:stream', { method: 'POST', headers: V, body: JSON.stringify({ message: user('x') }) }));
  assert.deepEqual([noStream.status, ((await noStream.json()) as Msg).error.details[0].reason], [400, 'UNSUPPORTED_OPERATION'], 'streaming off: the card says so, and the calls are refused');
  assert.equal((await ask(h, 'SubscribeToTask', { id: 'x' })).error.code, -32004);
  h.close();
  ok('a2aHandler: fetch only, forwarded address, waitUntil, streaming off');
}

// 12 · two instances, one store: a task sent to one is read, continued, watched and cancelled on the other
{
  const dir = folder();
  let release!: () => void;
  let aborted = false;
  const executor: Executor = async t => {
    if (t.text === 'ask' && t.first) return t.status('TASK_STATE_INPUT_REQUIRED', 'Which folder?');
    if (t.text === 'slow') {
      t.status('TASK_STATE_WORKING');
      await new Promise<void>(r => { release = r; t.signal.addEventListener('abort', () => { aborted = true; r(); }); });
      t.artifact('late answer');
      return t.status('TASK_STATE_COMPLETED');
    }
    t.artifact(`did ${t.text}`);
    t.status('TASK_STATE_COMPLETED');
  };
  const A = a2aHandler({ executor, store: fileStore(dir), pollMs: 15 });
  const B = a2aHandler({ executor, store: fileStore(dir), pollMs: 15 });

  const asked = (await ask(A, 'SendMessage', { message: user('ask') })).result.task;
  assert.equal((await ask(B, 'GetTask', { id: asked.id })).result.status.state, 'TASK_STATE_INPUT_REQUIRED', 'the other instance knows the task');
  const done = (await ask(B, 'SendMessage', { message: user('src', { taskId: asked.id }) })).result.task;
  assert.deepEqual([done.id, done.status.state, done.artifacts[0].parts[0].text, done.history.length], [asked.id, 'TASK_STATE_COMPLETED', 'did src', 3], 'and can carry it on, history included');
  assert.equal((await ask(A, 'GetTask', { id: asked.id })).result.status.state, 'TASK_STATE_COMPLETED', 'the first instance reads what the second did');
  assert.equal((await ask(B, 'ListTasks')).result.totalSize, 1);

  const slow = (await ask(A, 'SendMessage', { message: user('slow'), configuration: { returnImmediately: true } })).result.task;
  assert.equal((await ask(B, 'SendMessage', { message: user('x', { taskId: slow.id }) })).error.code, -32004, 'a task another instance is working on takes no second turn');
  const watching = watch(B, 'SubscribeToTask', { id: slow.id });
  await new Promise(r => setTimeout(r, 60));
  release();
  const seen = await watching;
  assert.deepEqual([Object.keys(seen[0]!)[0], seen.some(e => e.artifactUpdate?.artifact.parts[0].text === 'late answer'), seen.at(-1)!.statusUpdate.status.state], ['task', true, 'TASK_STATE_COMPLETED'], 'a watcher on another instance sees the task finish');

  const doomed = (await ask(A, 'SendMessage', { message: user('slow'), configuration: { returnImmediately: true } })).result.task;
  assert.equal((await ask(B, 'CancelTask', { id: doomed.id })).result.status.state, 'TASK_STATE_CANCELED');
  release(); // the instance running it goes on, until its next write finds the cancellation
  await new Promise(r => setTimeout(r, 80));
  const after = (await ask(A, 'GetTask', { id: doomed.id })).result;
  assert.deepEqual([aborted, after.status.state, after.artifacts], [true, 'TASK_STATE_CANCELED', undefined], 'a cancellation from elsewhere stands, and stops the turn');
  A.close();
  B.close();
  ok('two instances on one store: read, continue, watch, cancel');
}

// 13 · the conversation outlives the instance too; and an agent with the web only
{
  const dir = folder();
  const one = scriptedModel(['First answer.'], { decide: false });
  const two = scriptedModel(['Second answer.'], { decide: false });
  const instance = (provider: typeof one) => a2aHandler({ store: fileStore(dir), executor: agentoExecutor({ providerFor: () => provider, defaultModel: 'stub/worker', hasKey: () => true, files: false, history: fileHistory(dir) }) });
  const first = (await ask(instance(one), 'SendMessage', { message: user('remember 42') })).result.task;
  const second = (await ask(instance(two), 'SendMessage', { message: user('what number?', { contextId: first.contextId }) })).result.task;
  assert.equal(second.artifacts[0].parts[0].text, 'Second answer.');
  assert.ok(two.requests[0]!.messages.some(m => m.content === 'First answer.'), 'a fresh instance picks the conversation up where it was kept');
  const offered = (two.requests[0]?.tools ?? []).map(t => t.name);
  assert.ok(offered.includes('web_fetch') && !offered.includes('read_file') && !offered.includes('list_dir'), 'files: false leaves the web tools only');
  ok('fileHistory across instances; files: false');
}

console.log(`${n} cases`);
