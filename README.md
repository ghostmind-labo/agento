# @ghostmind-dev/agent

The engine every app builds its own agent from. The loop, and everything it needs to run safely:

- a worker model that calls tools, through OpenRouter;
- **Jev**, a calibrated decision model, guiding the worker at checkpoints;
- budgets, including a USD cap;
- `go` / `pause` / `stop` hooks;
- an append-only event log.

It is a **library**: import it, give it tools, run it. No server, no service, no connection to call. Zero runtime dependencies, Node ≥ 22.18, one credential: `OPENROUTER_API_KEY`.

```
            @ghostmind-dev/agent   (engine: loop, model + Jev, guide, budget, hooks, events)
             /                    |                        \
   a node in ensemble      the `agento` command     imported by an app (Potion, later)
```

**One core, three ways in.** The same engine runs inside an ensemble `work` node, behind a terminal REPL, or imported into an app. Each keeps its own tools, prompts and approvals.

**Share the engine, not the agent.** What makes an agent *yours* is its tools, prompts, memory and approvals, and each app keeps those. What every app needs, and what is hard to get right, is the loop: the guards that stop a model looping, stalling, inventing tool calls or overspending. That lives here once.

## Quick start

```ts
import { openrouter, runAgent, type AgentTool } from '@ghostmind-dev/agent';

const weather: AgentTool = {
  name: 'get_weather',
  description: 'The forecast for a city today.',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  run: async ({ city }) => ({ city, forecast: 'rain, 12°C' }),
};

const result = await runAgent({
  provider: openrouter({ model: '<an OpenRouter model id>' }),
  task: { goal: 'Will it rain in Montreal?', expectation: 'One sentence.' },
  toolsets: [{ name: 'weather', description: 'Forecasts.', tools: [weather] }],
  budget: { maxUsd: 0.05 },
});
// result: { status, reason, answer, steps, toolCalls, cost, messages }
```

`npm run example` runs [`examples/two-tools.mts`](examples/two-tools.mts): a read tool, a write tool that asks for approval, and the event log. By default it uses a scripted model and spends $0. Add `-- --live <model-id>` for a real run.

## The loop

Ported from a production agent's loop, where each guard answers a failure its evaluation found:

| Guard | What it prevents |
|---|---|
| Every tool offered at every step | A router that offered only some tools made the model say "I have no tool for that" |
| Step cap; the last step answers with tools visible but not callable (`toolChoice: 'none'`) | Running forever; removing the tools instead makes models write tool markup as text |
| Tool-call cap | Endless lookups |
| USD cap (`budget.maxUsd`) | Overspending. Ends with status `limit` and a reason naming the figure |
| A transient reminder at the end of the context | Weak models losing the thread (sent once, never kept) |
| Leaked tool-call markup read back into real calls | Models that write their calls as text (DSML, `<invoke>`, GLM `arg_key`) |
| Empty reply sent back twice, then reported | Blank answers |
| Identical reads run once (sorted-key JSON) | Doom loops |
| A "you may have enough" note every few reads | Over-searching |
| Long results capped | Context blow-up |
| Guide reads (skills) spend no tool call and give the step back | Preparation eating the budget |
| A declined change ends the run on the person's move | Retrying what the person refused |

Statuses: `done`, `needs_person`, `unfinished`, `limit`, `stopped`, `paused`, `greeted`, `chatted`, with `reason` saying why whenever it isn't obvious.

## Jev: the decider and the guide

Two models, two jobs. The **worker** writes, plans and calls tools. **Jev** (TypeSafe's System One model, reached through OpenRouter's `/systemone`) never writes. It answers typed questions with calibrated probabilities (yes/no, one of N, a score), in well under a second, for about $0.00002. Probabilities, not prose, so the worker can't talk it into agreeing.

Because it is that cheap, the loop asks Jev wherever a step is a judgement rather than a generation:

- **Opening:** is there a task at all? A greeting gets the app's welcome and a thank-you gets one short reply, neither paying for the loop.
- **Skills:** which guides, if any, the task needs. One choice question covers every skill.
- **`ask_jev`:** offered to the worker at every step, for "which existing option fits", "is this a duplicate", "how relevant".
- **The guide:** checkpoints the harness asks itself, so a weaker model gets through uncertainty. The model doesn't have to think of asking.

### The guide

| Checkpoint | Question (atomic; the state is the task and the latest step only) | Low probability → |
|---|---|---|
| `after_tool` | Does this result move toward the request? | A steer rides with the next call |
| `before_write` | Is this change something the request asks for? | Held back **once**, with the doubt; made again, it goes on to approval |
| `before_answer` | Does this answer respond to the request? | Sent back (a nudge) |
| `hesitation` (empty reply, repeated call, leaked markup) | Which next step helps most? (choice over the tools + "answer now") | A steer naming the step |

The guide **steers; it does not overrule.** Every question avoids Jev's documented weaknesses: counting, numbers, dates, long context and multi-hop reasoning. The verdict node this engine's source loop dropped judged a whole transcript and asked whether "every fact and number" was supported. That combination is Jev's weak spot, and the probable reason the node was dropped.

**Guidance follows the model.** `guidance: 'auto'` is the default:

1. **Start** from what the provider knows of the model (`provider.card()`, which reads OpenRouter's live catalogue: price, context size, tool support). Expensive models start `light`; cheap or small ones start `close`.
2. **Adapt** within the run. Repeated low probabilities tighten the level; a streak of confident passes loosens it. Every change is a `guidance` event.
3. **Learn** across runs: a per-model profile (`guide.profiles`, e.g. `memoryProfiles()` or `fileProfiles(path)`) records how often Jev corrected the model and whether corrected runs still succeeded. After three runs, the profile sets the next run's starting level.

Levels: `off` · `light` (before writes and answers) · `normal` (+ every 3rd tool result, hesitation) · `close` (every tool result). A named level is fixed. A number `N` checks after every Nth result. Every checkpoint is a `checkpoint` event (question, probability, action, level), and its cost counts toward the budget. None run past the USD cap.

`npm run bench` compares guidance `off` against `close` on the same scenarios. The default dry run proves the wiring for $0. `node bench/guidance.mts --live <model-id> --runs N` is the real measure, and it spends money.

App-owned variants of the same idea: `jevStopCheck(provider, checks)` and `jevToolGate(provider, options)` put Jev behind the hooks.

## Hooks

```ts
hooks: {
  beforeStep(ctx)    // go · pause (→ 'paused') · stop (→ 'stopped')
  toolGate(ctx)      // go · { verdict: 'go', args } · { verdict: 'go', result } · pause · stop
  rewriteOutput(ctx) // the text the model sees instead (redact, trim, annotate)
  stopCheck(ctx)     // nothing/stop = accept · { verdict: 'go', reason } = back to work · pause = needs_person
}
```

The same `go | pause | stop` vocabulary as ensemble's `guard(step)`, so one supervisor speaks both. `combineHooks(...)` stacks several (the first objection wins; rewrites chain). A paused run resumes by running again with `result.messages` as `history`: every tool call in it has a result.

## Events

`onEvent` streams events; `log: eventLog()` keeps them. The rule: **if the model saw it, it is logged.** Every message added to the model's context (the system prompt, the task, each tool result as the model received it, and the transient reminders and steers that never stay in `messages`) is a `context` event. Entries are numbered, timestamped, deep-copied and frozen. `toJSONL()` and `since(seq)` are for tailing; `onAppend` writes them anywhere.

## The seams: what an app provides

| Seam | What it is |
|---|---|
| `provider: ModelProvider` | `chat` (the worker), optional `decide` (Jev), optional `card` (what's known of a model). `openrouter()` in an app, `scriptedModel()` in a test |
| `toolsets`, `alwaysTools` | `AgentTool`s. A tool that changes something has `write.describe(args)`, the sentence the person approves. `foldTools()` folds many actions into one `{ action, args }` tool. `mcpToolset(session)` turns an MCP session (ensemble's `connect()` shape) into tools |
| `prompts: Partial<PromptPack>` | Every word the engine says: system rules, reminder, answer-now, nudges, opening paths |
| `memory: MemoryStore` | `recall()` facts into the system prompt (remembering is the app's own tool) |
| `session: { store: SessionStore, id }` or `history` | Earlier turns |
| `approve(request)` | Asks the person. Without it, every change is refused |
| `skills: SkillSource` | `inlineSkills([...])` or `dirSkills(dir)` (Agent Skills format). Jev picks; `use_skill` and `read_skill_file` load |
| `postProcessors` | Transform the final answer (an app's own link repair, redaction) |
| `subagentTool(spec)` | A whole agent as one tool: isolated transcript, cost rolled up into the parent's cap |

## The boundary rule

`src/` never names an app: no app database, no app link format, no app wording in prompts. If a line of the engine would only make sense for one app, it belongs behind a seam. `test/boundary.test.mts` enforces it, along with zero runtime dependencies and no hardcoded model ids. Jev's `jev-latest` alias is the one default.

## The `agento` command

The package ships a terminal chat on the core, in the spirit of opencode. Use it to try the engine, or as a small agent in any folder:

```bash
export OPENROUTER_API_KEY=sk-or-...
npm install -g @ghostmind-dev/agent     # the command is `agento` (or: npx @ghostmind-dev/agent …)
agento model                            # pick from agento's short list (↑↓, type to filter), saved as the default
agento                                  # chat in the current folder
agento -p "what does this repo do?"     # one turn, then exit
agento models                           # the short list with live prices (--all [filter] for every model)
```

**What the agent can do:**
- **Files:** read, list and search freely. Writing or editing a file asks first. It can't reach outside the folder it started in.
- **Shell:** every command asks first.
- **MCP servers:** from `.mcp.json` (Claude Code's format). This needs `@ghostmind-dev/ensemble` installed alongside, an *optional* peer dependency, so the package keeps zero runtime dependencies.
- **Skills:** from `.claude/skills`. Jev picks which one a task needs.

Answers render as markdown in the terminal, including box-drawn tables fitted to the width. Output has three styles: `minimal`, `normal` and `verbose` (`--style`, or `/style` to save one). Only `verbose` shows Jev's scoring and per-turn costs. Each session is logged to `~/.agento/sessions/`. The engine names no model. agento, as an app, offers a short curated list of 16 models with tools and reasoning, each proven in an agent loop (the list Potion's Talk offers), in `src/cli/models.ts`. "Other model…" searches the whole catalogue. `agento model` saves your pick in `~/.agento/config.json`, `--model` overrides it for one run, and `AGENT_MODEL` forces one. `agento --help` lists the options. In this repo, `cli/scripts/agento.sh` runs it from source with the key from Vault (see [`cli/Readme.md`](cli/Readme.md)).

## Development

```
npm test            # all suites, offline, $0 (builds first)
npm run typecheck
npm run example     # the two-tool agent, scripted
npm run bench       # guidance off vs close, dry run
```
