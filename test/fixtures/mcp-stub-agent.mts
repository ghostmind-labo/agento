// agento's MCP server on a scripted model: a stand-in for the real thing, so a client (ensemble's own,
// in the tests) can call run_task for $0. Each call gets a fresh script: look at the folder, then answer.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AGENTO_HOME ??= mkdtempSync(join(tmpdir(), 'agento-mcp-stub-'));
const { scriptedModel } = await import('../../src/index.ts');
const { serveMcp } = await import('../../src/cli/mcp-server.ts');

await serveMcp({
  input: process.stdin,
  output: process.stdout,
  log: s => void process.stderr.write(s),
  defaultModel: 'stub/worker',
  providerFor: () => scriptedModel([{ calls: [{ name: 'list_dir', args: {} }], cost: 0.002 }, { text: 'Found it.', cost: 0.002 }], { decide: false }),
  hasKey: () => true,
});
