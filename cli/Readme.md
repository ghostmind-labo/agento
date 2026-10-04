# agent CLI

How to run the `agento` command **from this repo**. The command itself lives in `src/cli/` and ships in the npm package (`npx @ghostmind-dev/agento`). This folder only adds the local setup: the key from Vault through varlock, and running from source, so an engine change is testable the moment it's saved, with no build and no publish.

```bash
alias agento=/Volumes/Projects/labo/agent/cli/scripts/agento.sh   # once, in your shell profile
agento model                            # once: pick the default model from a list
agento                                  # chat in the current directory
agento -p "what does this repo do?"     # one turn, then exit (exit 1 unless done)
agento -m <model> -g close --max-usd 0.2 --yes --verbose
```

Or `run routine dev` in `cli/` to chat in the repo root.

**What the agent can do:**
- **Files:** `list_dir`, `read_file` and `search` (ripgrep) run freely. `write_file` and `edit_file` ask you first. Everything is confined to the working directory.
- **Shell:** `run_command`. Every command asks you first. Output is capped, and a command is killed at its timeout.
- **MCP servers:** read from `.mcp.json` in the directory (Claude Code's format), then `~/.agento/mcp.json`. They connect through `@ghostmind-dev/ensemble` as a third-party library, so OAuth servers like Potion open a browser to log in the first time. Tools whose names look like changes (`create_`, `update_`, `delete_`…) ask you first.
- **Skills:** `.claude/skills` in the directory and in `~`. Jev picks which one a task needs.

**What you see:** you choose an output style with `--style`, or `/style` in the chat, which saves it as your default:
- **`minimal`:** just the answers. Approvals and failures still show.
- **`normal`** (default): plus one short line per tool call, like `· read_file README.md`.
- **`verbose`** (`-v`): plus every tool result, Jev's scoring (`· Jev after_tool p=0.85 → pass [close]`), guidance level changes, nudges, and each turn's steps and cost.

Answers render as markdown, as they stream: box-drawn tables fitted to your terminal (cells wrap), headings, **bold**, `code`, lists, quotes and code blocks. `NO_COLOR` or piped output keeps the layout without the colours. Jev guides the agent in every style; only `verbose` shows its scores. `/cost` gives the session's spend anytime.

**In an editor or a chat:** `agento acp` runs this same agent over the Agent Client Protocol, so Zed, JetBrains and Buzz can use it (see the main Readme for each host's config). `npm run tck` checks it against the protocol's own compliance kit.

**Training (`agento train`):** the harness learns to get the most out of a cheap model. Each round:
1. **Fresh challenges,** generated from a seed and graded exactly in code: math, file tasks, joining two files, a prompt-injection trap, and a question whose answer isn't there.
2. **The current best setup** runs on them, **and one candidate:** a rule the model writes from its own failures, one setting moved one notch, or a learned rule removed.
3. **The candidate is kept only if it clearly wins:** two or more challenges better, one better confirmed on a second fresh set, or the same score for clearly less money.
4. **The level moves:** up after a near-perfect round, down after a poor one, so the challenges stay just beyond what the model can do. The 5 levels bring bigger math, spans across leap years, look-alike decoy codes, nested config and polite injections.

The winning setup is saved per model (`~/.agento/strategies/`), and agento uses it automatically: the banner shows `trained N%`, and `/strategy` shows what was learned. A session is 3 rounds of 6 challenges, capped at $0.05 (about a cent on Qwen 3.8 Flash). `agento train --report` shows the history.

**Daily:** `cli/scripts/install-daily.sh` (routine `install_daily`) runs `scripts/train.sh` at 07:30 every day through launchd. It uses your login shell for the Vault token, so no secret is written to the launchd file. The log is `~/.agento/gym/daily.log`. Remove it with `install-daily.sh --remove`.

**Approvals:** `y` allows once, `n` declines, `a` allows that tool for the rest of the session. `/auto` or `--yes` skips all approvals.

**Model:** `agento model` opens a scrollable list of agento's 16 curated models (tools + reasoning, the list Potion's Talk offers), each with its maker, a note and its live price. Use ↑/↓ and PgUp/PgDn to move, type to filter, Enter to choose, Esc to cancel. "Other model…" searches the whole catalogue, tools + reasoning only. The pick is saved as the default in `~/.agento/config.json`, so no flag is needed afterwards. `agento model <id>` sets it directly. In the chat, `/model` opens the same picker and `/default` saves the current one. `--model` overrides it for one run, and `AGENT_MODEL` forces one. It's empty in `.env.schema`, so the saved default applies.

**Commands:** `/model [id]`, `/default [id]`, `/models [filter]`, `/guidance [level]`, `/budget [usd]`, `/cost`, `/tools`, `/mcp`, `/skills`, `/auto`, `/log`, `/clear`, `/exit`. Ctrl+C stops a turn.

**What it keeps:**
- Every event of a session goes to `~/.agento/sessions/<time>.jsonl`.
- Per-model guide profiles go to `~/.agento/profiles.json`, so the guide learns which models need more help.

**Config:** `.env.schema` through varlock. `OPENROUTER_API_KEY` comes from `ghostmind/global/openrouter`. `AGENT_MAX_USD` is the per-turn cap. `AGENT_MODEL` is left empty so your saved default is used.

**Tests:** `run routine test` runs the `cli-*` suites (offline, $0). They sit with the package's tests in `test/`.
