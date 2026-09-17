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

On startup or after a wake, use ordinary `read` and `read(recover=true)`. Recovery lists all unfinished commands, including already-read and accepted work, without consuming anything. Reconcile files/processes before continuing an accepted command; do not blindly repeat it. `read(id="MESSAGE_ID")` is also non-consuming and returns the full message for that inbox. `peek` and `history` remain non-consuming. Cancelled waiting reads do not consume future arrivals.

`read` omits squad_summary by default; `list` omits repeated member boards and detailed session fields. Listings never include command bodies, including with full=true. Use read(id=...) for your own messages, or operator tail --full for observation. Use `full=true` / `--full` for expanded metadata and `limit` / `--limit` to bound reads. Do not pipe a consuming read into head: output lost after delivery is recoverable through history/ID lookup, but is no longer unread.

## Managed standby

```sh
cmdr standby start --session codex:REAL_THREAD_ID
cmdr standby status --session codex:REAL_THREAD_ID
cmdr standby stop --session codex:REAL_THREAD_ID
cmdr standby resume --session codex:REAL_THREAD_ID
# Optional explicit local host transport:
cmdr standby start --session codex:REAL_THREAD_ID --adapter codex --executable /absolute/path/to/codex --socket /absolute/path/to/control.sock
```

`join(standby="auto")` registers the same listener. It requires confirmed native identity and channel membership. There is one persisted listener per endpoint, executed by the existing single-instance daemon. Enabled listeners prevent idle daemon exit and recover on daemon restart. Stop disables future checks; it does not retract a wake already accepted by the host. `list`, `status` and `doctor` expose listener health and the latest request. No per-session lockfile, script or private host database parsing is required.

The built-in Codex adapter uses `codex app-server proxy` against the already running shared local host. It requires runtime support for `thread/read`, `thread/resume`, `thread/queue/list`, `thread/queue/add`, `thread/queue/start` and `thread/turns/list`, including client user-message IDs. The shared control socket must already be exposed by the host; a CLI installation alone is insufficient. Use --socket when the host exposes a nondefault local control socket. The listener never bootstraps a separate host daemon. These experimental queue methods are feature-checked through actual calls; older runtimes or unsupported endpoints show an error and do not claim automatic response. See the [official app-server reference](https://learn.chatgpt.com/docs/app-server) for the public transport and thread status APIs. Queue shapes were checked against this development machine's generated CLI protocol; this is not a claim of support in every Codex release.

The adapter queues a metadata wake prompt for the registered existing thread, with a stable request ID, then asks the host to start that exact queued submission. An unloaded existing thread is resumed by its real ID through thread/resume, without supplying model, permission or sandbox overrides. It does not create threads or a separate app-server. Only actionable inbox messages and recoverable commands trigger a wake. working/ready reports and ordinary info do not; done/failed/blocked/cancelled/ask/answer/command do. Send `attention=true` for info that unblocks work. Busy sessions coalesce backlog, and urgent cancel is discovered at the next hook/tool checkpoint. No second competing model process is started.

Wake stages are persisted before external calls: requested → accepted → observed. Host queue/history reconciliation distinguishes a lost response from a missing request. A request that might have succeeded is **not automatically resent**. Unknown outcomes show uncertain; accepted wakes with no progress show stalled. Errors are persisted and emitted as lifecycle events. After inspecting the host, the operator can explicitly resolve:

```sh
cmdr standby resume --session SID --resolve accepted
cmdr standby resume --session SID --resolve retry
```

`retry` explicitly permits a fresh wake; it is not evidence the previous attempt failed. After a completed host turn with changed but unfinished work, the listener can issue a recovery wake. Repeated notifications or listener restart do not independently create duplicate requests. Host acceptance is never task acceptance: only the command's correlated report confirms that.

Claude, ZCode and other MCP hosts currently report manual. `can_auto_respond` is true only for an enabled healthy adapter. A queued host submission with unknown runtime state remains unhealthy with can_auto_respond=false; once idle is confirmed, the same submission can start without another enqueue. After registration, check list; starting is not confirmation. With a healthy listener, the model may end its idle turn. Otherwise the skill permits at most two recommended waits, then explains manual continuation. Never promise active wakeup based solely on hooks or a successful send.

## Lifecycle observation

```sh
cmdr tail --squad CHANNEL_ID --follow --json --full
cmdr tail --for MEMBER_SID --after 123 --follow --json --full
```

Events have monotonically increasing `event_seq`, timestamp, channel, kind, sender/recipient, message ID, reply_to and applicable reason/data. The stream covers enqueue/read, command acceptance/progress/terminal state, cancellation/reassignment, membership/role changes, connection/hooks and wake requests/acceptance/errors. `--full` includes complete message bodies/data; default text summarizes bodies. `--json` is one JSON event per line. The cursor is an **event sequence**, not a message seq.

A follower subscribes before replay, deduplicates by event_seq, and reconnects with its last cursor. Observer calls never dequeue work. `--for` matches the recipient inbox (including its current commander role inbox); it is separate from observing the whole channel. Historical role-inbox events belong to the role, not permanently to a former commander's sid. Expired cursors produce `retention.gap`; observers can rebuild current work from list/recover. Cursors ahead of this database produce CURSOR_AHEAD instead of silently skipping events.

## Upgrade and verification boundary

Automatic version-triggered shutdown is disabled, including upgrade requests from old clients. A newer client reports UPGRADE_REQUIRED. The 0.2 daemon rejects clients older than 0.2.0 (and missing/invalid versions) with PROTOCOL_MISMATCH before registration, because the tool semantics changed even though the wire protocol remains 1. Refresh/reinstall stale plugin caches and restart their MCP connections. `cmdr daemon restart` first opens a consistent SQLite backup in a temporary directory with the new bundle, exercising its schema and record readers before stopping the live service. A failed check leaves the old daemon running. Doctor lists connected clients and their versions; cached plugins still need refreshing/reinstalling.

Tests exercise command recovery, role/member handover, cancellation gates, wake failure/reconciliation and CLI/daemon processes in disposable CMDR_HOME directories. They do not demonstrate that every host GUI grants hook trust or that real model turns will always acknowledge work. Real Codex queue execution and Claude/ZCode manual-continuation UX remain separate host checks. Windows, remote transport, new-agent creation and executor-to-executor messaging remain outside this implementation.
