// agento's ACP server on a stand-in model that always answers "ok": for the protocol's compliance kit
// (acp-tck), which only checks the conversation, and should not spend a cent on a real model.
//   uv run acp-tck -- node test/fixtures/acp-stub-agent.mts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AGENTO_HOME ??= mkdtempSync(join(tmpdir(), 'agento-tck-'));
const { serveAcp } = await import('../../src/cli/acp.ts');

const provider = {
  defaultModel: 'stub',
  async chat(req: { onDelta?: (t: string) => void; signal?: AbortSignal }) {
    // A turn that takes a moment, so the kit can cancel one in flight (and a cancel is honoured at once).
    await new Promise<void>(done => {
      const timer = setTimeout(done, 600);
      req.signal?.addEventListener('abort', () => { clearTimeout(timer); done(); }, { once: true });
    });
    req.signal?.throwIfAborted();
    req.onDelta?.('ok');
    return { message: { role: 'assistant' as const, content: 'ok' }, finishReason: 'stop', model: 'stub', cost: 0 };
  },
};

await serveAcp({
  input: process.stdin,
  output: process.stdout,
  log: s => void process.stderr.write(s),
  defaultModel: 'stub',
  providerFor: () => provider,
  hasKey: () => true,
});
