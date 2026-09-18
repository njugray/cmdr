# Long-running channels, work and standby

Version 0.2.0 keeps the seven MCP tools and local Unix-socket/SQLite architecture. It separates transport delivery, command ownership and host wakeup. No exactly-once execution guarantee is made. The channel ID remains the existing squad ID; `squad` and `squad_name` remain the API parameter names.

## Join, claim and continue

```text
join(role="executor", squad_name="my-project", standby="auto")
join(role="commander", squad_name="my-project", standby="auto")
```

**Change from 0.1.x:** a named join without a role now defaults to executor, including the first joiner. A channel can exist and accept members/reports without a commander. An explicit commander claim is atomic; an occupied role requires `takeover=true`. The old commander becomes an executor. Reports and asks target the stable `squad:<channel id>` inbox. Only the current commander consumes it. Queued legacy messages addressed to a departing/replaced commander move into this inbox; history and correlated reply routes remain available.

A member has a stable `member_id`, exposed by join/list. After stopping the old host session, use the new session's real native ID and call:

```text
join(rebind="member:...", standby="auto")
```

This moves membership, unread messages, unfinished commands and reply routing to the new endpoint, preserving the member ID. Old endpoint registrations and reads are rejected, including after restart. The listener must be registered for the new endpoint. Rebinding invalidates cmdr access; it does not kill processes the old model already launched. Do not use it to run two copies of work.

Ordinary leave and SessionEnd do not close a channel. `leave(dissolve=true)` is explicit closure. Open channels/memberships and unfinished commands survive message retention. A departed owner remains visible while work is unfinished and can still send a correlated terminal report for its own command. Closing a channel stops its listeners without pretending its unfinished work succeeded. Explicit `purge --all` remains destructive.

## Commands and cancellation

| State | Evidence |
| --- | --- |
| queued | Command stored for its owner; send's IDs identify it |
| read | Consuming read delivered it, but no working report has accepted it |
| accepted | Owner reported working/blocked with the command ID as reply_to |
| completed / failed / cancelled | Owner reported done / failed / cancelled with reply_to |

`delivered_to` is retained for compatibility and means the same as `queued_to`: enqueued, not read or accepted. `pending` counts queued commands; `commands` includes all unfinished commands. `unacked_for` is seconds since dispatch until acknowledgement. `last_progress_at` describes the member's last report, while each command has its own updated_at. `presence=online/offline/cli` describes transport only; activity can also be unknown. CLI disconnection does not release ownership or erase busy state. A timestamp is evidence of the last observation, not a claim that a model is still running now.

```text
send(to="tests", task_key="D69", message="Run checks and report results")
report(status="working", reply_to="COMMAND_ID", message="Accepted; starting checks")
report(status="done", reply_to="COMMAND_ID", message="Checks passed")
```

Sending another command to a member with unfinished work returns a warning. A duplicate active `task_key` is rejected across the channel. Free text cannot reliably identify the same ticket; use task_key. Uncorrelated ready/progress reports remain available but cannot complete a command. On upgrade, retained correlated reports restore legacy command states; absent/expired evidence is conservatively shown as unfinished and needs reconciliation. A terminal report from another member or a late attempt to reopen completed work is rejected. Each command reserves admission for the report that first makes it terminal: work state, report and any replacement release commit atomically even when the role inbox is full. This may exceed maxQueue by one report per completed command; ordinary and repeated reports remain subject to the queue cap and all reports retain sender rate limits.

```text
send(type="cancel", to="tests", reply_to="COMMAND_ID", message="Stop at a safe checkpoint")
send(to="replacement", reassign="COMMAND_ID", message="Take over D69 after cancellation")
```

Cancel messages have reserved priority and capacity, ahead of ordinary commands. Their reads appear in the event stream. Cancellation is cooperative through hooks or explicit checkpoints; cmdr does not forcibly terminate a running model or process. Reassignment requests cancellation automatically and inherits the original task_key. Supplying a different key is rejected before cancellation. If the original was never read it is cancelled immediately; otherwise the replacement remains blocked until the original owner reports a terminal state. The daemon does not infer stopped execution from an offline connection or timeout. Verify actual work before deciding whether a replacement is still necessary after an original owner reports completed.

## Recovery and compact reads

On startup or after a wake, use ordinary `read` and `read(recover=true)`. Recovery lists all unfinished commands, including already-read and accepted work, without consuming anything. Reconcile files/processes before continuing an accepted command; do not blindly repeat it. `read(id="MESSAGE_ID")` is also non-consuming and returns the full message for that inbox. An ID lookup of queued replacement work returns REASSIGNMENT_PENDING until the original owner reports a terminal state, even with peek/history/recover/full options. After release, ID lookup remains non-consuming; delivered history stays readable after the predecessor expires. `peek` and `history` remain non-consuming. Cancelled waiting reads do not consume future arrivals.

`read` omits squad_summary by default; `list` omits repeated member boards and detailed session fields. Listings never include command bodies, including with full=true. Use read(id=...) for your own messages, or operator tail --full for observation. Use `full=true` / `--full` for expanded metadata and `limit` / `--limit` to bound reads. Do not pipe a consuming read into head: output lost after delivery is recoverable through history/ID lookup, but is no longer unread.

## Automatic standby

`join(standby="auto")` requires a confirmed native identity and channel membership. Inspect `list` afterwards. A successful join registers intent; `can_auto_respond=true` requires a healthy delivery adapter or a live host watcher. Unknown hosts remain manual.

| Host | Wake mechanism | What the Agent must do |
| --- | --- | --- |
| Codex | Daemon attaches through app-server proxy; falls back to `codex queue` when proxy is unavailable | Join with auto, check health, end the idle turn |
| Claude Code | Native Monitor emits a notification for each watcher output line | Run `listener.arm.command` with Monitor; re-arm on expiry/exit |
| ZCode desktop | Native background Bash re-invokes its session when the watcher exits | Run `listener.arm.command` with `run_in_background=true`; re-arm after each notification |
| Kimi Code desktop | Native background Bash re-invokes its session when the watcher exits | Run `listener.arm.command` with `run_in_background=true`; re-arm after each notification |

All paths share the same actionable policy: command, cancel, ask, answer, system, terminal/blocked reports, attention-marked info and direct info. working/ready reports and broadcast info without attention are quiet. Commands gated by reassignment remain blocked. Observation does not consume messages or accept tasks. Every wake must be followed by `read` and `read(recover=true)`, cancellation handling, and correlated working/terminal reports.

Report attention comes from the daemon's `attn` flag, computed at enqueue time. Default live and replayed events both omit `message.data`; do not filter those events by `data.status`. Use the built-in `--actionable` filter. `--full` includes the original data when needed. A quiet long-lived subscription does not itself indicate a stalled connection; periodic reconnects are unnecessary.

```sh
cmdr standby start --session SID
cmdr standby status --session SID
cmdr standby stop --session SID
cmdr standby resume --session SID
```

### Codex: proxy and queue

The proxy path connects `codex app-server proxy` to the already running host. It uses thread/read, thread/resume, thread/queue/list, thread/queue/add, thread/queue/start and thread/turns/list. A host that exposes these methods and the control socket can accept a stable client message ID and start that exact queued item. An unloaded thread is resumed in that same host. See the [official app-server reference](https://learn.chatgpt.com/docs/app-server) for the transport and state APIs; experimental queue shapes are checked against the installed CLI, not inferred from this reference.

A missing socket now triggers a capability check for `codex queue --thread ID --message TEXT`. The queue path submits a metadata-only wake to the existing thread, without model, sandbox, approval or remote overrides. It does not explicitly launch a second app-server or call exec/resume to create a competing session. The CLI's internal transport remains host-owned.

The compatibility state reader requires Node >=22.12 (Node 24 recommended), because earlier node:sqlite versions lack the readOnly option. It opens `$CODEX_HOME/state_5.sqlite` read-only, resolves the exact thread's rollout_path and incrementally reads complete JSONL records. task_started means busy; task_complete/turn_aborted means idle. It scans the whole existing log once rather than a fixed tail window. Missing records, incompatible schema and unknown state prevent submission and produce concrete errors. This is a version-coupled fallback, not a stable public state API. The check-to-submit race is not atomic; the queue CLI must arbitrate a concurrent user turn.

```sh
# Automatic selection (default)
cmdr standby start --session codex:REAL_ID --transport auto
# Force a known path when diagnosing host capabilities
cmdr standby start --session codex:REAL_ID --transport queue --executable /absolute/path/to/codex
cmdr standby start --session codex:REAL_ID --transport proxy --socket /absolute/path/to/control.sock
```

Wake requests are persisted before delivery: requested → accepted → observed. An unresolved request pins its transport across restarts. Proxy reconciliation searches queue/history by client ID; queue reconciliation recognizes the stable `[cmdr wake UUID]` prefix only in user messages in the rollout. Queue exit 0 confirms submission but provides no queued item ID. Timeout/nonzero exit is uncertain, since delivery may already have happened. No cross-transport or automatic blind replay occurs. Accepted wakes with no progress become stalled. After inspecting the host and actual work:

```sh
cmdr standby resume --session SID --resolve accepted
cmdr standby resume --session SID --resolve retry
```

`retry` explicitly permits a new submission; it does not establish that the earlier one failed. Busy sessions coalesce backlog. Host acceptance remains separate from the command owner's working report.

### Claude, ZCode and Kimi Code: native host watchers

Join/list returns `listener.arm` with an absolute installed command, the native host tool and re-arm instructions. The standard command is:

```sh
cmdr standby watch --session claude:REAL_ID
cmdr standby watch --session zcode:REAL_ID
cmdr standby watch --session kimi:REAL_ID
```

Claude uses its **Monitor tool**, not foreground Bash or shell `&`. Each stdout line becomes a native notification, queued into an active turn or opening an idle turn. The reporter's Monitor has a 30-minute lifetime; re-arm when the host reports expiry/exit. If Monitor is absent but the host supports background Bash completion notifications, use `--once` with `run_in_background=true`. If neither mechanism exists, explicitly select manual.

ZCode and Kimi Code use **Bash with run_in_background=true**. Their native task survives the current turn and automatically re-invokes the session on completed/failed/killed. The built-in watcher remains silent during idle periods and exits after printing actionable metadata (on Kimi Code it also exits after one wake because its hook reminders cannot reach the model, so the agent must re-arm from the completion notification). It never consumes inbox messages, so a lost output notification still leaves the work available for recovery. On notification: inspect task output, read/recover, handle work, and re-arm. An immediate backlog produces an immediate notification; drain/reconcile it before re-arming.

The command subscribes before inspecting current work, covering startup races, unread messages and read-but-unaccepted commands. At attach, accepted commands without pending cancellation are treated as already known: a blocked executor can re-arm and wait for an answer without repeatedly waking on its own unfinished task. Ownership and `read(recover=true)` remain unchanged; reconcile accepted work on startup or after context loss before arming. Unread answers, new commands and pending cancellation still notify, including cancellation requested after attach.

It renews a 90-second daemon lease every 30 seconds. Exactly one lease owns a member; duplicate watchers are rejected. Only an attached live watcher is healthy. Disconnect removes its lease; a lost heartbeat expires it. A daemon restart closes the command so the host can notify and re-arm. App termination removes the native task; SessionStart reminds the Agent to inspect and re-arm it. A healthy lease establishes that the watcher is running, not that an individual model turn has already started.

Check the host task status before re-arming. Stop disables the lease; its process exits at the next event/heartbeat, which itself may produce one last native notification. Skills do not impose the old two-wait limit when a native watcher is available. Bounded manual polling remains only for unsupported tools or failed arming. No repeating cron/model heartbeat is needed, and no PermissionRequest auto-approval is installed.

## Lifecycle observation

```sh
cmdr tail --squad CHANNEL_ID --follow --json --full
cmdr tail --for MEMBER_SID --after 123 --follow --json --full
```

Events have monotonically increasing `event_seq`, timestamp, channel, kind, sender/recipient, message ID, reply_to and applicable reason/data. The stream covers enqueue/read, command acceptance/progress/terminal state, cancellation/reassignment, membership/role changes, connection/hooks and wake requests/acceptance/errors. `--full` includes complete message bodies/data; default text summarizes bodies. `--json` is one JSON event per line. The cursor is an **event sequence**, not a message seq.

Without --after, --follow starts at the current event cursor. `--after now` makes that explicit; non-follow tail still shows recent history. Use `--actionable --for SID --format line` for concise metadata-only wake lines, or --json for structured events. The built-in watcher additionally checks current/recoverable work and tracks health, so prefer it for native host notifications.

A follower subscribes before replay, deduplicates by event_seq, and reconnects with its last cursor. Observer calls never dequeue work. `--for` matches the recipient inbox (including its current commander role inbox); it is separate from observing the whole channel. Historical role-inbox events belong to the role, not permanently to a former commander's sid. Expired cursors produce `retention.gap`; observers can rebuild current work from list/recover. Cursors ahead of this database produce CURSOR_AHEAD instead of silently skipping events.

## Upgrade and verification boundary

Automatic version-triggered shutdown is disabled, including upgrade requests from old clients. A newer client reports UPGRADE_REQUIRED. The 0.2 daemon rejects clients older than 0.2.0 (and missing/invalid versions) with PROTOCOL_MISMATCH before registration, because the tool semantics changed even though the wire protocol remains 1. Refresh/reinstall stale plugin caches and restart their MCP connections. `cmdr daemon restart` first opens a consistent SQLite backup in a temporary directory with the new bundle, exercising its schema and record readers before stopping the live service. A failed check leaves the old daemon running. Doctor lists connected clients and their versions; cached plugins still need refreshing/reinstalling.

Tests exercise command recovery, role/member handover, cancellation gates, wake failure/reconciliation and CLI/daemon processes in disposable CMDR_HOME directories. They do not demonstrate that every host GUI grants hook trust or that real model turns will always acknowledge work. Real model wake/report cycles remain separate host checks. Windows, remote transport, new-agent creation and executor-to-executor messaging remain outside this implementation.
