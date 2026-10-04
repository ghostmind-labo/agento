# CLAUDE.md

`@ghostmind-dev/agento` is the **engine** every app builds its own agent from: the tool loop and its guards, a model seam (a worker through OpenRouter, **Jev** for decisions), the Jev **guide** (checkpoints sized to the model), budgets with a USD cap, `go | pause | stop` hooks, and an append-only event log. It is a library, not a service: no server, no HTTP, no UI. TypeScript ESM on Node ≥ 22.18, **zero runtime dependencies**, one credential: `OPENROUTER_API_KEY`.

## Engine vs app

The engine is shared; the agent is not. An app's tools, prompts, memory, sessions, approvals, skills and answer post-processing are **injected through seams** (`src/seams.ts`, `ModelProvider`, `Toolset`). The engine holds only what every app needs and gets wrong alone: the loop.

## The boundary rule

`src/` never names an app: no app database, no app link format, no app wording in prompts or code. The name of a production agent a lesson came from may appear in a *comment* explaining why; nowhere else. If a line only makes sense for one app, it goes behind a seam. `test/boundary.test.mts` enforces this, along with zero runtime dependencies and no hardcoded model ids. The one default is Jev's `jev-latest` alias, the same default ensemble uses. When a price or capability matters, read OpenRouter's live catalogue (`modelCatalog`, `provider.card`).

## Conventions shared with ensemble

Keep these identical so the two packages can converge:

- `OPENROUTER_API_KEY` only.
- Jev is reached through OpenRouter's `/systemone`. Never ask for a `TYPESAFE_API_KEY`.
- No vendor SDKs.
- Offline tests.
- Hooks speak ensemble's `guard(step)` vocabulary: `go | pause | stop`.
- The agent is the WORKER: the model decides its next step. Ensemble is the STRUCTURE and SUPERVISOR: the author decides the route.

## Project map

Every `src/*.ts` opens with a doc comment saying *why* it exists. Match that when adding one.

- `src/loop.ts`: `runAgent` and its guards, `passNode` (a Jev decision node), leaked-call recovery, `subagentTool`
- `src/guide.ts`: Jev as the guide. Checkpoints (after_tool, before_write, before_answer, hesitation), thresholds, guidance levels, starting level from `card()`, in-run adaptation, per-model profiles
- `src/model.ts`: the `ModelProvider` seam, `openrouter()` (chat, streaming, `decide`, `card`), `modelCatalog`, `ModelError` codes
- `src/tools.ts`: `AgentTool` / `Toolset`, `foldTools`, forgiving argument readers, `mcpToolset`
- `src/hooks.ts`: `beforeStep` / `toolGate` / `rewriteOutput` / `stopCheck`, `combineHooks`
- `src/jev.ts`: Jev behind app-owned hooks (`jevStopCheck`, `jevToolGate`), `ask`
- `src/consult.ts`: `ask_jev` (offered at every step by default) and `ask_model`
- `src/skills.ts`: skill sources (inline, on disk), Jev's pick, `use_skill` / `read_skill_file`
- `src/budget.ts`: limits and the USD cap
- `src/events.ts`: `AgentEvent`, `eventLog()`
- `src/seams.ts`: `AgentTask`, `AgentResult`, `PromptPack` and its generic defaults, memory, sessions, approve, post-processors
- `src/testing.ts`: `scriptedModel`, a stub provider that apps can use too
- `examples/two-tools.mts`: the smallest real agent. `bench/guidance.mts`: guidance off vs close
- `src/toolkit/`: the standard tools, exported as `standardToolsets({ root, shell, web })`: `files.ts` (list_dir, read_file, glob, search with a pure-Node fallback when ripgrep is missing, write_file, edit_file), `shell.ts` (run_command), `web.ts` (web_search through a swappable `SearchBackend`, default Exa's hosted MCP with no key; web_fetch with a hand-written HTML→Markdown converter, hop-by-hop redirect checks and a private-address refusal). Reads run freely; changes carry `write` so the loop asks. Keep it dependency-free and keep tool output as DATA. The gym uses only files and shell: its challenges must stay hermetic.
- `src/cli/mcp-server.ts` + `unattended.ts`: `agento mcp`, one tool `run_task` (argument `prompt`, result text plus `structuredContent` with status/steps/toolCalls/cost). An unattended run has nobody to ask, so `unattended()` decides at build time what the model is OFFERED (no changes by default; `--yes`; `--allow-shell`), rather than offering everything and refusing, because a refused change ends a turn as "declined".
- Hosted use (a host supplying only `OPENROUTER_API_KEY` and `OPENROUTER_BASE_URL`): nothing may need a login, a saved default, a second vendor's key or a writable home. `test/cli-acp.test.mts` case 13 runs the real process against a fake OpenRouter with a clean HOME and checks every call carried only the host's token. Keep it passing.
- `src/cli/acp.ts`: `agento acp`, the Agent Client Protocol over stdio, hand-written (no SDK: the package keeps zero runtime dependencies). stdout carries only protocol messages, so nothing else may print there. `autoApprove` / `allowShell` are the unattended modes; `simpleCommand` decides what counts as a command that does one thing. Check conformance with `npm run tck` (the protocol's acp-tck kit on `test/fixtures/acp-stub-agent.mts`, a stand-in model); the fixture must stay slow enough for the kit's cancel tests to run. Adding a protocol feature means advertising it in `initialize` and running the kit again.
- `src/cli/gym/`: `agento train`. `challenges.ts` holds seeded generators with graders in code and levels 1–5. `strategy.ts` is what is tuned per model (rules, guidance, limits, level), saved in `~/.agento/strategies/`. `train.ts` is the ratchet: champion vs one candidate on the same set, with a one-challenge win confirmed on a second set; the cheap model writes rules from its own failures. Keep every grade in code, never a model's opinion, and keep a run capped in dollars. An attempt that ends in a model-call error (no network, an outage) is **void**, never a score of 0: a round with any void attempt changes nothing (level, score, rules), and two in a row stop the run. The daily job waits up to 2 minutes for OpenRouter before measuring anything, and skips cleanly if it never comes.
- `src/cli/`: the `agento` command (the package's `bin`; the package is `@ghostmind-dev/agento`, and its library exports are the engine): an opencode-style REPL on the public API, with files, shell, MCP and skills. MCP loads `@ghostmind-dev/ensemble` with a dynamic `import()` only when a server is configured. Ensemble is an **optional peer**, never a dependency, and the boundary test fails on a static import of it. The engine names no model. agento's curated list (16 models with tools + reasoning, mirroring Potion's) lives only in `src/cli/models.ts`, the one file the boundary test lets name ids, and the engine may not import it. The person picks one with `agento model`, a scrollable list in `src/cli/picker.ts`, (saved in `~/.agento/config.json`, or `$AGENTO_HOME`). Precedence: `--model`, then `AGENT_MODEL`, then the saved default. `cli/` holds only the repo's way to run it: `.env.schema` (varlock, key from Vault), `meta.json` routines, and `scripts/agento.sh` running `src/cli/main.ts` from source. A live `agento -p` spends real credits, the same rule as `--live`

<important if="you are changing the guide, a checkpoint question, or anything sent to Jev">

Respect Jev's documented jaggedness (https://docs.typesafe.ai/model-jaggedness/jev-1.13; check for a newer page): it is bad at counting, numbers, dates, multi-hop reasoning and long context. So every question is **atomic**, the state is **the task and the latest step only** (never the transcript), and nothing asks it to count or compare figures. `test/guide.test.mts` case 13 asserts this.

The guide **steers, it does not overrule**: a held-back write goes through if the model repeats it, and approval still applies. That is deliberate. The production loop this was ported from dropped its whole-transcript verdict node ("Pi: the model decides; no second judge"). Don't reintroduce a judge that can block the worker outright.

A checkpoint that gets no answer is never read as a verdict. Checkpoints stop once the USD cap is reached, and every one is logged with its cost.
</important>

<important if="you are running commands to build, test, or typecheck">

| Command | What it does |
|---|---|
| `npm test` | All suites (builds first), offline, $0 |
| `node test/run.mts <substring>` | Matching suites only, no rebuild |
| `node test/<name>.test.mts` | One suite directly |
| `npm run typecheck` | `tsc --noEmit` over `src/` |
| `npm run example` / `npm run bench` | Dry runs: scripted model and scripted Jev |

`npx tsc` may resolve the wrong binary; use `./node_modules/.bin/tsc`.
</important>

<important if="you are about to run anything live (--live, a real key)">

Live runs spend the user's OpenRouter credits. Never launch `--live` (the example or the benchmark) unless the user asked for it, and always keep a `budget.maxUsd`.
</important>

<important if="you are writing or modifying a test">

- Suites are spawned as separate **processes** by `test/run.mts`. Never import one suite from another.
- Every suite stays offline: `scriptedModel(...)` for the model (its `decide` option scripts Jev, its `card` option sizes the model for the guide), or a mocked `fetch` passed to `openrouter({ fetch })`.
- A new `test/*.test.mts` is picked up automatically.
- Assertions use `node:assert/strict`. Print `ok · N …` per numbered case, and a final `N cases` line.
</important>

<important if="you are changing the event types or the result shape">

Apps and supervisors read `AgentEvent`, `AgentResult` and the log's JSONL, so their field names are a contract. Keep "if the model saw it, it is logged": every message pushed to the model's context, transient ones included, must emit a `context` event (`test/events.test.mts` case 2 checks it request by request).
</important>
