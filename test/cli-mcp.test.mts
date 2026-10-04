// agento as an MCP server: one tool, run_task. Offline, $0 — including a call from ensemble's own MCP client.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

// A clean home: the skills loader reads ~/.claude/skills, and a test must not depend on the machine it runs on.
process.env.HOME = mkdtempSync(join(tmpdir(), 'agento-mcp-userhome-'));
process.env.AGENTO_HOME = mkdtempSync(join(tmpdir(), 'agento-mcp-home-'));
const { scriptedModel, standardToolsets } = await import('../src/index.ts');
const { E } = await import('../src/cli/acp.ts');
const { RUN_TASK, serveMcp } = await import('../src/cli/mcp-server.ts');
const { unattended } = await import('../src/cli/unattended.ts');

let n = 0;
const ok = (what: string) => console.log(`ok · ${++n} ${what}`);
type Msg = Record<string, any>;
const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
const folder = () => mkdtempSync(join(tmpdir(), 'agento-mcp-ws-'));

/** A fake MCP client over in-memory streams. */
function client(script: Parameters<typeof scriptedModel>[0] = [], options: Record<string, unknown> = {}) {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  const provider = scriptedModel(script, { decide: false });
  const done = serveMcp({ input: toServer, output: fromServer, providerFor: () => provider, defaultModel: 'stub/worker', hasKey: () => true, cwd: folder(), ...options } as never);
  const raw: Msg[] = [];
  const pending = new Map<number, (m: Msg) => void>();
  let nextId = 1;
  createInterface({ input: fromServer }).on('line', line => {
    const m = JSON.parse(line) as Msg;
    raw.push(m);
    pending.get(m.id)?.(m);
  });
  const send = (m: Msg) => toServer.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  return {
    provider,
    raw,
    send,
    nextId: () => nextId,
    call: (method: string, params: Msg = {}) => new Promise<Msg>(res => {
      const id = nextId++;
      pending.set(id, res);
      send({ id, method, params });
    }),
    run: (args: Msg) => new Promise<Msg>(res => {
      const id = nextId++;
      pending.set(id, res);
      send({ id, method: 'tools/call', params: { name: 'run_task', arguments: args } });
    }),
    writeRaw: (t: string) => toServer.write(t),
    close: async () => {
      toServer.end();
      await done;
    },
  };
}
const toolNames = (c: ReturnType<typeof client>) => (c.provider.requests[0]?.tools ?? []).map(t => t.name);

// 1 · the handshake, the one tool, ping
{
  const c = client();
  const init = await c.call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-03-26', 'a version we speak is echoed');
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.deepEqual({ name: init.result.serverInfo.name, version: init.result.serverInfo.version }, { name: 'agento', version: pkg.version });
  assert.equal((await c.call('initialize', { protocolVersion: '2099-01-01' })).result.protocolVersion, '2025-06-18', 'an unknown one gets our latest');
  c.send({ method: 'notifications/initialized' });
  assert.deepEqual((await c.call('ping')).result, {});
  const list = (await c.call('tools/list')).result.tools;
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'run_task');
  assert.deepEqual(list[0].inputSchema.required, ['prompt'], 'the task goes in `prompt`, the default argument name');
  assert.ok(RUN_TASK.description.length > 50);
  await c.close();
  ok('initialize, ping, tools/list');
}

// 2 · a task: the answer is the text, the facts are structured
{
  const c = client([{ calls: [{ name: 'list_dir', args: {} }], cost: 0.002 }, { text: 'There are no files.', cost: 0.002 }]);
  const r = await c.run({ prompt: 'What is in this folder?' });
  assert.deepEqual(r.result.content, [{ type: 'text', text: 'There are no files.' }]);
  assert.equal(r.result.isError, undefined);
  assert.deepEqual({ ...r.result.structuredContent, cost: Number(r.result.structuredContent.cost.toFixed(6)) }, { status: 'done', reason: null, steps: 2, toolCalls: 1, cost: 0.004, model: 'stub/worker' });
  await c.close();
  ok('run_task: answer text, status/steps/cost structured');
}

// 3 · read-only by default; --yes and --allow-shell widen it, and nothing ever asks
{
  const names = (c: ReturnType<typeof client>) => toolNames(c).sort();
  const ro = client(['ok']);
  await ro.run({ prompt: 'hi' });
  assert.deepEqual(names(ro), ['glob', 'list_dir', 'read_file', 'search', 'web_fetch', 'web_search', 'ask_jev'].filter(x => x !== 'ask_jev').sort(), 'no write_file, edit_file or run_command');
  await ro.close();

  const dir = folder();
  const yes = client([{ calls: [{ name: 'write_file', args: { path: 'made.txt', content: 'x' } }] }, 'Wrote it.'], { autoApprove: true });
  const done = await yes.run({ prompt: 'write', cwd: dir });
  assert.equal(done.result.structuredContent.status, 'done');
  assert.ok(existsSync(join(dir, 'made.txt')), '--yes: written without asking');
  assert.ok(names(yes).includes('run_command') && names(yes).includes('write_file'));
  await yes.close();

  const sh = client([{ calls: [{ name: 'run_command', args: { command: 'echo allowed' } }] }, { calls: [{ name: 'run_command', args: { command: 'echo a; echo chained' } }] }, 'All done.'], { allowShell: ['echo'] });
  const ran = await sh.run({ prompt: 'run', cwd: dir });
  assert.equal(ran.result.structuredContent.status, 'done', 'a refused command is a tool error, not the end of the turn');
  assert.equal(ran.result.content[0].text, 'All done.');
  assert.ok(names(sh).includes('run_command') && !names(sh).includes('write_file'), 'only the shell was opened up');
  assert.match(sh.provider.requests[0]!.tools!.find(t => t.name === 'run_command')!.description, /only simple commands starting with "echo"/);
  const results = sh.provider.requests.at(-1)!.messages.filter(m => m.role === 'tool').map(m => m.content);
  assert.match(results[0]!, /allowed/);
  assert.match(results[1]!, /Error: That command is not allowed here/);
  await sh.close();

  // The policy itself, on the standard tools.
  const all = (p: Parameters<typeof unattended>[1]) => unattended(standardToolsets({ root: dir }), p).flatMap(s => s.tools.map(t => t.name));
  assert.ok(!all({}).includes('write_file') && all({ autoApprove: true }).includes('edit_file'));
  assert.ok(unattended(standardToolsets({ root: dir }), { autoApprove: true }).flatMap(s => s.tools).every(t => !t.write), 'auto-approved tools carry no approval step');
  ok('unattended policy: read-only, --yes, --allow-shell');
}

// 4 · errors are specific
{
  const c = client([() => { throw new Error('the provider is down'); }]);
  assert.equal((await c.call('tools/call', { name: 'nope', arguments: {} })).error.code, E.params);
  assert.equal((await c.run({})).error.code, E.params, 'no prompt');
  assert.equal((await c.run({ prompt: 'x', cwd: 'relative' })).error.code, E.params);
  assert.equal((await c.run({ prompt: 'x', max_usd: -1 })).error.code, E.params);
  assert.equal((await c.call('nope/nothing')).error.code, E.method);
  const down = await c.run({ prompt: 'x' });
  assert.equal(down.result.isError, true);
  assert.match(down.result.content[0].text, /the provider is down/);
  c.writeRaw('not json\n');
  for (let i = 0; i < 100 && !c.raw.some(m => m.error?.code === E.parse); i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(c.raw.find(m => m.error?.code === E.parse)!.id, null);
  await c.close();

  const nokey = client([], { hasKey: () => false });
  const refused = await nokey.run({ prompt: 'x' });
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0].text, /OPENROUTER_API_KEY is not set/);
  await nokey.close();

  const limited = client([{ calls: [{ name: 'list_dir' }], cost: 0.3 }, { calls: [{ name: 'list_dir', args: { depth: 1 } }], cost: 0.3 }, 'never']);
  const cut = await limited.run({ prompt: 'x' });
  assert.equal(cut.result.isError, true, 'an unfinished task is an error, so a graph step fails instead of passing half an answer');
  assert.equal(cut.result.structuredContent.status, 'limit');
  assert.match(cut.result.content[0].text, /^Budget reached: spent \$0\.600000 of the \$0\.500000 cap\./);
  await limited.close();
  ok('errors: protocol, tool, missing key, limits');
}

// 5 · a cancelled call is not answered, and the server carries on
{
  let started!: () => void;
  const reached = new Promise<void>(r => (started = r));
  const hang = (req: { signal?: AbortSignal }) => new Promise<never>((_, reject) => { started(); req.signal?.addEventListener('abort', () => reject(new Error('aborted'))); });
  const c = client([hang as never, 'Second call works.']);
  const id = c.nextId();
  const first = c.run({ prompt: 'think forever' });
  await reached;
  c.send({ method: 'notifications/cancelled', params: { requestId: id, reason: 'user' } });
  const outcome = await Promise.race([first.then(() => 'answered'), new Promise(r => setTimeout(() => r('silent'), 400))]);
  assert.equal(outcome, 'silent', 'no response for a cancelled request');
  assert.equal((await c.run({ prompt: 'again' })).result.content[0].text, 'Second call works.');
  await c.close();
  ok('notifications/cancelled');
}

// 6 · the real process: stdout is the protocol only, and a missing key is said at once
{
  const main = join(here, '..', 'src', 'cli', 'main.ts');
  const out = await new Promise<{ msgs: Msg[]; stdout: string; code: number | null }>(done => {
    const p = spawn(process.execPath, [main, 'mcp'], { env: { PATH: process.env.PATH!, HOME: mkdtempSync(join(tmpdir(), 'clean-home-')), AGENTO_HOME: '/dev/null/agento', OPENROUTER_API_KEY: '' } });
    let stdout = '';
    p.stdout.on('data', d => (stdout += d));
    p.on('close', code => done({ msgs: stdout.split('\n').filter(Boolean).map(l => JSON.parse(l) as Msg), stdout, code }));
    for (const m of [{ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, { id: 2, method: 'tools/list' }, { id: 3, method: 'tools/call', params: { name: 'run_task', arguments: { prompt: 'x' } } }]) p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
    p.stdin.end();
  });
  const by = (id: number) => out.msgs.find(m => m.id === id)!;
  assert.equal(out.code, 0);
  assert.equal(by(1).result.serverInfo.name, 'agento');
  assert.equal(by(2).result.tools[0].name, 'run_task');
  assert.match(by(3).result.content[0].text, /OPENROUTER_API_KEY/);
  assert.equal(out.msgs.length, 3, 'three replies and nothing else on stdout');
  ok('agento mcp over real stdio');
}

// 7 · ensemble's own MCP client calls it, as ensemble's docs describe
{
  let connect: ((name: string, spec: unknown, options?: unknown) => Promise<any>) | null = null;
  try {
    connect = ((await import('@ghostmind-dev/ensemble')) as { connect: typeof connect }).connect;
  } catch {
    console.log('  (ensemble is not installed here: skipping the client check)');
  }
  if (connect) {
    const session = await connect('agento', { command: process.execPath, args: [join(here, 'fixtures', 'mcp-stub-agent.mts')], timeoutMs: 20_000 });
    try {
      const tools = await session.listTools();
      assert.deepEqual(tools.map((t: Msg) => t.name), ['run_task']);
      const result = await session.call('run_task', { prompt: 'look around', cwd: folder() });
      assert.equal(result.isError, false);
      assert.equal(result.text, 'Found it.');
      assert.equal(result.data.status, 'done');
      assert.equal(Number(result.data.cost.toFixed(6)), 0.004, 'the cost ensemble cannot see over MCP is in the structured result');
      assert.equal(result.data.toolCalls, 1);
    } finally {
      session.close();
    }
    ok("ensemble's MCP client: list the tool, call it, read text and structured result");
  }
}

console.log(`${n} cases`);
