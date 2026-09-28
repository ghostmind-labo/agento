// The CLI's tools: file access confined to the root, edits exact, the shell bounded, MCP config read. Offline.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileToolset, inside } from '../src/cli/files.ts';
import { shellToolset } from '../src/cli/shell.ts';
import { mcpConfig, WRITE_VERBS } from '../src/cli/mcp.ts';

let n = 0;
const ok = (what: string) => console.log(`ok · ${++n} ${what}`);
const root = mkdtempSync(join(tmpdir(), 'agent-cli-'));
mkdirSync(join(root, 'src'));
writeFileSync(join(root, 'src', 'a.ts'), 'const x = 1;\nconst y = 2;\nconst x2 = 1;\n');
const ctx = { signal: new AbortController().signal, spend: () => {}, callId: 'c' };
const files = Object.fromEntries(fileToolset(root).tools.map(t => [t.name, t]));
const shell = shellToolset(root).tools[0]!;

// 1 · paths never escape the root
{
  assert.equal(inside(root, 'src/a.ts'), join(root, 'src', 'a.ts'));
  assert.equal(inside(root, undefined), root);
  assert.throws(() => inside(root, '../etc/passwd'), /outside the working directory/);
  assert.throws(() => inside(root, '/etc/passwd'), /outside the working directory/);
  await assert.rejects(files.read_file!.run({ path: '../../x' }, ctx), /outside/);
  ok('confined to the root');
}

// 2 · list, read (numbered, partial), search
{
  assert.match(String(await files.list_dir!.run({}, ctx)), /src\/\n {2}a\.ts {2}\d+b/);
  const read = String(await files.read_file!.run({ path: 'src/a.ts', offset: 2, limit: 1 }, ctx));
  assert.match(read, /^src\/a\.ts \(4 lines\)\n {4}2 {2}const y = 2;\n…\(2 more lines; read on with offset 3\)$/);
  assert.match(String(await files.search!.run({ pattern: 'const x', glob: '*.ts' }, ctx)), /src\/a\.ts:1:const x = 1;/);
  assert.equal(await files.search!.run({ pattern: 'nothing-here' }, ctx), 'No matches.');
  ok('list_dir, read_file, search');
}

// 3 · writes and edits are changes: they describe themselves for approval, and edit is exact
{
  assert.equal(await files.write_file!.write!.describe({ path: 'new/b.md', content: 'one\ntwo' }), 'Create new/b.md (2 lines)');
  await files.write_file!.run({ path: 'new/b.md', content: 'one\ntwo' }, ctx);
  assert.equal(readFileSync(join(root, 'new', 'b.md'), 'utf8'), 'one\ntwo');
  assert.equal(await files.write_file!.write!.describe({ path: 'new/b.md', content: 'x' }), 'Overwrite new/b.md (1 lines)');
  assert.match(String(await files.edit_file!.write!.describe({ path: 'src/a.ts', old: 'const y = 2;', new: 'const y = 3;' })), /^Edit src\/a\.ts: replace\s+"const y = 2;" → "const y = 3;"$/);
  await files.edit_file!.run({ path: 'src/a.ts', old: 'const y = 2;', new: 'const y = 3;' }, ctx);
  assert.match(readFileSync(join(root, 'src', 'a.ts'), 'utf8'), /const y = 3;/);
  await assert.rejects(files.edit_file!.run({ path: 'src/a.ts', old: '= 1;', new: '= 9;' }, ctx), /appears 2 times/);
  await assert.rejects(files.edit_file!.run({ path: 'src/a.ts', old: 'nope', new: 'x' }, ctx), /not found/);
  assert.equal(await files.edit_file!.run({ path: 'src/a.ts', old: '= 1;', new: '= 9;', all: true }, ctx), 'Edited src/a.ts (2 replacements).');
  await files.edit_file!.run({ path: 'src/a.ts', old: 'const y = 3;', new: 'const $& = "$1";' }, ctx);
  assert.match(readFileSync(join(root, 'src', 'a.ts'), 'utf8'), /const \$& = "\$1";/, 'replacement text is literal, not a regex pattern');
  ok('write_file and edit_file');
}

// 4 · the shell: always a change, runs in the root, reports exit codes, killed on timeout
{
  assert.equal(await shell.write!.describe({ command: 'ls -la' }), 'Run: ls -la');
  assert.match(String(await shell.run({ command: 'pwd && echo hi' }, ctx)), new RegExp(`^exit 0\\n.*${root.split('/').pop()}\\nhi\\n$`, 's'));
  assert.match(String(await shell.run({ command: 'exit 3' }, ctx)), /^exit 3/);
  assert.match(String(await shell.run({ command: 'sleep 5', timeout_s: 1 }, ctx)), /^\(killed after 1s\)/);
  ok('run_command');
}

// 5 · MCP: Claude Code's .mcp.json shape → ensemble specs; write-looking tools ask approval
{
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { potion: { type: 'http', url: 'https://mcp.potion.run', headers: { workspace: 'home' } }, fs: { command: 'npx', args: ['-y', 'x'] }, old: { type: 'sse', url: 'https://e/sse' } } }));
  const cfg = mcpConfig(root);
  assert.deepEqual(cfg.potion, { url: 'https://mcp.potion.run', transport: 'auto', headers: { workspace: 'home' } });
  assert.deepEqual(cfg.fs, { command: 'npx', args: ['-y', 'x'] });
  assert.equal((cfg.old as { transport: string }).transport, 'sse');
  for (const t of ['create_note', 'update_record', 'delete_view', 'append_to_note', 'trash_note']) assert.ok(WRITE_VERBS.test(t), t);
  for (const t of ['list_notes', 'read_note', 'search', 'get_context', 'find_note']) assert.ok(!WRITE_VERBS.test(t), t);
  ok('mcp config + write detection');
}

console.log(`${n} cases`);
