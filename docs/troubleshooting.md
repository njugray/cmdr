# Installation and session troubleshooting

The npm package is `cmdr-mcp`; the plugin and commands are `cmdr`. Install the complete package, register its root as the marketplace, refresh/reinstall the host cache, then start a new session. Do not copy only `bin/` or symlink `dist` from another global package. Git checkouts require `npm ci && npm run build` before registration.

```sh
npm install -g cmdr-mcp
# Use this directory in the host's marketplace picker:
npm root -g
# Append /cmdr-mcp to the printed directory.
cmdr doctor
cmdr doctor --plugin-root /absolute/path/to/host/cache/cmdr
cmdr doctor --plugin-root /absolute/path/to/host/cache/cmdr --deep
```

`--plugin-root` is the plugin directory containing `bin/`, `dist/` and the host manifests, not the marketplace root. A normal `doctor` inspects its own installation; a healthy global package does not prove the host cache is healthy. Target checks compare SHA-256 hashes and manifest versions against `dist/integrity.json`, and reject linked assets. This detects damage or mixed builds, not malicious replacement of both the files and checksums.

The checker lives outside the bundles. If the selected plugin's CLI bundle is missing, its `bin/cmdr doctor` can still report the damage with Node installed. Alternatively use an intact global CLI to inspect that cache. If Node is missing, the shell wrapper reports the Node requirement; install Node >=22.5 and retry. A missing checker requires reinstalling the complete package.

`doctor` exits nonzero for fatal installation failures. `--deep` additionally initializes MCP, verifies exactly seven tools, and calls `list` to check the daemon. It uses a temporary `CMDR_HOME`, an eight-second probe timeout and child cleanup. It does not join a squad or operate on the user's normal queues. Static checks do not start the normal daemon; reporting “daemon not running” is not itself an installation error.

The states are distinct:

| Observation | Meaning / next action |
| --- | --- |
| Plugin enabled | The host discovered configuration; this alone does not prove MCP connected. |
| Seven tools exposed | MCP initialized; call a tool to check daemon access. |
| No tools | Inspect the actual cache, reinstall from the built package and open a new session. |
| `hook-*` is `unknown` | No observation has been recorded here; configuration alone cannot prove hooks ran. |
| `hook-unavailable` | A hook could not reach a running daemon; hooks intentionally do not start it. |
| `identity-conflict` | A hook session ID disagreed with explicit `CMDR_SESSION_ID`; correct the configuration. |
| Protocol mismatch | Follow the message's client/daemon protocol information; update the cache, restart the matching daemon and reconnect the host. |
| Member offline | No member connection is held; queued messages and membership are retained. This says nothing about task execution; CLI-only members display cli. |

`CMDR_HOME/logs/diagnostics/` contains bounded snapshots with timestamps and metadata only. Hook observations describe the most recently recorded host for each event, not every session; activity from a different host is not evidence that your current host's hooks work. Snapshots are rate limited (10 seconds; bootstrap failures 60 seconds), use restricted permissions, and never include message bodies, hook input, credentials or environment dumps. Unknown is not equivalent to failure. Logs cannot block hooks if unwritable. Upgrade and reconnection snapshots are best-effort diagnostics, not actionable queue messages or delivery guarantees.

ZCode has four supported plugin hooks; SessionEnd is replaced by EOF detection. The PreToolUse event stamps its native `session_id` into `_cmdr_session`; the MCP bridge consumes it before forwarding. A shared MCP process requires a stamp on every call. Do not put one static `CMDR_SESSION_ID` on a shared process. With a dedicated process, its explicit ID must match hook events. No hooks means use a dedicated MCP process with a stable ID or the member CLI below; process/cwd cannot identify an arbitrary conversation.

## ZCode cache has no `dist/`

If `bin/cmdr-mcp` exists but `dist/mcp.mjs` is missing, the launcher exits before MCP initializes, so none of the seven tools can register. A working global `cmdr` uses a separate installation and does not repair this cache. Missing `dist/integrity.json` also prevents verification of otherwise present manifests; this alone does not prove those manifests were modified. Hooks fail open and record a rate-limited `bootstrap-runtime` diagnostic when possible, so a quiet hook does not establish a healthy installation.

Check the registered marketplace source first. An unbuilt Git checkout contains manifests and launchers but no generated runtime. The missing files alone cannot distinguish an unbuilt source from an incomplete cache copy.

1. In ZCode's marketplace settings, replace the source with `njugray/cmdr#marketplace` (available after the maintainer publishes that branch). This source includes the runtime.
2. Refresh/reinstall cmdr. Reinstalling from the same unbuilt source will reproduce the failure. For offline/local installation, use the complete installed npm package root or a built checkout.
3. Run `cmdr doctor --plugin-root /actual/zcode/cache/plugin --deep` against the resulting cache. Resolve static installation failures before expecting a successful deep probe.
4. Start a fresh ZCode session and confirm the cmdr tools appear. Do not link another installation's `dist/` into the cache or restart an unrelated shared daemon to repair missing plugin files.

The repository's `npm run verify:zcode` exercises installation from an npm tarball in temporary storage, checks cache integrity, and verifies seven MCP tools after removing the source directory. It does not inspect or repair an existing user's cache.

## Member CLI fallback

`cmdr session` provides the seven member operations using the same schemas, role checks and reply routing as MCP. It requires an actual stable native ID; never invent one to impersonate a different session. For CLI-only use, the operator may deliberately assign and consistently reuse a unique ID for that independent member.

```sh
cmdr session join --agent zcode --native-id YOUR_SESSION_ID --squad-name my-project
cmdr session report --agent zcode --native-id YOUR_SESSION_ID --status ready "Ready"
cmdr session read --agent zcode --native-id YOUR_SESSION_ID --wait 45
cmdr session ask --agent zcode --native-id YOUR_SESSION_ID --wait 45 "What next?"
cmdr session report --agent zcode --native-id YOUR_SESSION_ID --status done --reply-to COMMAND_ID "Done"
cmdr session leave --agent zcode --native-id YOUR_SESSION_ID
```

Named joins default to executor; report/ask require that role. Explicitly claim command with `join --role commander --squad-name my-project`. The commander uses:

```sh
cmdr session list --agent zcode --native-id COMMANDER_ID
cmdr session send --agent zcode --native-id COMMANDER_ID --to MEMBER_SID "Run checks"
cmdr session send --agent zcode --native-id COMMANDER_ID --to MEMBER_SID --type answer --reply-to ASK_ID "Proceed"
```

`CMDR_AGENT` and `CMDR_SESSION_ID` can supply identity instead of flags. Conflicting flags and environment are rejected. `--input` accepts the full operation's JSON schema, including `data`, `limit`, `since` and recipient arrays; `_cmdr_session` is reserved for MCP and is not accepted here. `--peek`, `--history`, `--all`, `--dissolve`, `--role` and `--squad` cover common cases. Options also provided as flags override matching JSON fields.

Every command writes a JSON result, or a JSON error on stderr with a nonzero exit code. `--timeout` bounds the operation (default wait+10 seconds, maximum 3600 seconds); SIGINT/SIGTERM cancel it. A cancelled waiting read does not consume later arrivals. A cancelled ask may already have been sent: requests are never automatically replayed, and a lost response is not proof that the mutation failed. Inspect history before manually retrying.

Short-lived commands display cli and retain task ownership after exit. They do not leave channels or imply success on read. Enable daemon-managed standby separately or through join --standby auto; unsupported hosts remain manual. Existing operator `cmdr send/read/list` commands retain their previous meaning. This CLI fallback still requires an intact runtime; it cannot compensate for all bundles being missing.


## Long-running collaboration diagnostics

- Use `list` to inspect `commands`, `unacked_for` (seconds since dispatch until acceptance), `last_progress_at`, `hook_seen_at` and listener health. Do not reassign based on presence alone. Even list --full omits command bodies; use your own read --id or operator tail --full for those.
- Use `read --recover` for unfinished work and `read --id MESSAGE_ID` for a non-consuming full lookup. `--full` restores the expanded squad summary. Consuming read output should not be piped to head.
- `standby status --session SID` exposes the current wake ID and requested/accepted/observed/uncertain state. `stalled` means host acceptance did not produce progress. Check the host before `standby resume --session SID --resolve retry` (explicitly permits a new request) or `--resolve accepted` (retain the existing request). A missing lookup result is not proof that an earlier request failed. A queued submission with host_state=unknown remains unhealthy until runtime state can be verified; host queue acceptance alone does not prove that the listener can run a turn.
- `tail --follow --after EVENT_SEQ --for SID --json --full` replays and follows lifecycle events without reading work. `retention.gap` means the cursor predates retained events. Start a new cursor with `--after 0` only after checking CMDR_HOME if CURSOR_AHEAD is reported.
- `UPGRADE_REQUIRED` leaves the old daemon running. Run `cmdr daemon restart` from the new intact installation; it first validates a consistent database copy. If preflight fails, the old daemon is not stopped. `doctor` includes connected client versions; update old caches before reconnecting them. The 0.2 daemon rejects pre-0.2.0 clients with PROTOCOL_MISMATCH and a plugin-cache update hint, even when their wire protocol number matches.
- Missing runtime or Node now produces one stderr line from the fail-open hook wrapper as well as the bounded diagnostic snapshot.

See [long-running collaboration](long-running-collaboration.md) for adapter requirements and recovery examples.

## Automatic wake diagnostics

- Codex: `standby status --session SID` shows the selected `transport`. Auto mode tries proxy then queue. Missing socket alone no longer establishes that wake is unavailable. Queue compatibility needs Node >=22.12, an available CLI with queue --thread/--message, and readable state_5/rollout lifecycle records in the daemon's CODEX_HOME. Inspect the concrete proxy/queue error before choosing an explicit executable or transport.
- Claude/ZCode: `wake_mode=claude|zcode` with starting means the native watcher still needs arming. Use the absolute `listener.arm.command` with Monitor or background Bash as specified; shell detachment cannot supply a native completion notification. WATCHER_ACTIVE means inspect/reuse the existing native task. Re-arm after daemon/App restart or native task expiry.
- `uncertain` is not automatic retry permission. Reconcile host history and cmdr work, then choose standby resume --resolve accepted or retry. CLI acceptance never substitutes for a working report from the member.
