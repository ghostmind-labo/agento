/**
 * Does Jev's guidance help a weaker model? The same scenarios, guidance off vs close, compared on
 * success and cost.
 *
 *   node bench/guidance.mts                            dry run: a scripted "weak" worker and a scripted
 *                                                      Jev — proves the harness end to end, spends $0
 *   node bench/guidance.mts --live <model-id> [--runs N]
 *                                                      the real measure: that worker and real Jev on
 *                                                      OPENROUTER_API_KEY. It spends money; run it only
 *                                                      when you mean to.
 *
 * The dry run's weak worker is a caricature on purpose: it takes a wrong first step and gives up
 * unless something steers it. That makes the dry run test the WIRING (checkpoints fire, steers reach
 * the model, costs add up), not the thesis. The thesis is only ever measured live.
 *
 * Each scenario: a task, tools over fixed data, and a check on the answer (and on what was changed).
 */
import { openrouter, runAgent, scriptedModel, type AgentTool, type Answer, type ChatRequest, type Guidance, type ModelProvider, type Question, type Toolset } from '../src/index.ts';

interface Scenario {
  name: string;
  goal: string;
  expectation: string;
  toolsets: () => Toolset[];
  check: (answer: string | null) => boolean;
  /** The dry run's weak worker: the detour it takes, and the right call it makes once steered. */
  weak: { detour: { name: string; args: Record<string, unknown> }; right: { name: string; args: Record<string, unknown> }; wrong: string; correct: string };
}

const tool = (name: string, description: string, props: string[], run: (a: Record<string, unknown>) => unknown): AgentTool => ({
  name,
  description,
  parameters: { type: 'object', properties: Object.fromEntries(props.map(p => [p, { type: 'string' }])), required: props },
  run: async a => run(a),
});

const CAPITALS: Record<string, string> = { france: 'Paris', japan: 'Tokyo', canada: 'Ottawa' };
const POPULATION: Record<string, string> = { paris: '2.1 million', tokyo: '14 million', ottawa: '1.0 million' };
const ORDERS: Record<string, { status: string; carrier: string }> = { 'A-17': { status: 'shipped', carrier: 'Purolator' }, 'B-02': { status: 'delayed', carrier: 'UPS' } };

const scenarios: Scenario[] = [
  {
    name: 'two-hop lookup',
    goal: 'What is the population of the capital of Japan?',
    expectation: 'The population, in one sentence.',
    toolsets: () => [
      {
        name: 'atlas',
        description: 'Facts about places.',
        tools: [
          tool('capital_of', 'The capital city of a country.', ['country'], a => ({ capital: CAPITALS[String(a.country).toLowerCase()] ?? 'unknown' })),
          tool('population_of', 'The population of a CITY (not a country).', ['city'], a => ({ population: POPULATION[String(a.city).toLowerCase()] ?? 'unknown: not a city in the atlas' })),
        ],
      },
    ],
    check: a => !!a && /14 million/.test(a),
    weak: { detour: { name: 'population_of', args: { city: 'Japan' } }, right: { name: 'capital_of', args: { country: 'Japan' } }, wrong: "I couldn't find it.", correct: 'Tokyo, the capital of Japan, has about 14 million people.' },
  },
  {
    name: 'find before answering',
    goal: 'Which carrier is handling order B-02, and is it on time?',
    expectation: 'The carrier and the status.',
    toolsets: () => [
      {
        name: 'orders',
        description: 'Customer orders.',
        tools: [
          tool('list_orders', 'List order ids.', [], () => Object.keys(ORDERS)),
          tool('get_order', 'One order by id: status and carrier.', ['id'], a => ORDERS[String(a.id)] ?? { error: 'no such order' }),
        ],
      },
    ],
    check: a => !!a && /UPS/.test(a) && /delay/i.test(a),
    weak: { detour: { name: 'list_orders', args: {} }, right: { name: 'get_order', args: { id: 'B-02' } }, wrong: 'There are two orders.', correct: 'Order B-02 is with UPS and is delayed.' },
  },
];

/** The dry run's weak worker: detour first; without a steer it gives up, with one it recovers. */
function weakWorker(s: Scenario): ModelProvider {
  const steered = (r: ChatRequest) => r.messages.some(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('Guide (Jev'));
  let phase = 0;
  let recovered = false;
  const reply = (content: string | null, call?: { name: string; args: Record<string, unknown> }) => ({
    message: { role: 'assistant' as const, content, ...(call ? { tool_calls: [{ id: `c${phase}`, type: 'function' as const, function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : {}) },
    finishReason: call ? 'tool_calls' : 'stop',
    model: 'dry/weak',
    cost: 0.0004,
  });
  return scriptedModel(
    Array.from({ length: 12 }, () => (r: ChatRequest) => {
      phase++;
      if (phase === 1) return reply(null, s.weak.detour);
      if (!recovered && steered(r)) {
        recovered = true;
        return reply(null, s.weak.right);
      }
      if (recovered && phase <= 4 && s.name === 'two-hop lookup' && !r.messages.some(m => m.role === 'tool' && m.content.includes('14 million'))) return reply(null, { name: 'population_of', args: { city: 'Tokyo' } });
      return reply(recovered ? s.weak.correct : s.weak.wrong);
    }),
    { model: 'dry/weak', decideCost: 0.00002, card: { completion: 0.2 / 1e6, context: 32_000 }, decide: dryJev }
  );
}

/** The dry run's Jev: a result saying "unknown" or a bare id list does not move toward the goal. */
function dryJev(state: unknown, questions: Record<string, Question>): Record<string, Answer> {
  const text = JSON.stringify(state);
  const out: Record<string, Answer> = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === 'noul') out[id] = { type: 'noul', noul: /unknown|\[\\"A-17/.test(text) ? 0.1 : /couldn't|There are two/.test(text) ? 0.15 : 0.9 };
    else if (q.type === 'choice') {
      const keys = Object.keys(q.criteria);
      const k = keys.includes('task') ? 'task' : keys[0]!;
      out[id] = { type: 'choice', choice: k, confidence: 0.9, probabilities: Object.fromEntries(keys.map(x => [x, x === k ? 0.9 : 0.1 / Math.max(1, keys.length - 1)])) };
    } else out[id] = { type: 'score', score: 0, confidence: 1, probabilities: { '0': 1 }, legend: {} };
  }
  return out;
}

const args = process.argv.slice(2);
const liveAt = args.indexOf('--live');
const liveModel = liveAt >= 0 ? args[liveAt + 1] : undefined;
if (liveAt >= 0 && !liveModel) {
  console.error('usage: node bench/guidance.mts --live <model-id> [--runs N]');
  process.exit(2);
}
const runs = Number(args[args.indexOf('--runs') + 1]) || 1;
const settings: Guidance[] = ['off', 'close'];

console.log(liveModel ? `LIVE · ${liveModel} · ${runs} run(s) per cell · spends on OPENROUTER_API_KEY` : 'dry run · scripted weak worker + scripted Jev · costs are simulated, nothing is spent');
const rows: { scenario: string; guidance: Guidance; ok: number; runs: number; cost: number; checkpoints: number }[] = [];
for (const s of scenarios) {
  for (const guidance of settings) {
    const row = { scenario: s.name, guidance, ok: 0, runs, cost: 0, checkpoints: 0 };
    for (let i = 0; i < runs; i++) {
      const provider = liveModel ? openrouter({ model: liveModel }) : weakWorker(s);
      const r = await runAgent({
        provider,
        task: { goal: s.goal, expectation: s.expectation },
        toolsets: s.toolsets(),
        guidance,
        budget: { maxUsd: 0.25 },
        onEvent: e => void (e.type === 'checkpoint' && row.checkpoints++),
      });
      if (s.check(r.answer)) row.ok++;
      row.cost += r.cost;
    }
    rows.push(row);
  }
}

console.log('\nscenario                 guidance  success  checkpoints     cost');
for (const r of rows) console.log(`${r.scenario.padEnd(24)} ${String(r.guidance).padEnd(9)} ${`${r.ok}/${r.runs}`.padStart(7)}  ${String(r.checkpoints).padStart(11)}  $${r.cost.toFixed(5)}`);
for (const g of settings) {
  const mine = rows.filter(r => r.guidance === g);
  const ok = mine.reduce((a, r) => a + r.ok, 0);
  const total = mine.reduce((a, r) => a + r.runs, 0);
  console.log(`total ${String(g).padEnd(6)} ${ok}/${total} succeeded, $${mine.reduce((a, r) => a + r.cost, 0).toFixed(5)}`);
}
