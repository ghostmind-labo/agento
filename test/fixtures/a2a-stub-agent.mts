// agento's A2A server on a scripted executor: for the protocol's compliance kit (a2a-tck), which tells
// the agent what to do through the messageId of each message (its scenarios/*.feature files), and
// should not spend a cent on a real model.
//   npm run tck:a2a        (PORT picks the port; default 9999, the kit's own default)
import { fileStore, serveA2a, type A2aTurn } from '../../src/cli/a2a.ts';

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>(done => {
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); done(); }, { once: true });
  });
const timeout = Number(process.env.TCK_STREAMING_TIMEOUT ?? 2) * 1000;
const file = { filename: 'output.txt', mediaType: 'text/plain' };

/** Longest prefix first: "tck-artifact-file-url" must not be read as "tck-artifact-file". */
const SCENARIOS: [string, (t: A2aTurn) => Promise<void> | void][] = [
  ['tck-complete-task', t => t.status('TASK_STATE_COMPLETED', 'Hello from TCK')],
  ['tck-artifact-text', t => { t.artifact('Generated text content'); t.status('TASK_STATE_COMPLETED'); }],
  ['tck-artifact-file-url', t => { t.artifact([{ url: 'https://example.com/output.txt', ...file }]); t.status('TASK_STATE_COMPLETED'); }],
  ['tck-artifact-file', t => { t.artifact([{ raw: Buffer.from('file content').toString('base64'), ...file }]); t.status('TASK_STATE_COMPLETED'); }],
  ['tck-artifact-data', t => { t.artifact([{ data: { key: 'value', count: 42 } }]); t.status('TASK_STATE_COMPLETED'); }],
  ['tck-message-response', t => t.reply('Direct message response')],
  ['tck-input-required', t => t.status('TASK_STATE_INPUT_REQUIRED')],
  ['tck-reject-task', t => t.status('TASK_STATE_REJECTED', 'rejected')],
  ['tck-stream-001', t => { t.status('TASK_STATE_WORKING'); t.artifact('Stream hello from TCK'); t.status('TASK_STATE_COMPLETED'); }],
  ['tck-stream-002', t => t.status('TASK_STATE_COMPLETED')],
  ['tck-stream-003', t => { t.status('TASK_STATE_WORKING'); t.artifact('Stream task lifecycle'); t.status('TASK_STATE_COMPLETED'); }],
  ['tck-stream-ordering-001', t => { t.status('TASK_STATE_WORKING'); t.artifact('Ordered output'); t.status('TASK_STATE_COMPLETED'); }],
  ['tck-stream-artifact-text', t => { t.status('TASK_STATE_WORKING'); t.artifact('Streamed text content'); t.status('TASK_STATE_COMPLETED'); }],
  ['tck-stream-artifact-file', t => { t.status('TASK_STATE_WORKING'); t.artifact([{ raw: Buffer.from('file content').toString('base64'), ...file }]); t.status('TASK_STATE_COMPLETED'); }],
  ['tck-stream-artifact-chunked', t => { t.status('TASK_STATE_WORKING'); t.artifact('chunk-1 ', { artifactId: 'chunked', lastChunk: false }); t.artifact('chunk-2', { artifactId: 'chunked', append: true, lastChunk: true }); t.status('TASK_STATE_COMPLETED'); }],
  ['test-resubscribe-message-id', async t => { t.status('TASK_STATE_WORKING'); await wait(2 * timeout, t.signal); t.status('TASK_STATE_COMPLETED'); }],
];
SCENARIOS.sort((a, b) => b[0].length - a[0].length);

const handle = await serveA2a({
  port: Number(process.env.PORT ?? 9999),
  // A2A_STORE=<dir> runs the kit on the stored path, as a serverless deployment would be.
  store: process.env.A2A_STORE ? fileStore(process.env.A2A_STORE) : undefined,
  log: s => void process.stderr.write(s),
  card: { inputModes: ['text/plain', 'application/json'], outputModes: ['text/plain', 'application/json'] },
  executor: async turn => {
    const id = String(turn.message.messageId);
    const scenario = SCENARIOS.find(([prefix]) => id.startsWith(prefix));
    if (scenario) return void (await scenario[1](turn));
    turn.status('TASK_STATE_COMPLETED', 'ok');
  },
});
process.stderr.write(`a2a stub on ${handle.url}\n`);
