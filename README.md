# cmdr

**Commander for local AI coding sessions.** cmdr is designed to connect multiple Claude Code and Codex sessions on the same machine as a squad, so one session can coordinate work while the others execute tasks and report back.

[中文说明](docs/README.zh-CN.md) · [Design specification (Chinese)](docs/cmdr-design-v1.md) · [License](LICENSE)

> The repository currently contains the v1 design documentation. The source tree, packaged plugin, and release artifacts described by the specification have not yet been added to this branch.

## Quick start

Use one memorable squad name in every participating session:

```text
/cmdr my-project
```

The first session creates squad `my-project` and becomes its commander. Entering the same command in another session joins the existing squad as an executor. The explicit `join` tool remains available when you need a particular role, a squad ID, or takeover of an orphaned squad.

## Why cmdr?

Running several coding-agent sessions in parallel is easy; coordinating them reliably is not. cmdr provides a local communication layer with explicit roles, durable queues, priorities, and lifecycle-aware reminders:

- **One plugin, multiple surfaces:** the same MCP-based workflow works in Claude Code and Codex, including their desktop applications—not only terminal CLIs.
- **Commander and executors:** one session dispatches work; executor sessions report progress and ask questions.
- **Durable local messaging:** unread messages remain in SQLite-backed, per-session queues and survive daemon restarts.
- **Priority-aware delivery:** commands, questions, and answers take precedence over routine progress reports.
- **Agent-friendly reminders:** hooks surface unread-message metadata at the next useful interaction and can prevent a session from stopping before handling important work.
- **Long-poll standby:** executors can wait efficiently for follow-up work without busy polling.
- **Local by design:** communication uses a user-only Unix socket; there is no network listener or cross-machine transport.

## Why MCP queues instead of a terminal orchestrator?

[cmux](https://github.com/manaflow-ai/cmux) is a macOS terminal application centered on panes, tabs, notifications, and an agent-friendly workspace. [herdr](https://github.com/herdrdev/herdr) is a persistent terminal runtime: it owns the terminals agents run in and lets users detach, reconnect, inspect pane state, and control sessions through a CLI or socket API. Both are valuable when terminal lifecycle and workspace presentation are the problem.

cmdr deliberately works one layer above that model:

| | cmux / herdr style | cmdr |
|---|---|---|
| Primary abstraction | Terminal, pane, or workspace | Agent session, squad, and typed message |
| Integration boundary | Own or manage the terminal process | MCP tools and host lifecycle hooks |
| Communication | Prompt/control a terminal session | Durable per-session priority queues |
| State | Pane/process status and terminal history | Commands, questions, answers, reports, unread state, and reply links |
| Host requirement | Agent runs in a managed terminal | Agent may run in a CLI, IDE, or desktop application |

This matters for **Claude Desktop and Codex Desktop**, where a session may have no useful tty and multiple threads may share GUI process ancestry. A terminal-injection design would bind identity and delivery to the wrong layer. MCP gives each Agent structured operations, while SQLite-backed queues preserve delivery across disconnects and daemon restarts. Hooks add lifecycle-aware reminders without scraping terminal output or injecting message bodies into prompts.

The approaches are complementary rather than mutually exclusive: run cmdr inside cmux or herdr when you want their terminal UX and persistence, and use cmdr for structured coordination between the agents. cmdr also works when those agents live directly in desktop hosts.

## How it works

```text
Claude Code / Codex session          Claude Code / Codex session
        (commander)                         (executor)
             │ MCP stdio                         │ MCP stdio
             ▼                                   ▼
          cmdr-mcp                            cmdr-mcp
             └──────── Unix socket ──────────────┘
                              │
                              ▼
                    one local cmdr daemon
                  SQLite + prioritized queues
                              ▲
                              │
                    hooks and cmdr CLI
```

Each host session starts a small MCP process. Those processes share one on-demand daemon under `~/.cmdr/`. The daemon owns session presence, squad membership, message routing, persistence, long-poll waiters, and housekeeping. Short-lived hooks register activity and inject concise unread-message notices without putting message bodies into hook context.

## MCP tools

cmdr exposes seven tools to agents:

| Tool | Who uses it | Purpose |
|---|---|---|
| `join` | Both roles | Create or join a squad as commander or executor |
| `list` | Both roles | Inspect sessions, members, presence, activity, and pending work |
| `send` | Commander | Send a command, answer, or informational message |
| `report` | Executor | Report ready, working, blocked, done, or failed status |
| `ask` | Executor | Ask the commander a question, optionally waiting for an answer |
| `read` | Both roles | Read queued messages or wait for new ones |
| `leave` | Both roles | Leave, orphan, hand over, or dissolve a squad |

## Intended workflow

1. In one session, join as commander and optionally provide a name.
2. Copy the returned squad join line into other Claude Code or Codex sessions.
3. Executors join, report their capabilities and working directory, then wait for commands.
4. The commander sends small, verifiable tasks with acceptance criteria.
5. Executors report progress, ask when blocked, and associate completion reports with the original command.
6. The commander reads results, answers questions, checks the squad board, and either keeps the squad available or dissolves it.

Example prompts:

```text
Join cmdr as commander, name planner.
```

```text
join cmdr squad k7m2pq as executor, name tests
```

## Design principles

- A session has one role and belongs to at most one squad at a time.
- Messages are delivered in priority order and become history when read.
- Offline or idle recipients retain queued messages until they reconnect or become active.
- A commander leaving normally orphans the squad instead of discarding its state; another commander can reclaim the same squad ID.
- cmdr coordinates existing sessions. It does not launch agents, execute message contents, or provide a web UI.
- v1 intentionally avoids undocumented active-wakeup mechanisms for idle sessions.

## Installation

The intended distribution is a self-contained plugin under `plugins/cmdr/`, bundled with esbuild and requiring Node.js 22.5 or newer (Node.js 24 recommended). Once those artifacts are present, the planned host commands are:

### Claude Code

```bash
claude plugin marketplace add /path/to/cmdr
claude plugin install cmdr@cmdr
```

### Codex

```bash
codex plugin marketplace add /path/to/cmdr
codex plugin add cmdr@cmdr
```

Codex hooks must also be enabled and trusted. See the [v1 design specification](docs/cmdr-design-v1.md#114-安装步骤) for the complete intended installation, trust, verification, upgrade, and uninstall procedures.

## Operator CLI

The design includes a `cmdr` CLI for observing and operating the local daemon:

```text
cmdr status
cmdr list --all
cmdr tail --follow
cmdr send --squad <id> --to <member> "message"
cmdr doctor
cmdr daemon start|stop|restart|status|logs
cmdr purge
```

## Scope and status

v1 targets a single machine and a single OS user. It does not provide remote transport, multi-user authentication, encryption, agent creation, executor-to-executor direct messaging, or a web interface.

The detailed specification is the authoritative reference for platform findings, behavior, data structures, internal RPC, packaging, testing expectations, and known risks. Start with [**cmdr Design Proposal (v1)**](docs/cmdr-design-v1.md).

## License

[MIT](LICENSE)
