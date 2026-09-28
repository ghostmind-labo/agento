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
const { choose, home, pickable, readConfig, resolveModel, writeConfig } = await import('../src/cli/config.ts');

const card = (id: string, perM: number, tools = true): ModelCard => ({ id, name: id.split('/')[1]!.replace(/-/g, ' '), prompt: 0, completion: perM / 1e6, context: 128_000, tools, vision: false });
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

// 4 · a reply: a number from what was shown, or an exact id from the whole catalogue
{
  const shown = pickable(CATALOG, 'glm');
  assert.equal(choose('2', shown, CATALOG), 'z-ai/glm-5.3');
  assert.equal(choose(' 1 ', shown, CATALOG), 'z-ai/glm-5.3-flash');
  assert.equal(choose('9', shown, CATALOG), null);
  assert.equal(choose('anthropic/claude-sonnet-5', shown, CATALOG), 'anthropic/claude-sonnet-5', 'an id outside the shown list');
  assert.equal(choose('claude', shown, CATALOG), null);
  ok('choose');
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

console.log(`${n} cases`);
