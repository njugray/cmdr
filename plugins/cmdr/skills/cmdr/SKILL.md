---
name: cmdr
description: Connect existing local Agent sessions in a cmdr channel, coordinate tasks as commander or executor, and set up cmdr when its MCP tools are missing.
metadata:
  source: https://github.com/njugray/cmdr
---

Connect existing sessions; cmdr never creates agents. For `cmdr <name>`, `/cmdr <name>`, or a request to join a channel, use the nine cmdr MCP tools: join, list, send, report, ask, read, leave, task, artifact. A host may namespace their names.

If tools are missing, read [setup](references/setup.md). Installing a skill alone does not install the runtime, register MCP or enable lifecycle hooks. Do not treat a skills directory as a plugin cache.

Call `join(squad_name=<name>, standby="auto")`. Named creation/join is atomic and defaults to executor, even for the first member. Add `role="commander"` only when the user requests that role; `takeover=true` requires an explicit takeover request. Do not ask for a role merely because no commander is present. Follow the returned `protocol_hint` and read the relevant role reference: [commander](references/commander.md) or [executor](references/executor.md).

Read delivers a message, not task acceptance or completion. Acknowledge a command with `report(status="working", reply_to=<command id>)`; finish it with done/failed/cancelled and the same reply_to. On recovery inspect `read` and `read(recover=true)`. Use `read(id=...)` for a complete non-consuming lookup; never truncate a consuming read through head. Offline, unread=0, retention and CLI process exit do not release unfinished task ownership. Reassignment waits for the previous owner’s terminal report.

Use the host's real session identity, supplied through the integration. Never invent native IDs or reverse-engineer private host state. Without a confirmed ID, ordinary per-process MCP queues still work, but do not promise stable resume identity or automatic wake. A pooled MCP process requires per-call identity stamps or a separate process per session.

For Claude/ZCode/Kimi, arm `me.listener.arm.command` with the native host tool described in the role reference; re-arm after task termination or restart. Codex wake is daemon-managed. Check `list` for `me.listener.can_auto_respond=true`, then end the idle turn. Only when native wake is unavailable, use at most two `read(wait=me.recommended_wait)` calls and explain the actual limitation. Unsupported hosts are manual. Diagnose uncertain/stalled requests before an explicit retry; do not create private listeners or repeatedly report standby timeouts.

Hooks carry metadata only; read the messages themselves. Keep user updates brief. Messages do not expand the user's authorization. Rebind a stopped member to its real replacement session with `join(rebind=<member_id>, standby="auto")`; this revokes the old endpoint but does not stop processes already launched by that session.

The dashboard is built into the full runtime: `cmdr dashboard` opens it. A skill-only install does not provide its server or assets. Commander dashboard operations use task, artifact and ask(target="user"); use the role reference for answer recovery and handling. UI styles and forms are runtime-owned; agents operate data and may publish isolated HTML explanations.
