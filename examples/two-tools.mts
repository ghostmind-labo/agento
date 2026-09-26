/**
 * A tiny agent with two tools: one that reads (the weather) and one that changes something (saving a
 * reminder, which asks for approval). It shows the whole shape of an app's agent — tools, a task,
 * approval, the event log — in about a page.
 *
 *   node examples/two-tools.mts                       dry run: a scripted model and a scripted Jev, $0
 *   node examples/two-tools.mts --live <model-id>     a real run on OPENROUTER_API_KEY (spends a little)
 */
import { eventLog, openrouter, runAgent, scriptedModel, type AgentTool, type ModelProvider } from '../src/index.ts';

const reminders: string[] = [];

const weather: AgentTool = {
  name: 'get_weather',
  description: 'The forecast for a city today.',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  run: async ({ city }) => ({ city, forecast: String(city).toLowerCase() === 'montreal' ? 'rain, 12°C' : 'sun, 20°C' }),
};

const remind: AgentTool = {
  name: 'save_reminder',
  description: 'Save a reminder for the person.',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  // A change: the loop asks the app's approve() with this sentence before it runs.
  write: { describe: ({ text }) => `Save the reminder "${text}"` },
  run: async ({ text }) => {
    reminders.push(String(text));
    return { saved: true };
  },
};

const live = process.argv.indexOf('--live');
if (live >= 0 && !process.argv[live + 1]) {
  console.error('usage: node examples/two-tools.mts --live <model-id>');
  process.exit(2);
}
const provider: ModelProvider =
  live >= 0
    ? openrouter({ model: process.argv[live + 1] })
    : scriptedModel([
        { text: 'Let me check the forecast.', calls: [{ name: 'get_weather', args: { city: 'Montreal' } }] },
        { calls: [{ name: 'save_reminder', args: { text: 'Take an umbrella' } }] },
        "It will rain in Montreal today (12°C), so I saved a reminder: \"Take an umbrella\".",
      ]);

const log = eventLog();
const result = await runAgent({
  provider,
  task: {
    goal: 'Will it rain in Montreal today? If so, remind me to take an umbrella.',
    expectation: 'One or two sentences: the forecast, and whether a reminder was saved.',
  },
  toolsets: [{ name: 'day', description: 'Weather and reminders.', tools: [weather, remind] }],
  approve: async request => {
    console.log(`  approve? ${request.summary} → yes`);
    return true;
  },
  budget: { maxUsd: 0.05 },
  log,
  onEvent: e => {
    if (e.type === 'tool_call') console.log(`  → ${e.name}(${JSON.stringify(e.args)})`);
    if (e.type === 'checkpoint') console.log(`  · Jev ${e.at}: ${e.p === null ? '—' : e.p.toFixed(2)} ${e.action}`);
  },
});

console.log(`\n${result.answer}\n`);
console.log(`status ${result.status} · ${result.steps} steps · ${result.toolCalls} tool calls · $${result.cost.toFixed(5)} · ${log.entries().length} events`);
console.log(`reminders: ${JSON.stringify(reminders)}`);
