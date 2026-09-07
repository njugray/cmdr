# cmdr plugin

Connect local Claude Code, Codex, ZCode and other MCP-capable sessions as a squad. Requires macOS/Linux and Node.js ≥22.5 (24 recommended); npm distribution packages include all runtime dependencies. A source checkout requires `npm ci && npm run build` at the repository root before installation; generated `dist` files are not tracked by Git.

In each session enter `/cmdr my-project`. The first becomes commander; others join as executors. Without slash commands, ask the Agent to call `join(squad_name="my-project")`.

Tools: `join`, `list`, `send`, `report`, `ask`, `read`, `leave`. Executors report ready with capabilities/cwd, then read tasks, report results and ask when blocked. Commanders dispatch verifiable tasks and answer questions with `reply_to`. Use each result's `me.recommended_wait` for long polling; the skills limit standby to 40 rounds.

Install a built checkout or the unpacked/installed npm package root as a marketplace in Claude Code/Codex, or use ZCode Settings → Plugins → Create → Add plugin marketplace. Codex needs hooks enabled and five hook approvals; start a new session after installation. ZCode uses its native manifest and four supported hooks; MCP EOF handles offline state. Generic hosts can configure the absolute `bin/cmdr-mcp` executable and `CMDR_AGENT=<host>` with optional `CMDR_SESSION_ID=<unique native session>`.

`bin/cmdr config --agent zcode` prints native ZCode configuration; `bin/cmdr config --agent my-agent` prints generic MCP configuration. `bin/cmdr doctor` checks installation health. `bin/cmdr daemon restart` reloads same-version code changes. State lives in `~/.cmdr/` (override `CMDR_HOME`), shared by all sessions.

No active wakeups, Agent launching, remote transport or execution of message contents. Read marks delivery; use history if a host loses a previously delivered result. Idle recipients may need the user to say “continue”.

[Installation and usage](https://github.com/njugray/cmdr#readme) · [Host integration](https://github.com/njugray/cmdr/blob/main/docs/agent-integration.md) · [Verification scope](https://github.com/njugray/cmdr/blob/main/docs/implementation.md)
