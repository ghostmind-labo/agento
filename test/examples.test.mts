// The example and the benchmark dry-run end to end, offline and for $0.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

let n = 0;
const ok = (what: string) => console.log(`ok · ${++n} ${what}`);
const env = { ...process.env, OPENROUTER_API_KEY: '' };

// 1 · the two-tool example
{
  const r = spawnSync(process.execPath, ['examples/two-tools.mts'], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /approve\? Save the reminder "Take an umbrella" → yes/);
  assert.match(r.stdout, /status done · 3 steps · 2 tool calls/);
  assert.match(r.stdout, /reminders: \["Take an umbrella"\]/);
  ok('examples/two-tools.mts dry run');
}

// 2 · the guidance benchmark's dry run: the wiring works (not the thesis — that is measured live)
{
  const r = spawnSync(process.execPath, ['bench/guidance.mts'], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /total off\s+0\/2 succeeded/);
  assert.match(r.stdout, /total close\s+2\/2 succeeded/);
  ok('bench/guidance.mts dry run');
}

console.log(`${n} cases`);
