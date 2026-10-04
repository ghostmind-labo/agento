// The standard tools: files (glob, search without ripgrep), and the web (search backend, fetch, HTML → Markdown). Offline, $0.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exaSearch, fileToolset, globToRegExp, htmlToMarkdown, htmlToText, isPrivateHost, mcpReplyText, nodeSearch, standardToolsets, webToolset } from '../src/toolkit/index.ts';

let n = 0;
const ok = (what: string) => console.log(`ok · ${++n} ${what}`);
const ctx = { signal: new AbortController().signal, spend: () => {}, callId: 'c' };
const run = (tools: ReturnType<typeof fileToolset>, name: string, args: Record<string, unknown>) => tools.tools.find(t => t.name === name)!.run(args, ctx) as Promise<string>;

// A small project on disk.
const root = mkdtempSync(join(tmpdir(), 'toolkit-'));
for (const [f, text] of Object.entries({
  'README.md': '# Demo\nTODO: write docs\n',
  'src/a.ts': 'export const a = 1;\n// TODO: refactor\n',
  'src/deep/b.ts': 'export const b = 2;\n',
  'src/deep/b.test.ts': 'test("b");\nTODO: more\n',
  'src/c.tsx': 'const c = <div/>;\n',
  'node_modules/dep/index.ts': 'TODO: should never show\n',
  'bin.dat': 'TODO\u0000binary\n',
})) {
  mkdirSync(join(root, f.split('/').slice(0, -1).join('/') || '.'), { recursive: true });
  writeFileSync(join(root, f), text);
}
const files = fileToolset(root, { ripgrep: false });

// 1 · glob patterns
{
  const m = (g: string, p: string) => globToRegExp(g).test(p);
  assert.ok(m('*.ts', 'a.ts') && m('*.ts', 'src/deep/b.ts'), 'no slash: any depth');
  assert.ok(!m('*.ts', 'src/c.tsx'));
  assert.ok(m('src/**/*.ts', 'src/a.ts') && m('src/**/*.ts', 'src/deep/b.ts'));
  assert.ok(!m('src/*.ts', 'src/deep/b.ts'), '* does not cross folders');
  assert.ok(m('**/*.test.ts', 'src/deep/b.test.ts'));
  assert.ok(m('src/**/*.{ts,tsx}', 'src/c.tsx') && !m('src/**/*.{ts,tsx}', 'src/d.js'));
  assert.ok(m('README*', 'README.md') && m('a.?s', 'a.ts'));
  assert.ok(m('./src/a.ts', 'src/a.ts'));
  assert.ok(!m('a.ts', 'ba.ts'), 'a bare name matches whole names, not endings');
  ok('globToRegExp');
}

// 2 · the glob tool
{
  assert.equal(await run(files, 'glob', { pattern: '**/*.ts' }), 'src/a.ts\nsrc/deep/b.test.ts\nsrc/deep/b.ts');
  assert.equal(await run(files, 'glob', { pattern: '*.test.ts' }), 'src/deep/b.test.ts');
  assert.equal(await run(files, 'glob', { pattern: '*.ts', path: 'src/deep' }), 'src/deep/b.test.ts\nsrc/deep/b.ts', 'paths stay relative to the root');
  assert.equal(await run(files, 'glob', { pattern: 'nothing*' }), 'No files match.');
  await assert.rejects(run(files, 'glob', { pattern: '*', path: '../..' }), /outside the working directory/);
  ok('glob tool');
}

// 3 · search without ripgrep: same shape, skips node_modules and binaries, filters by glob, 20 per file
{
  const all = await run(files, 'search', { pattern: 'TODO' });
  assert.equal(all, 'README.md:2:TODO: write docs\nsrc/a.ts:2:// TODO: refactor\nsrc/deep/b.test.ts:2:TODO: more');
  assert.equal(await run(files, 'search', { pattern: 'TODO', glob: '*.test.ts' }), 'src/deep/b.test.ts:2:TODO: more');
  assert.equal(await run(files, 'search', { pattern: 'TODO', path: 'src/deep' }), 'src/deep/b.test.ts:2:TODO: more');
  assert.equal(await run(files, 'search', { pattern: 'zzz-nothing' }), 'No matches.');
  assert.match(await run(files, 'search', { pattern: 'a(' }), /No matches\./, 'an invalid regex is searched literally, not thrown');
  writeFileSync(join(root, 'many.txt'), Array.from({ length: 50 }, () => 'hit').join('\n'));
  assert.equal((await run(files, 'search', { pattern: 'hit' })).split('\n').length, 20, 'at most 20 matches per file');
  assert.equal(nodeSearch(root, 'export const', join(root, 'src')).split('\n').length, 2);
  ok('search without ripgrep');
}

// 4 · HTML → Markdown
{
  const html = `<!doctype html><html><head><title>Docs &amp; Guides</title><script>var x = 1;</script><style>p{}</style></head>
    <body><nav><a href="/home">Home</a></nav>
    <main><h1>Install</h1><p>Run <code>npm i agento</code> and read the <a href="/guide?x=1&amp;y=2">guide</a>. It is <strong>fast</strong> &amp; <em>small</em>.</p>
    <ul><li>one</li><li>two <a href="#top">top</a></li></ul>
    <pre><code>const a = 1 &lt; 2;\nconsole.log(a)</code></pre>
    <table><tr><th>Name</th><th>Price</th></tr><tr><td>GLM</td><td>$0.50</td></tr></table>
    <img src="x.png" alt="a diagram"><p>${'filler text '.repeat(40)}</p></main><footer>© nobody</footer></body></html>`;
  const md = htmlToMarkdown(html, 'https://example.com/docs/');
  assert.ok(md.startsWith('# Docs & Guides\n\n'), 'the title leads');
  assert.match(md, /\n# Install\n/);
  assert.match(md, /Run `npm i agento` and read the \[guide\]\(https:\/\/example\.com\/guide\?x=1&y=2\)\. It is \*\*fast\*\* & \*small\*\./);
  assert.match(md, /\n- one\n- two top\n/, 'a same-page link keeps its text only');
  assert.match(md, /```\nconst a = 1 < 2;\nconsole\.log\(a\)\n```/);
  assert.match(md, /Name \| Price \|\nGLM \| \$0\.50 \|/);
  assert.match(md, /\[image: a diagram\]/);
  assert.ok(!/var x|p\{\}|Home|nobody/.test(md), 'script, style, nav and footer are gone');
  assert.equal(htmlToText('<h1>Hi</h1><p>A <a href="/x">link</a> and <b>bold</b>.</p>'), 'Hi\n\nA link and bold.');
  assert.equal(htmlToMarkdown('<p>&#8364;5 &#x41; &nbsp;&unknown; &copy;</p>'), '€5 A &unknown; ©');
  ok('htmlToMarkdown');
}

// 5 · addresses we will not fetch
{
  for (const h of ['localhost', 'app.localhost', 'printer.local', 'db.internal', '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '[::1]', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '']) assert.ok(isPrivateHost(h), h);
  for (const h of ['example.com', '8.8.8.8', '172.32.0.1', '172.15.0.1', '100.63.0.1', 'localhost.example.com', '2606:4700::1111']) assert.ok(!isPrivateHost(h), h);
  ok('isPrivateHost');
}

// 6 · reading an MCP server's reply (the shape Exa sends)
{
  const sse = 'event: message\ndata: {"result":{"content":[{"type":"text","text":"Title: A\\nURL: https://a.dev"}]}}\n\n';
  assert.equal(mcpReplyText(sse), 'Title: A\nURL: https://a.dev');
  assert.equal(mcpReplyText('{"result":{"content":[{"type":"text","text":"x"},{"type":"image"},{"type":"text","text":"y"}]}}'), 'x\ny');
  assert.throws(() => mcpReplyText('data: {"error":{"message":"bad"}}'), /bad/);
  assert.throws(() => mcpReplyText('data: {"result":{"isError":true,"content":[{"type":"text","text":"quota"}]}}'), /quota/);
  assert.throws(() => mcpReplyText('<html>nope</html>'), /could not be read/);
  ok('mcpReplyText');
}

// 7 · Exa search: the request, with and without a key, and its failures
{
  const calls: { url: string; body: any; headers: Record<string, string> }[] = [];
  const fetch = (async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return new Response('event: message\ndata: {"result":{"content":[{"type":"text","text":"Title: ACP\\nURL: https://agentclientprotocol.com"}]}}\n\n', { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  delete process.env.EXA_API_KEY;
  const text = await exaSearch({ fetch })('agent client protocol', 3, ctx.signal);
  assert.equal(text, 'Title: ACP\nURL: https://agentclientprotocol.com');
  assert.equal(calls[0]!.url, 'https://mcp.exa.ai/mcp', 'no key: the free endpoint');
  assert.deepEqual(calls[0]!.body, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'web_search_exa', arguments: { query: 'agent client protocol', numResults: 3 } } });
  assert.match(calls[0]!.headers.Accept!, /text\/event-stream/);
  await exaSearch({ fetch, apiKey: 'k e y' })('q', 1, ctx.signal);
  assert.equal(calls[1]!.url, 'https://mcp.exa.ai/mcp?exaApiKey=k%20e%20y');
  const limited = (async () => new Response('slow down', { status: 429 })) as unknown as typeof globalThis.fetch;
  await assert.rejects(exaSearch({ fetch: limited })('q', 1, ctx.signal), /answered 429 \(rate-limited: try again shortly, or set EXA_API_KEY\)/);
  ok('exaSearch');
}

// 8 · web_search tool: validation, clamping, a custom backend
{
  const asked: [string, number][] = [];
  const web = webToolset({ search: async (q, c) => (asked.push([q, c]), q === 'nothing' ? '' : `result for ${q}`) });
  assert.equal(await run(web, 'web_search', { query: ' hello ' }), 'result for hello');
  await run(web, 'web_search', { query: 'a', num_results: 99 });
  await run(web, 'web_search', { query: 'b', num_results: 0 });
  await run(web, 'web_search', { query: 'c', num_results: 'x' });
  assert.deepEqual(asked.map(a => a[1]), [5, 10, 5, 5], 'default 5, at most 10, junk falls back');
  assert.equal(await run(web, 'web_search', { query: 'nothing' }), 'No results.');
  await assert.rejects(run(web, 'web_search', { query: '   ' }), /`query` is empty/);
  ok('web_search tool');
}

// 9 · web_fetch
{
  const page = `<html><head><title>Hello</title></head><body><main><h1>Hi</h1><p>${'word '.repeat(5000)}</p></main></body></html>`;
  const seen: string[] = [];
  const routes: Record<string, () => Response> = {
    'https://example.com/page': () => new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
    'https://example.com/data.json': () => new Response('{"a":1}', { headers: { 'content-type': 'application/json' } }),
    'https://example.com/plain': () => new Response('just text', { headers: { 'content-type': 'text/plain' } }),
    'https://example.com/old': () => new Response(null, { status: 301, headers: { location: '/page' } }),
    'https://example.com/loop': () => new Response(null, { status: 302, headers: { location: '/loop' } }),
    'https://example.com/to-private': () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }),
    'https://example.com/missing': () => new Response('nope', { status: 404, statusText: 'Not Found' }),
    'https://example.com/pic.png': () => new Response('\u0089PNG', { headers: { 'content-type': 'image/png' } }),
    'https://example.com/huge': () => new Response('x', { headers: { 'content-type': 'text/plain', 'content-length': '9000000' } }),
    'http://localhost:3000/': () => new Response('<h1>dev server</h1>', { headers: { 'content-type': 'text/html' } }),
  };
  const fetch = (async (url: string) => {
    seen.push(url);
    const r = routes[url];
    if (!r) throw new Error(`unexpected ${url}`);
    return r();
  }) as unknown as typeof globalThis.fetch;
  const web = webToolset({ fetch });

  const first = await run(web, 'web_fetch', { url: 'https://example.com/page' });
  assert.match(first, /^https:\/\/example\.com\/page · text\/html · \d+ characters\n\n# Hello\n\n# Hi\n\nword word/);
  assert.match(first, /…\(\d+ more characters; continue with start=12000\)$/);
  const second = await run(web, 'web_fetch', { url: 'https://example.com/page', start: 12000 });
  assert.ok(!second.includes('# Hello'), 'the next piece starts where the first ended');
  assert.match(second, /…\(\d+ more characters; continue with start=24000\)|word$/);

  assert.match(await run(web, 'web_fetch', { url: 'https://example.com/data.json' }), /application\/json · 7 characters\n\n\{"a":1\}$/);
  assert.match(await run(web, 'web_fetch', { url: 'https://example.com/plain' }), /\n\njust text$/);
  assert.match(await run(web, 'web_fetch', { url: 'https://example.com/page', format: 'html', start: 0 }), /<title>Hello<\/title>/);
  assert.match(await run(web, 'web_fetch', { url: 'https://example.com/page', format: 'text' }), /\n\nHello\n\nHi\n\nword word/);

  const viaRedirect = await run(web, 'web_fetch', { url: 'https://example.com/old' });
  assert.match(viaRedirect, /^https:\/\/example\.com\/page \(from https:\/\/example\.com\/old\)/);
  await assert.rejects(run(web, 'web_fetch', { url: 'https://example.com/loop' }), /Too many redirects/);
  await assert.rejects(run(web, 'web_fetch', { url: 'https://example.com/to-private' }), /169\.254\.169\.254 is a local or private address/);
  assert.ok(!seen.includes('http://169.254.169.254/latest/meta-data'), 'the private hop was never requested');
  await assert.rejects(run(web, 'web_fetch', { url: 'https://example.com/missing' }), /answered 404 Not Found/);
  await assert.rejects(run(web, 'web_fetch', { url: 'https://example.com/pic.png' }), /image\/png, which cannot be read as text/);
  await assert.rejects(run(web, 'web_fetch', { url: 'https://example.com/huge' }), /9 MB; the limit is 5 MB/);
  await assert.rejects(run(web, 'web_fetch', { url: 'file:///etc/passwd' }), /Only http and https/);
  await assert.rejects(run(web, 'web_fetch', { url: 'not a url' }), /not a valid URL/);
  await assert.rejects(run(web, 'web_fetch', { url: 'http://localhost:3000/' }), /localhost is a local or private address/);
  assert.match(await run(webToolset({ fetch, allowPrivate: true }), 'web_fetch', { url: 'http://localhost:3000/' }), /# dev server/);
  ok('web_fetch');
}

// 10 · the standard set, and leaving kinds out
{
  const names = (t: ReturnType<typeof standardToolsets>) => t.flatMap(s => s.tools.map(x => x.name));
  assert.deepEqual(names(standardToolsets({ root })), ['list_dir', 'read_file', 'glob', 'search', 'write_file', 'edit_file', 'run_command', 'web_search', 'web_fetch']);
  assert.deepEqual(names(standardToolsets({ root, shell: false, web: false })), ['list_dir', 'read_file', 'glob', 'search', 'write_file', 'edit_file']);
  const changes = standardToolsets({ root }).flatMap(s => s.tools).filter(t => t.write).map(t => t.name);
  assert.deepEqual(changes, ['write_file', 'edit_file', 'run_command'], 'only these ask for approval; reads and the web do not');
  ok('standardToolsets');
}

console.log(`${n} cases`);
