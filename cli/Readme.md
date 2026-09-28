# agent CLI

How to run the `agent` command **from this repo**. The command itself lives in `src/cli/` and ships in the npm package (`npx @ghostmind-dev/agent`). This folder only adds the local setup: the key from Vault through varlock, and running from source, so an engine change is testable the moment it's saved, with no build and no publish.

```bash
alias agent=/Volumes/Projects/labo/agent/cli/scripts/agent.sh   # once, in your shell profile
agent                                   # chat in the current directory
agent -p "what does this repo do?"      # one turn, then exit (exit 1 unless done)
agent -m <model> -g close --max-usd 0.2 --yes --verbose
```

Or `run routine dev` in `cli/` to chat in the repo root.

**What the agent can do:**
- **Files:** `list_dir`, `read_file` and `search` (ripgrep) run freely. `write_file` and `edit_file` ask you first. Everything is confined to the working directory.
- **Shell:** `run_command`. Every command asks you first. Output is capped, and a command is killed at its timeout.
- **MCP servers:** read from `.mcp.json` in the directory (Claude Code's format), then `~/.agent-cli/mcp.json`. They connect through `@ghostmind-dev/ensemble` as a third-party library, so OAuth servers like Potion open a browser to log in the first time. Tools whose names look like changes (`create_`, `update_`, `delete_`…) ask you first.
- **Skills:** `.claude/skills` in the directory and in `~`. Jev picks which one a task needs.

**What you see:** streamed answers, every tool call and result, every Jev checkpoint (`· Jev after_tool p=0.85 → pass [close]`), guidance level changes, nudges, and a status line per turn with its steps and cost.

**Approvals:** `y` allows once, `n` declines, `a` allows that tool for the rest of the session. `/auto` or `--yes` skips all approvals.

**Commands:** `/model [id]`, `/models [filter]` (tool-capable models, cheapest first, from the live catalogue), `/guidance [level]`, `/budget [usd]`, `/cost`, `/tools`, `/mcp`, `/skills`, `/auto`, `/log`, `/clear`, `/exit`. Ctrl+C stops a turn.

**What it keeps:**
- Every event of a session goes to `~/.agent-cli/sessions/<time>.jsonl`.
- Per-model guide profiles go to `~/.agent-cli/profiles.json`, so the guide learns which models need more help.

**Config:** `.env.schema` through varlock. `OPENROUTER_API_KEY` comes from `ghostmind/global/openrouter`. `AGENT_MODEL` and `AGENT_MAX_USD` are defaults.

**Tests:** `run routine test` runs the `cli-*` suites (offline, $0). They sit with the package's tests in `test/`.
