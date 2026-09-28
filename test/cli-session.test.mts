// A whole CLI conversation on a scripted model: tools, approvals, history, the log. Offline, $0.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scriptedModel, type AgentEvent, type ApprovalRequest } from '../src/index.ts';
import { createSession, type Answer } from '../src/cli/session.ts';
import { fileToolset } from '../src/cli/files.ts';
import { shellToolset } from '../src/cli/shell.ts';
import { printer } from '../src/cli/ui.ts';

let n = 0;
const ok = (what: string) => console.log(`ok · ${++n} ${what}`);
const root = mkdtempSync(join(tmpdir(), 'agent-cli-s-'));
writeFileSync(join(root, 'notes.md'), 'TODO: write tests\n');

// 1 · a two-turn conversation: read, edit (approved with "always"), then a follow-up that remembers
{
  const provider = scriptedModel(
    [
      { calls: [{ name: 'read_file', args: { path: 'notes.md' } }] },
      { calls: [{ name: 'edit_file', args: { path: 'notes.md', old: 'TODO', new: 'DONE' } }] },
      'Marked it DONE in notes.md.',
      { calls: [{ name: 'edit_file', args: { path: 'notes.md', old: 'tests', new: 'more tests' } }] },
      'Changed it again.',
    ],
    { decide: false }
  );
  const asked: ApprovalRequest[] = [];
  const events: AgentEvent[] = [];
  const logPath = join(root, 'log', 's.jsonl');
  const s = createSession({
    provider,
    root,
    toolsets: [fileToolset(root), shellToolset(root)],
    guidance: 'off',
    maxUsd: 0.1,
    ask: async (r): Promise<Answer> => {
      asked.push(r);
      return 'always';
    },
    onEvent: e => void events.push(e),
    logPath,
  });
  const r1 = await s.send('Mark the TODO in notes.md as done');
  assert.equal(r1.status, 'done');
  assert.equal(readFileSync(join(root, 'notes.md'), 'utf8'), 'DONE: write tests\n');
  assert.equal(asked.length, 1);
  assert.match(asked[0]!.summary, /^Edit notes\.md: replace/);

  const r2 = await s.send('and change tests to more tests');
  assert.equal(r2.status, 'done');
  assert.equal(readFileSync(join(root, 'notes.md'), 'utf8'), 'DONE: write more tests\n');
  assert.equal(asked.length, 1, '"always" covers later edit_file calls');
  const sent = provider.requests.at(-1)!.messages;
  assert.ok(sent.some(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('Mark the TODO')), 'the first turn is in the second turn\'s history');
  assert.match(String(sent[0]!.content), new RegExp(`working in ${root.replace(/[/.]/g, '\\$&')}`));

  assert.ok(existsSync(logPath));
  const lines = readFileSync(logPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(lines.filter(l => l.event.type === 'finished').length, 2, 'one log across both turns');
  assert.equal(s.turns, 2);
  ok('two turns: read → approved edit → follow-up with history, one log');
}

// 2 · a declined change: nothing written, the turn ends on the person
{
  writeFileSync(join(root, 'keep.txt'), 'original');
  const s = createSession({
    provider: scriptedModel([{ calls: [{ name: 'write_file', args: { path: 'keep.txt', content: 'changed' } }] }, 'OK, left it alone.'], { decide: false }),
    root,
    toolsets: [fileToolset(root)],
    guidance: 'off',
    maxUsd: 0.1,
    ask: async () => 'no',
    onEvent: () => {},
  });
  const r = await s.send('overwrite keep.txt');
  assert.equal(readFileSync(join(root, 'keep.txt'), 'utf8'), 'original');
  assert.equal(r.status, 'needs_person');
  ok('declined change: file untouched, needs_person');
}

// 3 · /auto: approvals skipped
{
  const s = createSession({
    provider: scriptedModel([{ calls: [{ name: 'run_command', args: { command: 'echo auto > auto.txt' } }] }, 'Done.'], { decide: false }),
    root,
    toolsets: [shellToolset(root)],
    guidance: 'off',
    maxUsd: 0.1,
    ask: async () => {
      throw new Error('should not ask');
    },
    onEvent: () => {},
    autoApprove: true,
  });
  await s.send('make auto.txt');
  assert.equal(readFileSync(join(root, 'auto.txt'), 'utf8'), 'auto\n');
  ok('auto-approve');
}

// 4 · the printer shows the engine's inner life: calls, results, Jev checkpoints, levels
{
  let text = '';
  const p = printer(s => (text += s), { stream: true, verbose: false });
  p({ type: 'delta', text: 'Looking' });
  p({ type: 'tool_call', id: '1', name: 'read_file', args: { path: 'a' } });
  p({ type: 'tool_result', id: '1', name: 'read_file', ok: true, result: 'a (1 lines)' });
  p({ type: 'checkpoint', at: 'after_tool', question: 'q', p: 0.2, action: 'steer', level: 'normal' });
  p({ type: 'guidance', from: 'normal', level: 'close', reason: '2 low checkpoints in a row' });
  const plain = text.replace(/\x1b\[\d+m/g, '');
  assert.match(plain, /^Looking\n→ read_file \{"path":"a"\}\n {2}✓ a \(1 lines\)\n· Jev after_tool p=0\.20 → steer \[normal\]\n· guidance normal → close \(2 low checkpoints in a row\)\n$/);
  ok('printer');
}

// 5 · the entry point: --help works without a key; without a key it refuses clearly
{
  const main = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'main.ts');
  const env = { ...process.env, OPENROUTER_API_KEY: '' };
  const help = spawnSync(process.execPath, [main, '--help'], { encoding: 'utf8', env });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /agent — test the agent core from a terminal/);
  const nokey = spawnSync(process.execPath, [main, '-p', 'hi', '--no-mcp'], { encoding: 'utf8', env, input: '' });
  assert.equal(nokey.status, 2);
  assert.match(nokey.stderr, /OPENROUTER_API_KEY is not set/);
  const nomodel = spawnSync(process.execPath, [main, '-p', 'hi', '--no-mcp'], { encoding: 'utf8', env: { ...env, OPENROUTER_API_KEY: 'sk-test', AGENT_MODEL: '' }, input: '' });
  assert.equal(nomodel.status, 2);
  assert.match(nomodel.stderr, /No model: pass --model/);
  ok('main: --help, and clear refusals without a key or a model');
}

console.log(`${n} cases`);
