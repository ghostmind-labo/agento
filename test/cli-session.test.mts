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
import { describeCall, printer, summary } from '../src/cli/ui.ts';

let n = 0;
const ok = (what: string) => console.log(`ok · ${++n} ${what}`);
const root = mkdtempSync(join(tmpdir(), 'agento-s-'));
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

// 4 · the printer: quiet by default (short calls, failures, Jev only when it acts); verbose shows everything
{
  const events = [
    { type: 'delta', text: 'Looking' },
    { type: 'tool_call', id: '1', name: 'read_file', args: { path: 'README.md', limit: 60 } },
    { type: 'tool_result', id: '1', name: 'read_file', ok: true, result: 'README.md (1 lines)' },
    { type: 'tool_call', id: '2', name: 'run_command', args: { command: 'npm test' } },
    { type: 'tool_result', id: '2', name: 'run_command', ok: false, result: 'Error: The person declined this change.' },
    { type: 'checkpoint', at: 'after_tool', question: 'q', p: 0.9, action: 'pass', level: 'normal' },
    { type: 'checkpoint', at: 'after_tool', question: 'q', p: 0.2, action: 'steer', level: 'normal' },
    { type: 'guidance', from: 'normal', level: 'close', reason: '2 low checkpoints in a row' },
    { type: 'delta', text: 'Done.' },
  ] as AgentEvent[];
  const run = (style: 'minimal' | 'normal' | 'verbose') => {
    let text = '';
    const p = printer(s => (text += s), { stream: true, style });
    events.forEach(e => p(e));
    p.flush();
    return text.replace(/\x1b\[\d+m/g, '');
  };
  assert.equal(run('normal'), 'Looking\n  · read_file README.md\n  · run_command npm test\n    ✗ The person declined this change.\n\nDone.\n', 'normal: a line per call, failures, no Jev scoring');
  assert.equal(run('minimal'), 'Looking\n    ✗ The person declined this change.\n\nDone.\n', 'minimal: answers and failures only, still on separate lines');
  const loud = run('verbose');
  assert.match(loud, /→ read_file \{"path":"README.md","limit":60\}\n {2}✓ README\.md \(1 lines\)/);
  assert.match(loud, /· Jev after_tool p=0\.90 → pass \[normal\]/);
  assert.match(loud, /· guidance normal → close/);
  ok('printer: minimal, normal and verbose');
}

// 4b · the turn summary: silent when a turn simply finished, unless verbose
{
  const r = { status: 'done', reason: null, answer: 'x', steps: 2, toolCalls: 1, cost: 0.001, messages: [] } as never;
  assert.equal(summary(r, 0.001, 'normal'), '');
  assert.match(summary(r, 0.001, 'verbose').replace(/\x1b\[\d+m/g, ''), /done · 2 steps · 1 tool calls · \$0\.00100/);
  const limit = { status: 'limit', reason: 'Out of steps (8).', answer: null, steps: 8, toolCalls: 8, cost: 0.01, messages: [] } as never;
  assert.equal(summary(limit, 0.01, 'minimal').replace(/\x1b\[\d+m/g, ''), '(limit: Out of steps (8).)');
  assert.equal(describeCall('search', { pattern: 'USD', path: 'src' }), 'search "USD" in src');
  assert.equal(describeCall('potion', { action: 'find_notes', args: {} }), 'potion.find_notes');
  assert.equal(describeCall('list_dir', {}), 'list_dir');
  ok('summary + describeCall');
}

// 5 · the entry point: --help works without a key; without a key it refuses clearly
{
  const main = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'main.ts');
  const env = { ...process.env, OPENROUTER_API_KEY: '', AGENTO_HOME: mkdtempSync(join(tmpdir(), 'agento-home-')) };
  const help = spawnSync(process.execPath, [main, '--help'], { encoding: 'utf8', env });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /agento — the agent core in a terminal/);
  const nokey = spawnSync(process.execPath, [main, '-p', 'hi', '--no-mcp'], { encoding: 'utf8', env, input: '' });
  assert.equal(nokey.status, 2);
  assert.match(nokey.stderr, /OPENROUTER_API_KEY is not set/);
  const nomodel = spawnSync(process.execPath, [main, '-p', 'hi', '--no-mcp'], { encoding: 'utf8', env: { ...env, OPENROUTER_API_KEY: 'sk-test', AGENT_MODEL: '' }, input: '' });
  assert.equal(nomodel.status, 2);
  assert.match(nomodel.stderr, /No model: run `agento model` once/);
  ok('main: --help, and clear refusals without a key or a model');
}

console.log(`${n} cases`);
