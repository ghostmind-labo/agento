# @ghostmind-dev/agento

The engine every app builds its own agent from. The loop, and everything it needs to run safely:

- a worker model that calls tools, through OpenRouter;
- **Jev**, a calibrated decision model, guiding the worker at checkpoints;
- budgets, including a USD cap;
- `go` / `pause` / `stop` hooks;
- an append-only event log.

It is a **library**: import it, give it tools, run it. No server, no service, no connection to call. Zero runtime dependencies, Node ≥ 22.18, one credential: `OPENROUTER_API_KEY`.

```
            @ghostmind-dev/agento   (engine: loop, model + Jev, guide, budget, hooks, events)
             /                    |                        \
   a node in ensemble      the `agento` command     imported by an app (Potion, later)
```

**One core, three ways in.** The same engine runs inside an ensemble `work` node, behind a terminal REPL, or imported into an app. Each keeps its own tools, prompts and approvals.

**Share the engine, not the agent.** What makes an agent *yours* is its tools, prompts, memory and approvals, and each app keeps those. What every app needs, and what is hard to get right, is the loop: the guards that stop a model looping, stalling, inventing tool calls or overspending. That lives here once.

## Quick start

```ts
import { openrouter, runAgent, type AgentTool } from '@ghostmind-dev/agento';

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

## Standard tools

The engine ships no tools of its own: what an agent may do is the app's decision. But files, a shell and the web are what nearly every agent needs, and each is easy to get subtly wrong, so they are written once, tested, and offered in one call:

```ts
import { standardToolsets } from '@ghostmind-dev/agento';

runAgent({ provider, task, toolsets: standardToolsets({ root: '/path/to/project' }) });
```

| Tool | What it does | Asks first? |
|---|---|---|
| `list_dir`, `read_file` | Look around and read files, with line numbers and paging | No |
| `glob` | Find files by name pattern (`**/*.test.ts`, `src/**/*.{ts,tsx}`) | No |
| `search` | Regular-expression search of file contents. Uses ripgrep if installed, a built-in search if not | No |
| `write_file`, `edit_file` | Create or overwrite a file; replace an exact passage | **Yes** |
| `run_command` | One bash command, in the folder, with a timeout and capped output | **Yes** |
| `web_search` | Find pages: title, URL and the relevant passages | No |
| `web_fetch` | Read one URL as Markdown (HTML is converted; JSON and text pass through; long pages come back in pieces) | No |

- **Confined:** every path is resolved inside `root`; `../../.ssh` is refused.
- **Web only:** `standardToolsets({ files: false, shell: false })` gives an agent just the web tools, with no folder and no `root` (what a hosted service wants). `webToolset()` is the same thing on its own.
- **Approvals:** changes carry a `write` account, so the loop asks your `approve` first, or refuses when the app gave none, which is how a read-only agent is made. `shell: false` and `web: false` leave a kind out.
- **Web search** uses Exa's hosted endpoint, the way opencode does: no key, no SDK (`EXA_API_KEY` raises its rate limits). Pass `webOptions: { search }` to use Brave, Tavily or anything else.
- **Web fetch** follows redirects by hand and checks every hop. It refuses `localhost`, private networks, cloud-metadata addresses, any single-label name (`http://api/`, `http://db:5432`, which can only be an internal service) and any name that *resolves* to a private address, unless you pass `webOptions: { allowPrivate: true }`. One gap remains: a name that changes its DNS answer between the check and the connection is not caught, so when this runs for people you do not trust, also deny the private ranges at the firewall (a Kubernetes egress policy, for one). A page can still say anything, so the engine's rules treat all tool output as data, and the agent is told to name the URLs its answer rests on.
- **The model list** agento offers is a public subpath: `import { CURATED, labelOf, offered, STARTER } from '@ghostmind-dev/agento/models'`. The engine itself still names no model.

## The `agento` command

The package ships a terminal chat on the core, in the spirit of opencode. Use it to try the engine, or as a small agent in any folder:

```bash
export OPENROUTER_API_KEY=sk-or-...
npm install -g @ghostmind-dev/agento     # the command is `agento` (or: npx @ghostmind-dev/agento …)
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

Answers render as markdown in the terminal, including box-drawn tables fitted to the width. `agento train` trains the harness around a cheap model: fresh challenges each round, graded in code, and a change kept only if it clearly scores better. It rises through 5 difficulty levels, and agento uses what it learned. Output has three styles: `minimal`, `normal` and `verbose` (`--style`, or `/style` to save one). Only `verbose` shows Jev's scoring and per-turn costs. Each session is logged to `~/.agento/sessions/`. The engine names no model. agento, as an app, offers a short curated list of 16 models with tools and reasoning, each proven in an agent loop (the list Potion's Talk offers), in `src/cli/models.ts`. "Other model…" searches the whole catalogue. `agento model` saves your pick in `~/.agento/config.json`, `--model` overrides it for one run, and `AGENT_MODEL` forces one. `agento --help` lists the options. In this repo, `cli/scripts/agento.sh` runs it from source with the key from Vault (see [`cli/Readme.md`](cli/Readme.md)).

## Use agento from an editor or a chat (ACP)

`agento acp` runs agento as an **ACP agent**: the Agent Client Protocol, an open standard (created by Zed, adopted by JetBrains and others) that lets a host launch any agent over stdio, the way editors launch language servers. Any ACP host can then use agento, with its tools, approvals, Jev guide and your choice of model.

```bash
npm install -g @ghostmind-dev/agento
```

| Host | Configuration |
|---|---|
| **Zed** (`settings.json`) | `"agent_servers": { "agento": { "type": "custom", "command": "agento", "args": ["acp"], "env": { "OPENROUTER_API_KEY": "sk-or-…" } } }`, then pick agento in the Agent Panel |
| **JetBrains** (`~/.jetbrains/acp.json`, or AI Chat → Add Custom Agent) | `"agent_servers": { "agento": { "command": "agento", "args": ["acp"], "env": { "OPENROUTER_API_KEY": "sk-or-…" } } }` |
| **Buzz** (Block's agent chat), custom harness file `~/Library/Application Support/xyz.block.buzz.app/custom_harnesses/agento.json` | `{ "id": "agento", "label": "agento", "command": "agento", "args": ["acp", "--allow-shell", "buzz-cli"], "env": { "OPENROUTER_API_KEY": "sk-or-…" } }`, or `BUZZ_ACP_AGENT_COMMAND=agento` with `BUZZ_ACP_AGENT_ARGS=acp,--allow-shell,buzz-cli` |

- **The model:** the agent brings its own. The host shows a model selector (an ACP config option) with agento's curated list. Without a pick it uses your saved default (`agento model`), `AGENT_MODEL`, or a cheap starter.
- **Approvals:** changes and shell commands go to the host as permission requests, so you click Allow in your editor.
- **Unattended** (an agent nobody watches, like one answering in a Buzz channel): `--yes` approves everything, or `--allow-shell <word>` approves only simple commands starting with that word. "Simple" means no `;`, `&`, `|`, redirects, `$`, backticks, parentheses or globs outside single quotes. Everything else still asks.
- **MCP servers** the host passes are used. Remote ones need `@ghostmind-dev/ensemble` installed alongside (an optional peer).
- **Cost:** each turn ends with a `usage_update` carrying the cost in USD, so a host with a budget (an ensemble graph, for one) can count it.
- **Not yet:** the host's own file and terminal methods, `session/load`, images and audio.

### As an MCP tool

`agento mcp` serves the agent as an MCP server on stdio with one tool, `run_task`: give it a `prompt` (and optionally `cwd`, `model`, `max_usd`) and it works on its own and returns its answer. The status, steps, tool calls and cost (USD) are in `structuredContent`, since MCP has no field for what a call cost. Any MCP client can call it: Claude Code, opencode, or ensemble:

```ts
mcpServers: { agento: { command: "agento", args: ["mcp"], timeoutMs: 300_000 } },
agents: { helper: { protocol: "mcp", server: "agento", tool: "run_task" } },
```

Nobody is there to approve anything, so it is **read-only by default**: `write_file`, `edit_file` and `run_command` are not even offered. `--yes` offers everything and asks nothing; `--allow-shell <word>` offers `run_command` for simple commands starting with that word, and any other command comes back as an ordinary tool error (the task goes on). An unfinished task (a limit hit) is returned as an error, so a graph step fails instead of passing half an answer.

### As an A2A agent

`agento a2a` serves the agent over the **Agent2Agent protocol** (A2A, version 1.0), so another agent or an agent platform can discover it and hand it a task over HTTP. Where an MCP call is one question and one answer, an A2A task has a life: the caller can poll it, stream it, cancel it, and answer when the agent asks back.

```bash
agento a2a --port 41241          # http://127.0.0.1:41241, card at /.well-known/agent-card.json

curl -s http://127.0.0.1:41241/ -H 'Content-Type: application/json' -H 'A2A-Version: 1.0' -d '{
  "jsonrpc": "2.0", "id": 1, "method": "SendMessage",
  "params": { "message": { "role": "ROLE_USER", "messageId": "m1", "parts": [{ "text": "What is in this folder?" }] } }
}'
```

- **Two bindings** on the same tasks: JSON-RPC at `POST /`, and HTTP+JSON as REST paths (`POST /message:send`, `GET /tasks/{id}`, …). Streaming is Server-Sent Events on both.
- **The answer** is a text artifact on a `TASK_STATE_COMPLETED` task; the status, steps, tool calls and cost (USD) are in the task's `metadata.agento`. A run that hit a limit is `TASK_STATE_FAILED`, with the reason.
- **One `contextId` is one conversation**: a second task in the same context sees the first.
- **Read-only by default**, like `agento mcp`: `--yes` and `--allow-shell <word>` work the same way.
- **It listens on 127.0.0.1.** To expose it, pass `--host` (and `--public-url` behind a proxy or a tunnel) and set `A2A_TOKEN`: callers then send it as a Bearer token, and the card says so. It refuses to start on another address with `--yes` or `--allow-shell` and no token.
- **Not offered** (and the card says so): push notifications, the extended card, gRPC. A caller that sends no `A2A-Version` header is speaking 0.3 by the spec, and is refused with the version to send.

#### On serverless

Nothing in the protocol needs a port or an instance that lasts. `a2aHandler` (from `@ghostmind-dev/agento/a2a-handler`, which imports nothing from Node) is one function, a web `Request` in and a `Response` out, so it drops into any host with a fetch-style handler; `serveA2a` (from `@ghostmind-dev/agento/a2a`) is the same thing on a `node:http` port for a container.

```ts
import { a2aHandler } from "@ghostmind-dev/agento/a2a-handler";

const a2a = a2aHandler({ executor, store, token: env.A2A_TOKEN });
export default { fetch: (request, env, ctx) => a2a.fetch(request, ctx) };
```

| What serverless breaks | What handles it |
|---|---|
| The next request reaches another instance, or this one is gone | `store`: three calls (`get`, `put`, `list`) on any table, key-value store or folder. A task sent to one instance can be read, continued, watched and cancelled on another. `fileStore(dir)` is the folder version |
| The conversation lived in memory | `agentoExecutor({ history })`, with `fileHistory(dir)` as the folder version |
| The instance is frozen once the response is sent | the turn is handed to the host's `waitUntil` |
| Responses are buffered, so Server-Sent Events do not arrive | `streaming: false` takes streaming off the card |
| TLS ends at a proxy, so the request looks like plain `http` | the card follows `X-Forwarded-Proto` and `X-Forwarded-Host`, or `publicUrl` |
| No folder worth reading | `agentoExecutor({ files: false })`: the web tools only |

From the command line, for a container that scales to zero (Cloud Run and the like): `agento a2a --host 0.0.0.0 --store /mnt/a2a --no-files`, with `PORT` and `A2A_TOKEN` from the environment. Two limits to know: a task whose instance dies mid-turn stays "working" in the store, and a cancellation from another instance takes effect at the running turn's next write, not at once.

**Compliance** is checked with the protocol's own kit, [a2a-tck](https://github.com/a2aproject/a2a-tck), on a scripted agent (no key, no spend):

```bash
npm run tck:a2a   # needs uv and network the first time; about a minute
```

Last run: 72 of the kit's MUST requirements pass on both bindings, every SHOULD and MAY it tests passes, and one fails: CORE-SEND-003, where the kit expects a success for a media type the agent does not take and the specification requires `ContentTypeNotSupportedError`. The rest are skipped (features agento does not advertise) or have no test in the kit (TLS, signing).

### Launched by a host that supplies the key

The one credential is `OPENROUTER_API_KEY`, from the environment, and `OPENROUTER_BASE_URL` is honoured (a proxy that meters a run works). Every model call goes through that one endpoint: the worker, and the Jev decisions through `/systemone`. Nothing needs a login, a saved default or a writable home: with the key set, `agento acp` and `agento mcp` just start (no `authenticate` step is advertised), the model comes from `--model`, `AGENT_MODEL` or a cheap starter, and the session log is best-effort. Without the key they say so at once, naming it. The web tools reach Exa's endpoint directly (no key); `--no-web` leaves them out for a sandbox without outbound access.

**Compliance** is checked with the protocol's own kit, [acp-tck](https://github.com/agentclientprotocol/acp-tck), run on a stand-in model (no key, no spend):

```bash
npm run tck       # needs uv and network the first time; prints the verdict
```

Last run: `VERDICT: CONFORMANT` (37 passed, 0 failed; the skips are optional features agento does not advertise). It is experimental, and a pass is not an official guarantee.

## Development

```
npm test            # all suites, offline, $0 (builds first)
npm run typecheck
npm run example     # the two-tool agent, scripted
npm run bench       # guidance off vs close, dry run
```
