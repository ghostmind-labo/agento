// The saved default model and the picker's logic. Offline: the catalogue is a fixture.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelCard } from '../src/index.ts';

let n = 0;
const ok = (what: string) => console.log(`ok · ${++n} ${what}`);
process.env.AGENTO_HOME = mkdtempSync(join(tmpdir(), 'agento-home-'));
const { cliProvider, home, isShell, pickable, readConfig, resolveModel, resolveShell, writeConfig } = await import('../src/cli/config.ts');
const { CURATED, capable, labelOf, offered } = await import('../src/cli/models.ts');
const { filterItems, windowStart } = await import('../src/cli/picker.ts');

const card = (id: string, perM: number, tools = true): ModelCard => ({ id, name: id.split('/')[1]!.replace(/-/g, ' '), prompt: 0, completion: perM / 1e6, context: 128_000, tools, reasoning: tools, vision: false });
const CATALOG = [card('z-ai/glm-5.3', 4.4), card('z-ai/glm-5.3-flash', 0.5), card('anthropic/claude-sonnet-5', 15), card('x/no-tools', 0.1, false), card('deepseek/deepseek-v4', 1.1)];

// 1 · the config file: under AGENTO_HOME, merged, written atomically
{
  assert.equal(home(), process.env.AGENTO_HOME);
  assert.deepEqual(readConfig(), {});
  writeConfig({ model: 'z-ai/glm-5.3-flash' });
  assert.deepEqual(readConfig(), { model: 'z-ai/glm-5.3-flash' });
  assert.deepEqual(JSON.parse(readFileSync(join(home(), 'config.json'), 'utf8')), { model: 'z-ai/glm-5.3-flash' });
  ok('config read/write');
}

// 2 · precedence: --model, then AGENT_MODEL, then the saved default
{
  const cfg = { model: 'saved/m' };
  assert.deepEqual(resolveModel('flag/m', 'env/m', cfg), { model: 'flag/m', from: 'flag' });
  assert.deepEqual(resolveModel(undefined, 'env/m', cfg), { model: 'env/m', from: 'env' });
  assert.deepEqual(resolveModel(undefined, '', cfg), { model: 'saved/m', from: 'default' }, 'an empty AGENT_MODEL (varlock) does not hide the default');
  assert.deepEqual(resolveModel(undefined, undefined, {}), {});
  ok('model precedence');
}

// 3 · the list: tool-capable only, filtered by every word, cheapest first
{
  assert.deepEqual(pickable(CATALOG).map(m => m.id), ['z-ai/glm-5.3-flash', 'deepseek/deepseek-v4', 'z-ai/glm-5.3', 'anthropic/claude-sonnet-5']);
  assert.deepEqual(pickable(CATALOG, 'glm').map(m => m.id), ['z-ai/glm-5.3-flash', 'z-ai/glm-5.3']);
  assert.deepEqual(pickable(CATALOG, 'claude sonnet').map(m => m.id), ['anthropic/claude-sonnet-5']);
  assert.deepEqual(pickable(CATALOG, 'no-tools'), []);
  ok('pickable');
}

// 4 · the short list: in the live catalogue, capable (tools + reasoning), in the curated order
{
  const live = [card('anthropic/claude-sonnet-5', 10), card('z-ai/glm-5.3-flash', 0.5), { ...card('openai/gpt-6-luna', 0.5), reasoning: false }, card('x/not-curated', 0.1)];
  assert.deepEqual(offered(live).map(m => m.id), ['anthropic/claude-sonnet-5', 'z-ai/glm-5.3-flash'], 'missing, reasoning-less and uncurated models are not offered; order is the list\'s');
  assert.equal(offered([]).length, 0, 'no catalogue, nothing offered');
  assert.ok(CURATED.length >= 10 && CURATED.every(m => m.id.includes('/') && m.label && m.maker && m.note));
  assert.equal(new Set(CURATED.map(m => m.id)).size, CURATED.length, 'no duplicates');
  assert.equal(labelOf('z-ai/glm-5.3-flash'), 'GLM 5.3 Flash');
  assert.equal(labelOf('x/unknown'), 'x/unknown');
  assert.ok(!capable({ ...card('a/b', 1), reasoning: false }));
  ok('offered: curated, live, capable');
}

// 4b · the picker's logic: filter by every word; the window follows the cursor
{
  const items = [{ label: 'Claude Sonnet 5', detail: 'Anthropic · Balanced', value: 1 }, { label: 'GLM 5.3 Flash', detail: 'Zhipu · Open weights', value: 2 }, { label: 'Other model…', value: 3 }];
  assert.deepEqual(filterItems(items, 'open zhipu').map(i => i.value), [2]);
  assert.deepEqual(filterItems(items, 'ANTHROPIC').map(i => i.value), [1]);
  assert.deepEqual(filterItems(items, '').map(i => i.value), [1, 2, 3]);
  assert.equal(windowStart(0, 0, 5, 20), 0);
  assert.equal(windowStart(7, 0, 5, 20), 3, 'scrolls down to keep the cursor on the last row');
  assert.equal(windowStart(2, 3, 5, 20), 2, 'scrolls up to the cursor');
  assert.equal(windowStart(19, 15, 5, 20), 15);
  ok('filterItems + windowStart');
}

// 5 · the entry point uses the saved default: no flag, no env, no picker
{
  const main = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'main.ts');
  // A fake key and no network in this test: the run fails at the model call, but the banner/error
  // shows which model it resolved. -p keeps it non-interactive.
  const r = spawnSync(process.execPath, [main, '-p', 'hi', '--no-mcp', '--no-skills'], {
    encoding: 'utf8',
    input: '',
    env: { ...process.env, OPENROUTER_API_KEY: 'sk-test', AGENT_MODEL: '', OPENROUTER_BASE_URL: 'http://127.0.0.1:9/api/v1' },
  });
  assert.doesNotMatch(r.stderr, /No model/, 'the saved default was used');
  assert.equal(r.status, 1, 'it got as far as calling the (unreachable) model');
  ok('main runs on the saved default');
}

// 6 · `agento model <id>` saves the default without a picker; a stray command is refused
{
  const main = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'main.ts');
  const r = spawnSync(process.execPath, [main, 'model', 'deepseek/deepseek-v4'], { encoding: 'utf8', input: '', env: { ...process.env, OPENROUTER_API_KEY: '' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /default model: deepseek\/deepseek-v4/);
  assert.equal(readConfig().model, 'deepseek/deepseek-v4');
  const pick = spawnSync(process.execPath, [main, 'model'], { encoding: 'utf8', input: '', env: process.env });
  assert.equal(pick.status, 2, 'no terminal: no picker');
  assert.match(pick.stderr, /needs a terminal/);
  const stray = spawnSync(process.execPath, [main, 'modle'], { encoding: 'utf8', input: '', env: process.env });
  assert.equal(stray.status, 2);
  assert.match(stray.stderr, /unknown command "modle"/);
  ok('agento model <id>; no picker without a terminal; unknown commands refused');
}

// where commands run: this machine unless the person chose OpenRouter's hosted shell (a flag, or the saved setting)
{
  assert.equal(resolveShell(undefined, {}), 'local', 'a local agento has a shell already: the hosted one is never on by itself');
  assert.equal(resolveShell(undefined, { shell: 'openrouter' }), 'openrouter');
  assert.equal(resolveShell('local', { shell: 'openrouter' }), 'local', 'the flag wins');
  assert.equal(resolveShell('nonsense', { shell: 'nonsense' }), 'local');
  assert.ok(isShell('openrouter') && !isShell('remote'));
  const before = readConfig().model;
  writeConfig({ shell: 'openrouter' });
  assert.equal(readConfig().shell, 'openrouter');
  assert.equal(readConfig().model, before, 'the other settings are kept');

  // what each choice sends: chat completions and nothing else, or the Responses API with the hosted shell
  const sent: { url: string; body: any }[] = [];
  const realFetch = globalThis.fetch;
  process.env.OPENROUTER_API_KEY = 'k';
  globalThis.fetch = (async (url: string, init: any) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify(String(url).endsWith('/responses') ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }] } : { choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] }), { headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
  try {
    await cliProvider('vendor/m').chat({ messages: [{ role: 'user', content: 'hi' }] });
    await cliProvider('vendor/m', 'openrouter').chat({ messages: [{ role: 'user', content: 'hi' }] });
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.OPENROUTER_API_KEY;
  }
  assert.ok(sent[0]!.url.endsWith('/chat/completions') && !sent[0]!.body.tools);
  assert.ok(sent[1]!.url.endsWith('/responses'));
  assert.deepEqual(sent[1]!.body.tools, [{ type: 'openrouter:shell', parameters: { engine: 'openrouter' } }]);
  ok('shell setting: local by default; openrouter sends the hosted shell on the Responses API');
}

console.log(`${n} cases`);
