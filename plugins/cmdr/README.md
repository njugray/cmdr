# cmdr plugin

Connect local Claude Code, Codex, ZCode and other MCP-capable sessions as a squad. Requires macOS/Linux and Node.js ≥22.5 (24 recommended); npm distribution packages include all runtime dependencies. A source checkout requires `npm ci && npm run build` at the repository root before installation; generated `dist` files are not tracked by Git.

For installation through `cmdr setup` or `npx skills`, see [standalone setup](https://github.com/njugray/cmdr/blob/main/docs/setup.md). Use one installation method per host to avoid duplicate tools and hooks.

In each session enter `/cmdr my-project`. Joining defaults to executor, even for a new channel. Explicitly use role="commander" to claim command; no commander is required to retain a channel. Without slash commands, ask the Agent to call `join(squad_name="my-project")`.

Tools: `join`, `list`, `send`, `report`, `ask`, `read`, `leave`. Executors report ready with capabilities/cwd, then read tasks, report results and ask when blocked. Commanders dispatch verifiable tasks and answer questions with `reply_to`. Acknowledge each command with working + reply_to before executing it. Use read(recover=true) to find unfinished commands after interruptions. Offline never means stopped. Use join(standby="auto") and check listener health; with a healthy listener, end the idle turn. Manual fallback is limited to two recommended waits.

Install a built checkout or the unpacked/installed npm package root as a marketplace in Claude Code/Codex, or use ZCode Settings → Plugins → Create → Add plugin marketplace. Codex needs hooks enabled and five hook approvals; start a new session after installation. For ZCode, use the published `njugray/cmdr#marketplace` source to install without a local build or global npm package. ZCode uses its native manifest and four supported hooks; MCP EOF handles offline state. Generic hosts can configure the absolute `bin/cmdr-mcp` executable and `CMDR_AGENT=<host>` with optional `CMDR_SESSION_ID=<unique native session>`.

`bin/cmdr config --agent zcode` prints native ZCode configuration; `bin/cmdr config --agent my-agent` prints generic MCP configuration. `bin/cmdr doctor` checks installation health. `bin/cmdr daemon restart` reloads same-version code changes. State lives in `~/.cmdr/` (override `CMDR_HOME`), shared by all sessions.

The daemon can wake existing Codex sessions through the shared public app-server transport; other hosts explicitly remain manual. It never creates agents or provides remote transport. Read marks delivery; report(working/done/failed/cancelled, reply_to) tracks work separately. cmdr standby manages listeners, and tail --after/--for supports non-consuming event replay. See [long-running collaboration](https://github.com/njugray/cmdr/blob/main/docs/long-running-collaboration.md).

[Installation and usage](https://github.com/njugray/cmdr#readme) · [Host integration](https://github.com/njugray/cmdr/blob/main/docs/agent-integration.md) · [Verification scope](https://github.com/njugray/cmdr/blob/main/docs/implementation.md)

The npm package is `cmdr-mcp`. Use `cmdr doctor --plugin-root <actual cache directory> --deep` to verify a cached installation. Static integrity checks run without the target CLI bundle; deep probes use temporary state. `cmdr session` provides all seven member operations with explicit host/native identity when MCP tools are unavailable. See [troubleshooting](https://github.com/njugray/cmdr/blob/main/docs/troubleshooting.md) for cancellation, identity and hook diagnostics.
