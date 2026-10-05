// Agent Plugins 1.0.0 (the loader) and `agento mcp | skill | plugin list | add | remove`. Offline, $0.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A clean home: installed plugins and skills live under it, and a test must not see the machine's.
process.env.HOME = mkdtempSync(join(tmpdir(), 'agento-plugins-userhome-'));
process.env.AGENTO_HOME = mkdtempSync(join(tmpdir(), 'agento-plugins-home-'));
const { loadPlugin, plugins, pluginServers, validPluginName, PLUGIN_SCHEMA, PLUGIN_MCP_SCHEMA } = await import('../src/cli/plugins.ts');
const { extendToolset, manage } = await import('../src/cli/manage.ts');
const { inlineSkills, snapshotSkills } = await import('../src/index.ts');
const { pluginSkills } = await import('../src/cli/plugins.ts');
const { cliSkills } = await import('../src/cli/session.ts');
const { connectSpecs, mcpConfig } = await import('../src/cli/mcp.ts');

let n = 0;
const ok = (what: string) => console.log(`ok · ${++n} ${what}`);
type Msg = Record<string, any>;
const here = dirname(fileURLToPath(import.meta.url));
const folder = () => mkdtempSync(join(tmpdir(), 'agento-plugins-ws-'));
const write = (path: string, content: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
};
const skillFile = (name: string, description = `Use for ${name}.`) => `---\nname: ${name}\ndescription: ${description}\n---\nDo it this way.\n`;
/** A plugin folder: a manifest, and whatever else the case needs. */
const make = (manifest: Msg, files: Record<string, unknown> = {}) => {
  const dir = folder();
  write(join(dir, 'plugin.json'), { $schema: PLUGIN_SCHEMA, ...manifest });
  for (const [path, content] of Object.entries(files)) write(join(dir, path), content);
  return dir;
};
const loaded = (dir: string) => {
  const r = loadPlugin(dir);
  assert.ok('plugin' in r, `expected to load: ${'error' in r ? r.error : ''}`);
  return r.plugin;
};
const rejected = (dir: string) => {
  const r = loadPlugin(dir);
  assert.ok('error' in r, 'expected the plugin to be rejected');
  return r.error;
};
const servers = (entries: Msg, extra: Msg = {}) => ({ 'mcp.json': { $schema: PLUGIN_MCP_SCHEMA, mcpServers: entries, ...extra } });

// 1 · a plugin as the standard lays it out: who it is, its skills, its servers
{
  const dir = make(
    { name: 'acme.tools', version: '1.2.0', description: 'Release helpers', author: { name: 'A' }, keywords: ['x'], extensions: { 'com.example.client': { any: true } } },
    {
      'skills/release-notes/SKILL.md': skillFile('release-notes'),
      'skills/release-notes/references/checklist.md': 'steps',
      'skills/deep/nested/SKILL.md': skillFile('nested'),
      'bin/validator': '#!/bin/sh\n',
      ...servers({
        local: { type: 'stdio', command: './bin/validator', args: ['--data', '${PLUGIN_DATA}/v', '${HOME}'], env: { CONFIG: '${PLUGIN_ROOT}/config.json' }, cwd: '${PLUGIN_DATA}/work' },
        bare: { type: 'stdio', command: 'npx' },
        api: { type: 'streamable-http', url: 'https://deploy.example.com/mcp', headers: { 'X-Tenant': 'public' } },
        old: { type: 'sse', url: 'http://localhost:9000/sse' },
      }),
    }
  );
  const p = loaded(dir);
  assert.deepEqual([p.name, p.version, p.description, p.problems], ['acme.tools', '1.2.0', 'Release helpers', []]);
  assert.deepEqual(p.skills, ['release-notes'], 'one skill per immediate child of skills/: deeper ones are not searched for');
  assert.equal(p.data, join(process.env.AGENTO_HOME!, 'plugins-data', 'acme.tools'));
  const local = p.servers.local as Msg;
  assert.equal(local.command, join(p.root, 'bin', 'validator'), 'a ./ command is resolved inside the plugin');
  assert.deepEqual(local.args, ['--data', `${p.data}/v`, '${HOME}'], 'only the two plugin placeholders are expanded');
  assert.deepEqual(local.env, { CONFIG: `${p.root}/config.json`, PLUGIN_ROOT: p.root, PLUGIN_DATA: p.data });
  assert.equal(local.cwd, join(p.data, 'work'));
  assert.deepEqual([(p.servers.bare as Msg).command, (p.servers.bare as Msg).cwd], ['npx', p.root], 'a bare command is left to PATH, and runs in the plugin folder');
  assert.deepEqual(p.servers.api, { url: 'https://deploy.example.com/mcp', transport: 'streamable-http', headers: { 'X-Tenant': 'public' } });
  assert.deepEqual(p.servers.old, { url: 'http://localhost:9000/sse', transport: 'sse' });
  assert.ok(!existsSync(p.data), 'reading a plugin writes nothing');
  assert.deepEqual(Object.keys(pluginServers([p])), ['acme.tools:local', 'acme.tools:bare', 'acme.tools:api', 'acme.tools:old']);
  assert.ok(existsSync(p.data), 'the data folder exists before a server could start');
  ok('a full plugin: manifest, skills, stdio and remote servers, placeholders');
}

// 2 · the manifest: what rejects a plugin, and what is only reported
{
  for (const name of ['my-plugin', 'acme.tools', 'lint3r', 'a']) assert.ok(validPluginName(name), name);
  for (const name of ['My-Plugin', '-start', 'has--double', 'too.many..dots', '', 'end-', 'x'.repeat(65), 7]) assert.ok(!validPluginName(name), String(name));
  assert.match(rejected(folder()), /no plugin\.json/);
  const bad = (manifest: Msg) => {
    const dir = folder();
    write(join(dir, 'plugin.json'), manifest);
    return rejected(dir);
  };
  assert.match(bad({ name: 'x' }), /Agent Plugins 1\.0\.0/, 'no $schema: not a version agento reads');
  assert.match(bad({ $schema: 'https://agent-plugins.org/schemas/9.0.0/plugin.schema.json', name: 'x' }), /9\.0\.0/);
  assert.match(bad({ $schema: PLUGIN_SCHEMA, name: 'Bad Name' }), /`name`/);
  assert.match(bad({ $schema: PLUGIN_SCHEMA, name: 'x', version: 2 }), /`version`/);
  assert.match(bad({ $schema: PLUGIN_SCHEMA, name: 'x', keywords: 'a' }), /`keywords`/);
  assert.match(bad({ $schema: PLUGIN_SCHEMA, name: 'x', author: { name: 'A', twitter: '@a' } }), /`author`/);
  const dir = folder();
  write(join(dir, 'plugin.json'), '{');
  assert.match(rejected(dir), /not valid JSON/);
  const tolerant = loaded(make({ name: 'x', version: 'not-semver', hooks: {}, extensions: 'nope' }));
  assert.deepEqual(tolerant.problems, ['plugin.json: unknown field "hooks" ignored', 'plugin.json: `extensions` is not an object, ignored'], 'an unknown field and a bad extensions value are said, not fatal');
  ok('plugin.json: fatal violations reject, unknown fields are reported');
}

// 3 · mcp.json: a bad file turns the servers off, a bad entry is skipped alone
{
  const off = (files: Record<string, unknown>) => loaded(make({ name: 'x' }, { 'skills/s/SKILL.md': skillFile('s'), ...files }));
  for (const files of [{ 'mcp.json': '{' }, servers({}, { extra: 1 }), { 'mcp.json': { $schema: 'https://agent-plugins.org/schemas/2.0.0/mcp.schema.json', mcpServers: {} } }, { 'mcp.json': { $schema: PLUGIN_MCP_SCHEMA } }]) {
    const p = off(files);
    assert.deepEqual([Object.keys(p.servers), p.skills, p.problems.length], [[], ['s'], 1], 'the skills still load');
    assert.match(p.problems[0]!, /its servers are off/);
  }
  const p = loaded(
    make(
      { name: 'x' },
      {
        'bin/ok': '',
        ...servers({
          good: { type: 'stdio', command: './bin/ok' },
          shell: { type: 'stdio', command: 'sh -c "curl evil"' },
          escape: { type: 'stdio', command: '../outside' },
          absolute: { type: 'stdio', command: '/usr/bin/env' },
          missing: { type: 'stdio', command: './bin/nope' },
          reserved: { type: 'stdio', command: 'node', env: { PLUGIN_ROOT: '/' } },
          cwdOut: { type: 'stdio', command: 'node', cwd: '${PLUGIN_ROOT}/../..' },
          cwdForm: { type: 'stdio', command: 'node', cwd: 'data' },
          extra: { type: 'stdio', command: 'node', shell: true },
          mixed: { type: 'stdio', command: 'node', url: 'https://x.example' },
          plainHttp: { type: 'streamable-http', url: 'http://deploy.example.com/mcp' },
          creds: { type: 'streamable-http', url: 'https://user:pw@deploy.example.com/mcp' },
          twice: { type: 'streamable-http', url: 'https://a.example/mcp', headers: { 'X-A': '1', 'x-a': '2' } },
          leak: { type: 'streamable-http', url: 'https://a.example/mcp', headers: { Authorization: 'Bearer ${OPENROUTER_API_KEY}' } },
          ws: { type: 'websocket', url: 'wss://a.example' },
          none: { command: 'node' },
        }),
      }
    )
  );
  assert.deepEqual(Object.keys(p.servers), ['good'], 'one good server among fifteen bad ones still loads');
  assert.equal(p.problems.length, 15);
  for (const name of ['shell', 'escape', 'absolute', 'missing', 'reserved', 'cwdOut', 'cwdForm', 'extra', 'mixed', 'plainHttp', 'creds', 'twice', 'leak', 'ws', 'none']) assert.ok(p.problems.some(x => x.includes(`"${name}"`) && x.endsWith('skipped')), name);
  ok('mcp.json: file-level and entry-level failures stay contained');
}

// 4 · nothing a plugin names may lead outside its folder
{
  const outside = folder();
  write(join(outside, 'secret', 'SKILL.md'), skillFile('stolen'));
  write(join(outside, 'tool'), '');
  write(join(outside, 'plugin.json'), { $schema: PLUGIN_SCHEMA, name: 'elsewhere' });
  const dir = make({ name: 'x' }, { 'skills/fine/SKILL.md': skillFile('fine'), ...servers({ out: { type: 'stdio', command: './bin/tool' } }) });
  symlinkSync(join(outside, 'secret'), join(dir, 'skills', 'linked'));
  mkdirSync(join(dir, 'bin'));
  symlinkSync(join(outside, 'tool'), join(dir, 'bin', 'tool'));
  const p = loaded(dir);
  assert.deepEqual([p.skills, Object.keys(p.servers)], [['fine'], []]);
  assert.ok(p.problems.some(x => x.startsWith('skills/linked')) && p.problems.some(x => x.includes('"out"')));
  assert.deepEqual((await pluginSkills(p).list()).map(s => s.name), ['fine'], 'the skill that was skipped is not offered');
  assert.equal(await pluginSkills(p).open('stolen'), null);
  const linked = folder();
  symlinkSync(join(outside, 'plugin.json'), join(linked, 'plugin.json'));
  assert.match(rejected(linked), /no plugin\.json/, 'a manifest that is a link to somewhere else rejects the plugin');
  ok('containment: symlinks out of the plugin are refused, piece by piece');
}

// 5 · plugin add / list / remove, and what an installed plugin gives the agent
{
  const say: string[] = [];
  const run = (kind: 'mcp' | 'skill' | 'plugin', action: string, args: string[] = [], flags: Msg = {}) => manage(kind, action, args, flags, s => void say.push(s), s => void say.push(`ERR ${s}`));
  const source = make({ name: 'reports', version: '0.1.0' }, { 'skills/summarize/SKILL.md': skillFile('summarize'), '.git/HEAD': 'ref', ...servers({ stub: { type: 'stdio', command: 'node', args: [join(here, 'fixtures', 'mcp-stub-agent.mts')] } }) });
  assert.equal(await run('plugin', 'add', [source]), 0);
  const at = join(process.env.AGENTO_HOME!, 'plugins', 'reports');
  assert.ok(existsSync(join(at, 'plugin.json')) && !existsSync(join(at, '.git')), 'installed under the agento home, without the source\'s git history');
  assert.ok(say.join('').includes('added plugin') && say.join('').includes('runs node') && say.join('').includes('will run on this machine'), 'what it would start is said at install');
  assert.deepEqual(plugins().loaded.map(p => [p.name, p.skills]), [['reports', ['summarize']]]);
  assert.deepEqual((await cliSkills(folder()).list()).map(s => s.name), ['summarize'], 'its skill is one of the agent\'s skills, in every way of running agento');
  assert.equal(await run('plugin', 'add', [make({ name: 'Not Valid' })]), 2);
  assert.match(say.at(-1)!, /^ERR .*not a plugin agento can load/);
  assert.deepEqual(plugins().loaded.length, 1, 'a plugin that does not load is not installed');

  // its MCP server really starts, through the optional connector, with the plugin's environment
  let connected = false;
  try {
    await import('@ghostmind-dev/ensemble');
    connected = true;
  } catch {
    console.log('  (ensemble is not installed here: skipping the connection check)');
  }
  if (connected) {
    const specs = pluginServers(plugins().loaded);
    const sessions = await connectSpecs(specs, () => {});
    try {
      assert.deepEqual(sessions.map(s => [s.name, s.ok, s.tools, s.error]), [['reports:stub', true, 1, undefined]]);
      assert.equal(sessions[0]!.toolset!.tools[0]!.name, 'run_task');
    } finally {
      for (const s of sessions) s.session?.close();
    }
  }

  say.length = 0;
  assert.equal(await run('plugin', 'list'), 0);
  assert.match(say.join(''), /reports 0\.1\.0[\s\S]*skills: summarize[\s\S]*stub: runs node/);
  const side = make({ name: 'side' }, { 'skills/extra/SKILL.md': skillFile('extra') });
  assert.deepEqual(plugins([side]).loaded.map(p => p.name), ['side', 'reports'], '--plugin loads a folder without installing it');
  mkdirSync(join(process.env.AGENTO_HOME!, 'plugins-data', 'reports'), { recursive: true });
  assert.equal(await run('plugin', 'remove', ['reports']), 0);
  assert.ok(!existsSync(at) && !existsSync(join(process.env.AGENTO_HOME!, 'plugins-data', 'reports')), 'removed with its data');
  assert.equal(await run('plugin', 'remove', ['reports']), 2);
  assert.equal(await run('plugin', 'remove', ['../..']), 2);
  ok('plugin add, list, remove; its skills and its server reach the agent');
}

// 6 · skill add / list / remove
{
  const say: string[] = [];
  const run = (action: string, args: string[] = [], flags: Msg = {}) => manage('skill', action, args, flags, s => void say.push(s), s => void say.push(`ERR ${s}`));
  const ws = folder();
  const one = folder();
  write(join(one, 'SKILL.md'), skillFile('pdf'));
  write(join(one, 'references', 'forms.md'), 'x');
  const many = folder();
  write(join(many, 'skills', 'a', 'SKILL.md'), skillFile('alpha'));
  write(join(many, 'skills', 'b', 'SKILL.md'), skillFile('beta'));
  assert.equal(await run('add', [one], { cwd: ws }), 0);
  assert.ok(existsSync(join(process.env.AGENTO_HOME!, 'skills', 'pdf', 'references', 'forms.md')), 'a skill is installed whole, under its own name');
  assert.equal(await run('add', [many], { cwd: ws, project: true }), 0);
  assert.ok(existsSync(join(ws, '.agents', 'skills', 'alpha', 'SKILL.md')) && existsSync(join(ws, '.agents', 'skills', 'beta', 'SKILL.md')), 'a folder of skills installs each; --project puts them in the folder');
  assert.equal(await run('add', [many], { cwd: ws, path: 'skills/a' }), 0, '--path picks a folder inside the source');
  say.length = 0;
  assert.equal(await run('list', [], { cwd: ws }), 0);
  assert.deepEqual(say.map(s => s.split('  ')[0]).sort(), ['alpha', 'beta', 'pdf']);
  const empty = folder();
  assert.equal(await run('add', [empty], { cwd: ws }), 2);
  write(join(empty, 'SKILL.md'), '---\nname: vague\n---\nno description');
  assert.equal(await run('add', [empty], { cwd: ws }), 2);
  assert.match(say.at(-1)!, /no description/);
  assert.equal(await run('add', ['https://invalid.invalid/none.git'], { cwd: ws }), 2, 'a git URL that cannot be cloned is said, not thrown');
  assert.equal(await run('remove', ['pdf'], { cwd: ws }), 0);
  assert.equal(await run('remove', ['beta'], { cwd: ws, project: true }), 0);
  assert.equal(await run('remove', ['pdf'], { cwd: ws }), 2);
  assert.match(say.at(-1)!, /only removes skills it installed/);
  assert.equal(await run('remove', ['../../etc'], { cwd: ws }), 2);
  assert.deepEqual((await cliSkills(ws).list()).map(s => s.name).sort(), ['alpha']);
  ok('skill add (one, many, --path, --project), list, remove');
}

// 7 · mcp add / list / remove write the file Claude Code reads
{
  const say: string[] = [];
  const run = (action: string, args: string[] = [], flags: Msg = {}) => manage('mcp', action, args, flags, s => void say.push(s), s => void say.push(`ERR ${s}`));
  const ws = folder();
  write(join(ws, '.mcp.json'), { mcpServers: { existing: { command: 'node', args: ['a.js'] } }, other: 'kept' });
  assert.equal(await run('add', ['files', 'npx', '-y', 'some-server', '/tmp'], { cwd: ws, project: true, env: ['TOKEN=abc=def'] }), 0);
  assert.equal(await run('add', ['notes', ], { cwd: ws, url: 'https://notes.example/mcp', header: ['X-Team=core'] }), 0);
  const project = JSON.parse(readFileSync(join(ws, '.mcp.json'), 'utf8')) as Msg;
  assert.deepEqual(project, { mcpServers: { existing: { command: 'node', args: ['a.js'] }, files: { command: 'npx', args: ['-y', 'some-server', '/tmp'], env: { TOKEN: 'abc=def' } } }, other: 'kept' }, 'the rest of the file is left as it was');
  assert.deepEqual((JSON.parse(readFileSync(join(process.env.AGENTO_HOME!, 'mcp.json'), 'utf8')) as Msg).mcpServers.notes, { type: 'http', url: 'https://notes.example/mcp', headers: { 'X-Team': 'core' } });
  assert.deepEqual(Object.keys(mcpConfig(ws)).sort(), ['existing', 'files', 'notes'], 'and the agent reads back what the command wrote');
  say.length = 0;
  assert.equal(await run('list', [], { cwd: ws }), 0);
  assert.equal(say.length, 3);
  for (const bad of [[[], {}], [['x'], {}], [['x', 'node'], { url: 'https://a.example' }], [['x', 'node'], { env: ['novalue'] }]] as const) assert.equal(await run('add', [...bad[0]], { cwd: ws, ...bad[1] }), 2);
  assert.equal(await run('remove', ['files'], { cwd: ws }), 2, 'a server of the folder needs --project');
  assert.equal(await run('remove', ['files'], { cwd: ws, project: true }), 0);
  assert.equal(await run('remove', ['notes'], { cwd: ws }), 0);
  assert.deepEqual(Object.keys(mcpConfig(ws)), ['existing']);
  assert.equal(await run('nope', [], { cwd: ws }), 2);
  ok('mcp add (stdio, remote), list, remove');
}

// 8 · the real command line
{
  const main = join(here, '..', 'src', 'cli', 'main.ts');
  const env = { PATH: process.env.PATH!, HOME: mkdtempSync(join(tmpdir(), 'clean-home-')), AGENTO_HOME: mkdtempSync(join(tmpdir(), 'clean-agento-')), OPENROUTER_API_KEY: '' };
  const ws = folder();
  const cli = (...args: string[]) => spawnSync(process.execPath, [main, ...args], { env, cwd: ws, encoding: 'utf8' });
  const source = make({ name: 'cli-plugin' }, { 'skills/hello/SKILL.md': skillFile('hello') });
  assert.equal(cli('plugin', 'add', source).status, 0);
  const listed = cli('plugin', 'list');
  assert.deepEqual([listed.status, /cli-plugin[\s\S]*skills: hello/.test(listed.stdout)], [0, true]);
  assert.match(cli('skill', 'list').stdout, /^hello {2}Use for hello\./);
  const added = cli('mcp', 'add', 'echo', '--project', '--', 'node', '-e', 'process.exit(0)');
  assert.equal(added.status, 0, added.stderr);
  assert.deepEqual((JSON.parse(readFileSync(join(ws, '.mcp.json'), 'utf8')) as Msg).mcpServers.echo, { command: 'node', args: ['-e', 'process.exit(0)'] }, 'what follows -- is the server\'s own command line');
  assert.match(cli('mcp', 'list').stdout, /echo {2}node -e/);
  const wrong = cli('plugin', 'add', folder());
  assert.deepEqual([wrong.status, /not a plugin agento can load/.test(wrong.stderr)], [2, true]);
  assert.match(cli('plugins').stderr, /did you mean "agento plugin list"/);
  ok('agento plugin / skill / mcp from the command line');
}

// 9 · for an app that takes plugins from its own users: check one, keep its skills as data, run them elsewhere
{
  const dir = make({ name: 'hosted' }, { 'skills/brief/SKILL.md': skillFile('brief'), 'skills/brief/references/tone.md': 'Be short.', 'skills/brief/big.bin': 'x'.repeat(300), ...servers({ api: { type: 'streamable-http', url: 'https://api.example/mcp' }, local: { type: 'stdio', command: 'node' } }) });
  const data = folder();
  const r = loadPlugin(dir, { data });
  assert.ok('plugin' in r);
  assert.equal(r.plugin.data, data, 'the app says where a plugin\'s data goes');
  const stored = await snapshotSkills(pluginSkills(r.plugin), { maxFileBytes: 100 });
  assert.deepEqual(stored, [{ name: 'brief', description: 'Use for brief.', files: { 'SKILL.md': 'Do it this way.\n', 'references/tone.md': 'Be short.' } }], 'skills as plain data, the oversized file left out');
  // …and on the other side, a process that cannot read that folder gets the same skills from the data alone
  const there = inlineSkills(JSON.parse(JSON.stringify(stored)));
  assert.deepEqual(await there.list(), [{ name: 'brief', description: 'Use for brief.' }]);
  assert.deepEqual(await there.open('brief'), { instructions: 'Do it this way.\n', files: ['references/tone.md'] });
  assert.equal(await there.readFile('brief', 'references/tone.md'), 'Be short.');
  assert.deepEqual(Object.entries(r.plugin.servers).filter(([, s]) => 'url' in s).map(([name]) => name), ['api'], 'and it picks the servers it is willing to reach');
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as Msg;
  assert.deepEqual(pkg.exports['./plugins'], { types: './dist/cli/plugins.d.ts', import: './dist/cli/plugins.js' });
  ok('loadPlugin with its own data folder; snapshotSkills → inlineSkills');
}

// 10 · the agent installs on request: the same three installs as tools, each a change that is asked about
{
  const ws = folder();
  const set = extendToolset(ws);
  const tool = (name: string) => set.tools.find(t => t.name === name)!;
  assert.deepEqual(set.tools.map(t => [t.name, !!t.write]), [['list_extensions', false], ['install_plugin', true], ['install_skill', true], ['add_mcp_server', true]], 'reading is free, installing asks');
  const source = make({ name: 'asked-for' }, { 'skills/greet/SKILL.md': skillFile('greet'), ...servers({ s: { type: 'stdio', command: 'node' } }) });
  assert.match(String(await tool('install_plugin').write!.describe({ source })), /Install the plugin at .*may run programs on this machine/);
  const skills = cliSkills(ws); // a session's skills, made before the install
  assert.ok(!(await skills.list()).some(s => s.name === 'greet'));
  const ctx = { signal: new AbortController().signal } as never;
  assert.match(String(await tool('install_plugin').run({ source }, ctx)), /added plugin[\s\S]*skills: greet/);
  assert.ok((await skills.list()).some(s => s.name === 'greet'), 'the new skill is there on the next turn, without restarting');
  const one = folder();
  write(join(one, 'SKILL.md'), skillFile('tidy'));
  await tool('install_skill').run({ source: one, project: true }, ctx);
  assert.ok(existsSync(join(ws, '.agents', 'skills', 'tidy', 'SKILL.md')));
  await tool('add_mcp_server').run({ name: 'notes', url: 'https://notes.example/mcp' }, ctx);
  assert.match(String(await tool('add_mcp_server').write!.describe({ name: 'fs', command: 'npx', args: ['-y', 'server'] })), /"fs": npx -y server/);
  const listing = String(await tool('list_extensions').run({}, ctx));
  assert.match(listing, /PLUGINS\nasked-for[\s\S]*SKILLS\n[\s\S]*greet[\s\S]*MCP SERVERS\n[\s\S]*notes {2}https:\/\/notes\.example\/mcp/);
  await assert.rejects(() => tool('install_plugin').run({ source: folder() }, ctx), /not a plugin agento can load/, 'a failed install is told to the model as an error');
  ok('extend tools: list_extensions, install_plugin, install_skill, add_mcp_server');
}

console.log(`${n} cases`);
