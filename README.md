# cmdr

**Local squads for coding agents.** Connect existing Claude Code, Codex, ZCode and other MCP-capable Agent sessions. A commander dispatches tasks; executors report progress and ask questions. Messages persist in SQLite and arrive in priority order.

[中文说明](docs/README.zh-CN.md) · [Design specification](docs/cmdr-design-v1.md) · [Host integration](docs/agent-integration.md) · [Implementation and verification](docs/implementation.md)

## Quick start

Requires macOS or Linux and **Node.js ≥22.5** (24 recommended). Git contains source and plugin metadata; generated bundles are included only in npm distribution packages.

For a source checkout, build before registering the marketplace:

```sh
npm ci
npm run build
```

For distribution, `npm pack` (or `npm publish`) runs `prepack` to build the four entry points and include them, plugin assets and license notices in the package. The package has no external runtime dependencies:

```sh
npm pack
npm install --global ./cmdr-0.1.0.tgz
cmdr --help
```

Use the built checkout root, or the installed package root (`$(npm root -g)/cmdr`), as `/path/to/cmdr` below. A raw Git marketplace checkout without a build is not a runnable distribution. Registry publication is a separate release step; this PR does not publish a package.

**Claude Code**

```sh
claude plugin marketplace add /path/to/cmdr
claude plugin install cmdr@cmdr
```

**Codex**

```sh
codex plugin marketplace add /path/to/cmdr
codex plugin add cmdr@cmdr
```

Enable Codex hooks and trust the five cmdr hooks when prompted. Without hooks, the tools still work through long polling. Confirm `codex mcp list` includes cmdr and start a new session.

**ZCode desktop**

Open a workspace, then **Settings → Plugins → Create → Add plugin marketplace**. Choose this repository (or its root `marketplace.json`), install **cmdr**, and start a new session. The native `.zcode-plugin` manifest sets up MCP, commands and skills; ZCode discovers the four supported lifecycle hooks automatically. See [ZCode setup and verification](docs/agent-integration.md#zcode-desktop).

**Other Agents**

Use any MCP stdio client. Generate a configuration with an absolute executable path:

```sh
/path/to/cmdr/plugins/cmdr/bin/cmdr config --agent my-agent
```

Merge the printed `mcpServers` entry into your host configuration. No proprietary plugin or hook API is required. The [integration guide](docs/agent-integration.md#other-mcp-hosts) covers identity, timeouts, multiplexed sessions and optional hooks.

In each participating session, enter:

```text
/cmdr my-project
```

The first session becomes commander; subsequent sessions join the same squad as executors. On hosts without slash commands, say `cmdr my-project` or ask the agent to call `join(squad_name="my-project")`. Creation and lookup run in one transaction. Orphaned squads require an explicit takeover or executor join.

## Workflow

1. Executors join and `report(status="ready")` with their cwd, capabilities and context.
2. The commander inspects `list`, then `send`s clear tasks with acceptance criteria.
3. Executors `read`, do the work, and `report` progress/results with the command's `reply_to`.
4. Executors use `ask` when blocked; the commander responds with `send(type="answer", reply_to=<ask id>)`.
5. Both sides wait using `read(wait=me.recommended_wait)`. The included skills bound standby to 40 rounds.
6. `leave` preserves queued messages. Commander departure orphans the squad; `leave(dissolve=true)` disbands it.

cmdr connects sessions already running. It does not create agents or actively wake an idle host. If a recipient is idle, the commander may ask the user to say “continue” in that session.

## Tools

Exactly seven MCP tools are exposed, independently of the host:

| Tool | Purpose |
| --- | --- |
| `join` | Atomic join/create by `squad_name`, or explicit `role` and squad ID |
| `list` | Squad members, cwd, presence, activity and pending commands |
| `send` | Commander commands, answers and information; operator equivalent in CLI |
| `report` | Executor ready, working, blocked, done or failed reports |
| `ask` | Executor questions, optionally waiting for a correlated answer |
| `read` | Priority-ordered dequeue, peek, history or long polling |
| `leave` | Leave, orphan or dissolve a squad |

Every successful tool result includes identity, recommended wait and unread count. Reports carry their status in `message.data.status`. Unread messages are retained across daemon restarts; reads mark them delivered and leave history. There is no processing acknowledgement: if a host crashes after delivery, use history to recover the work.

## Operator CLI

```sh
plugins/cmdr/bin/cmdr status
plugins/cmdr/bin/cmdr list --all
plugins/cmdr/bin/cmdr tail --follow
plugins/cmdr/bin/cmdr send --squad <id> --to tests "Run the test suite"
plugins/cmdr/bin/cmdr read --session <sid> --peek
plugins/cmdr/bin/cmdr daemon start
plugins/cmdr/bin/cmdr daemon restart
plugins/cmdr/bin/cmdr doctor
plugins/cmdr/bin/cmdr config --agent zcode
plugins/cmdr/bin/cmdr purge
```

`purge --all` deletes all cmdr data, including active memberships and queues. Normal `purge` only expires old data. `tail --full` includes complete bodies and attachments; default output truncates bodies. Read-only commands do not start the daemon.

State is under `~/.cmdr/`; `CMDR_HOME` overrides it. The directory is 0700 and the Unix socket is 0600. Optional `config.json`:

```json
{
  "ttlDays": 7,
  "idleExitMinutes": 30,
  "remindIntervalSec": 300,
  "maxQueue": 1000,
  "rateLimitPerMinute": 60
}
```

The daemon keeps queues, role membership, global message order and history in SQLite (WAL). Hooks expose only message metadata, never message bodies; Stop blocks only on actionable unread messages and is throttled. Queue caps and rate limits provide backpressure. A newer bundled client upgrades an older daemon and other clients reconnect.

## Why MCP instead of terminal orchestration?

[cmux](https://github.com/manaflow-ai/cmux) and [herdr](https://github.com/herdrdev/herdr) organize agents through terminal workspaces and process lifecycle. cmdr attaches coordination to an Agent session: typed messages, persistent delivery state, explicit roles and host lifecycle hooks. Desktop sessions do not need a tty or terminal pane. You can also use cmdr within a terminal manager.

## Development

```sh
npm ci
npm run check
npm run verify:zcode   # optional: requires the locally installed ZCode desktop runtime
```

`npm run check` checks formatting/types, builds the four entry points, runs unit/real-process tests, then packs and installs the npm tarball offline in a temporary prefix to verify the CLI and seven MCP tools. CI runs on macOS/Linux with Node 22/24 and checks generated bundles are not tracked by Git. The optional ZCode check validates, installs and connects the plugin using an isolated desktop runtime, without making a model request.

For development, `claude --plugin-dir ./plugins/cmdr` loads the plugin directly. Installed hosts use cached copies: reinstall/refresh after changing a plugin. Version numbers come from `package.json`; after same-version changes, restart the daemon explicitly. Generated bundles and third-party license notices are ignored by Git and included in the npm package.

v1 is single-machine, single-user, Unix-socket-only. There is no network listener, remote transport, automatic Agent launching or executor-to-executor messaging. Host GUI interaction and live model behavior are distinct from the automated runtime checks; see the [verification record](docs/implementation.md).

[MIT](LICENSE)
