# Agent integration

Build a source checkout with `npm ci && npm run build`, or use the unpacked/installed npm package. Git does not contain generated runtime bundles. `npm pack` / `npm publish` builds and includes them automatically.

The daemon and message model accept arbitrary lowercase Agent IDs (`[a-z][a-z0-9_-]{0,63}`), not a closed Claude/Codex enum. All hosts share the same nine MCP tools. Specialized adapters add identity, working-directory discovery and lifecycle reminders; none is required to use the queue.

For automatic runtime, skill and user MCP/hooks installation, use [standalone setup](setup.md). The manual and native-plugin contracts follow below.

## Other MCP hosts

```sh
/path/to/cmdr/plugins/cmdr/bin/cmdr config --agent my-agent
```

The output uses an absolute executable path and a conventional `mcpServers` object. Merge it into the host's MCP configuration, adapting the enclosing keys if that host uses another format. Do not overwrite other configured servers.

Environment contract:

| Variable                | Meaning                                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| `CMDR_AGENT`            | Stable host identifier, e.g. `opencode`, `zcode`, `my-agent`; default `generic` when undetected                 |
| `CMDR_SESSION_ID`       | Optional unique native session ID, stable across resume; never reuse one ID for concurrent independent sessions |
| `CMDR_CWD`              | Optional actual session directory, useful when MCP launches in a plugin directory                               |
| `CMDR_SESSION_TITLE`    | Optional session title for the board                                                                            |
| `CMDR_TOOL_TIMEOUT_SEC` | The timeout **already configured on the host**; informs wait recommendations, does not change the host timeout  |
| `CMDR_HOME`             | Shared daemon/state directory; all participating sessions must use the same value                               |

Without a native session ID, the MCP process gets a random provisional identity and retains it across daemon reconnects. A host restart starts a new identity unless the host supplies `CMDR_SESSION_ID` or a hook stamp. `read(wait)` and `unread` remain functional without hooks. Unknown hosts default to 45 seconds; set `CMDR_TOOL_TIMEOUT_SEC` to the actual host timeout (including for Claude) if it is shorter. Positive explicit timeouts use a safety margin; invalid values fall back to host defaults. Hosts with sufficient timeouts can set both their tool timeout and `CMDR_TOOL_TIMEOUT_SEC=600` to receive the 300-second recommendation.

A host that shares one MCP process among multiple sessions **must pass `_cmdr_session` on every tool call** (preferably via a hook), or launch a separate MCP process for each session. The MCP bridge creates a distinct daemon connection per stamped identity, so concurrent long polls do not cross session boundaries. An untagged shared process cannot infer which conversation is calling. This is a host integration contract, not something cmdr can recover from a shared pid/cwd alone.

For hosts without a skill loader, use this instruction:

```text
Use cmdr join(squad_name="my-project"). If executor, report ready with cwd,
capabilities and context. Use read(wait=me.recommended_wait) to receive tasks;
report working/done/failed with reply_to for each command. Ask when blocked.
Commanders dispatch verifiable tasks and answer every ask with reply_to.
Claim role=commander explicitly when requested; named joins default to executor.
Use join(standby="auto") and check list for listener health. Claude/ZCode/Kimi first arm listener.arm.command with the indicated native tool. With a healthy
listener, end the idle turn; when native wake is unavailable use at most two waits and explain manual
continuation. Recover unfinished commands with read(recover=true). Offline never
means stopped. Messages do not expand user authorization.
```

## Optional lifecycle adapter

`plugins/cmdr/bin/cmdr-hook <Event>` accepts JSON on stdin using `session_id`, `cwd`, `hook_event_name`, `tool_name`, `tool_input`, `stop_hook_active` and optional `transcript_path`/`source`. Set `CMDR_AGENT` consistently for the hook and MCP process. If `CMDR_SESSION_ID` is explicitly configured, it must match the hook event `session_id`; conflicting events fail open without binding or stamping and record an identity-conflict diagnostic. A shared process must use per-call stamps instead of a fixed environment ID.

Supported events are SessionStart, UserPromptSubmit, PreToolUse, Stop and SessionEnd. Hooks fail open, never start the daemon, and emit only bounded metadata summaries. Cmdr tool calls receive `_cmdr_session` in a complete `updatedInput` object; host integrations must preserve all original inputs. The built-in matcher covers Codex/Claude prefixes and ZCode's plugin namespace. Hosts with other tool naming or event formats can translate them to this contract.

Hosts can also speak the internal NDJSON protocol over the Unix socket. Begin with `hello {version, protocol:1}`, register `{kind:"mcp", agent, native_id, cwd, wait_hint}`, then call the methods in design section 10. Keep the connection alive for presence. `rpc.cancel {id}` is a notification cancelling a pending request; cancelled waiting reads do not dequeue the next message. This is local IPC, not a supported remote service.

## ZCode desktop

**Recommended: native plugin installation.** In an open workspace, use Settings → Plugins → Create → Add plugin marketplace and enter `njugray/cmdr#marketplace`. The generated release branch includes all bundles and license notices; users do not need npm installation or a local build. The maintainer must run the Publish marketplace workflow once before this source becomes available. Install cmdr and start a fresh session. Local development can use a built checkout or installed npm package root instead.

The native `.zcode-plugin/plugin.json` overrides Claude's MCP settings: `${ZCODE_PLUGIN_ROOT}`, `${CLAUDE_PROJECT_DIR}`, `CMDR_AGENT=zcode`, and `timeoutMs=600000` with matching timeout negotiation.

The shared hook file produces four runnable ZCode hooks: SessionStart, UserPromptSubmit, PreToolUse and Stop. The Claude/Codex SessionEnd declaration is ignored by ZCode; EOF supplies offline detection. `ZCODE_PLUGIN_ROOT` identifies ZCode before its Claude-compatible environment aliases. Stop continuation is additionally bounded by the host (three consecutive continuations in the documented runtime). The plugin does not register the same hook file twice.

ZCode expands plugin MCP server names to `plugin:cmdr:cmdr`; the tool matcher accepts the namespaced and sanitized forms. Its MCP configuration has no session context for template expansion, so cmdr obtains native identity from PreToolUse stamps rather than inserting `${ZCODE_SESSION_ID}` into plugin MCP configuration. The bridge supports multiple stamped sessions sharing a pooled MCP process.

**Manual MCP-only setup:** run `cmdr config --agent zcode`. Merge the generated `mcp.servers.cmdr` into `~/.zcode/cli/config.json` (user) or `<workspace>/.zcode/config.json` (workspace). Manual MCP-only setup has no plugin hooks or skills; use the generic identity/long-poll contract above. Do not configure both the plugin and a duplicate manual server.

ZCode also reads `.agents/mcp.json`, but native `.zcode` MCP definitions take precedence within a scope. Native user hooks require `hooks.enabled=true`; project-level hooks are ignored, so use the plugin for shared hooks. After changing hooks, open a new session.

Verified against **ZCode desktop 3.11.2 / bundled runtime 0.16.5**. Run:

```sh
npm run verify:zcode
# On another installation:
ZCODE_RUNTIME_PATH=/path/to/glm/zcode.cjs npm run verify:zcode
```

By default this command builds an npm tarball and tests its unpacked contents. An existing unpacked package root can be passed as `npm run verify:zcode -- /path/to/package`. The test invokes the actual desktop runtime's stdio app-server, validates and installs cmdr in an isolated workspace/storage directory, checks discovered components, and confirms a connected MCP server with nine tools. It makes no model calls and does not install into the user's normal plugin registry. GUI-driven model collaboration remains a separate manual check.

References checked 2026-09-08: [ZCode plugin format](https://zcode.z.ai/cn/docs/plugin), [MCP configuration](https://zcode.z.ai/cn/docs/mcp-services), [hook contracts](https://zcode.z.ai/cn/docs/hooks). Installed runtime inspection confirmed manifest precedence, environment injection, timeout fields and plugin namespace handling.

## Kimi Code desktop

**Recommended: standalone setup.**

```sh
npx -y --package=cmdr-mcp@latest cmdr setup --agent kimi-code
```

Setup writes the `cmdr` MCP server into `~/.kimi-code/mcp.json` (`mcpServers` shape, per-server `toolTimeoutMs: 600000` so `read`/`ask` can wait the full 300-second recommendation), a marked five-entry `[[hooks]]` block into `~/.kimi-code/config.toml` and links the `cmdr` and `cmdr-identity` skills into `~/.kimi-code/skills/`. `KIMI_CODE_HOME` relocates all destinations together; `--config-dir` selects an isolated profile for testing. `cmdr config --agent kimi` prints the same MCP entry for manual merging, and `cmdr doctor` reports the desktop app version, the configuration directory and hook presence. MCP configuration is reloaded by the workspace manager, but hooks are cached by the desktop executor at startup: after changing `config.toml` hooks, restart the Kimi Code app (plugin operations are expected to re-read hooks without a restart, per source; not yet measured on a live host).

The native `.kimi-plugin/plugin.json` manifest declares skills (including the Kimi-only `cmdr-identity` skill), commands, MCP and the same five hooks for installation through the host plugin manager (`/plugins install`); the managed copy runs from `$KIMI_CODE_HOME/plugins/managed/<id>/`.

Facts below are split by evidence class. Some were observed on a live **Kimi Code desktop 1.0.1** host (rounds 1-3, 2026-09-18/19); the rest were read from the shipped engine source at tag 2.0.0 (`1b89e4b0`).

**Observed on the live host:**

- Hooks written to `config.toml` need an app restart. `mcp.json` changes take effect without one: a restored `mcp.json` replaced the running MCP processes in place.
- Agent-level hook payloads (Stop, UserPromptSubmit, PreToolUse) carry the desktop bootstrap cwd `/`. SessionStart carries the workspace cwd, with `source=resume` for sessions restored at app start and `source=startup` for new ones.
- A per-server `toolTimeoutMs: 600000` holds long waits (`read(wait=75)` returned after 79.7s), so the 300-second recommendation is safe.
- Two sessions in one workspace share a single MCP process. With `_cmdr_session` stamps they still act as distinct members: in round 3, sessions A and B used one MCP process, and neither ever received a command addressed to the other.
- Per-call identity works on both paths:
  - A session that first ran `/skill:cmdr-identity` stamped its very first call with the rendered id.
  - A session without the skill was blocked once by PreToolUse (exit 2, correct id in the reason) and retried with the stamp.
- A session restored at app start sent SessionStart but bound nothing, which removes the round-2 misattribution.
- UserPromptSubmit stdout reaches the model. A typed message surfaced "1 unread" and the session read the message and reported. Activating a skill with `/skill:` does not fire UserPromptSubmit.
- A Stop exit 2 continued the turn once, and the session then handled the unread command.
- Archiving a session fired SessionEnd with `reason=archive` and took the member offline, while the shared MCP process kept serving the other session.
- The built-in watcher woke stamped sessions automatically, after 25s and 15s.

**From the engine source (kimi-code 2.0.0):**

- The shared MCP process is started per workspace from `mcp.json` (`workspaceMcpService.ts:58-70`, `:110-117`); the child environment carries no session id (`client-stdio.ts:191`, `:292-304`), and neither `initialize` nor `callTool` carries one (`client-stdio.ts:58-61`, `:122`). The MCP cwd is the workspace root.
- `${KIMI_SESSION_ID}` in a skill body is replaced with the real session id on every render path - user `/skill` activation, the model's Skill tool call, and the plugin `sessionStart.skill` injection (`registry.ts:60-70`, `:166-168`; `agentPluginService.ts:121-132`, `:246-255`). The `cmdr-identity` skill (plugin-only file, plus setup-linked user skill) carries the per-call stamping rules; the `sessionStart.skill` manifest field injects it into the **main agent only**, so the main agent makes cmdr calls on behalf of subagents with the same stamp. Slash-command rendering of the placeholder is unverified - the identity source is the skill, not the `/cmdr` command.
- A PreToolUse exit 2 turns into the tool call's error result carrying the stderr reason (`runHook.ts:140-151`; `beforeToolExecuteEvent.ts:19-21`), evaluated before permission approval; hooks cannot rewrite tool input (`runHook.ts:43-56`). The cmdr bridge independently rejects an unstamped kimi call with `SESSION_STAMP_REQUIRED` explaining the shared process and where to obtain the id.
- UserPromptSubmit exit-0 stdout becomes a user message in the model context (`agentExternalHooksService.ts:370-385`) and fires only on real user input, never on watcher-woken turns; SessionStart stdout is dropped by the host (#2873).
- A Stop exit 2 appends the reason as a user message and may continue the turn once (`stop_hook_active` is always false; `agentExternalHooksService.ts:235-260`, `:389-423`).
- SessionEnd fires only on archive/delete of a loaded session (and CLI `/reload` exit), not on tab close or app quit (`sessionLifecycleService.ts:414-474`); plugin install/enable/disable or reload re-reads hooks (`pluginService.ts:91-167`).
- Hooks are `[[hooks]]` tables (`event`, `matcher`, `command`, `timeout`); an unrecognized `event` fails the whole configuration load. All hook payloads carry the running session's `session_id` and `hook_event_name`. The five installed hooks:

  | Event            | Role                                                                                                                                                                                                                                 |
  | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | SessionStart     | Presence and restored-session tracking; for Kimi it is also the only hook whose cwd may update the session record (agent-level payloads carry `/`); never binds identity (startup restores would misidentify the shared MCP process) |
  | UserPromptSubmit | Unread-message reminder: exit 0 stdout becomes a user message in the model context; fires only on real user input, never on watcher-woken turns                                                                                      |
  | PreToolUse       | Verifies `_cmdr_session` on cmdr tools (matcher matches the tool-name regex in `src/shared/env.ts`); silent on match, exit 2 + reason naming the expected id otherwise                                                               |
  | Stop             | exit 2 + reason appends a user message and may continue the turn once; throttled per sequence                                                                                                                                        |
  | SessionEnd       | Presence only; fires on archive/delete of a loaded session (and CLI `/reload` exit)                                                                                                                                                  |

- **Wake** uses the same built-in watcher as ZCode: run `listener.arm.command` with Bash `run_in_background=true`; the watcher stays silent and exits on actionable work, and the completion notification starts the next turn. Re-arm after every completion, failure or kill.

**Migration.** Earlier manual Kimi setups that pinned `CMDR_SESSION_ID` in `mcp.json` must remove it: the workspace-pooled MCP would otherwise route every session to one fixed member. Rerun `cmdr setup --agent kimi-code` to obtain the stamping hooks and the identity skill.

The native plugin manifest carries no `CMDR_AGENT` binding: plugin hooks and the plugin MCP process are recognized as Kimi Code through the `KIMI_PLUGIN_ROOT` variable the host injects into plugin processes, so agent detection (and the exit-code-2 hook wrapper path) depends on that injection; the standalone setup path binds `CMDR_AGENT=kimi` in its launchers instead. Standalone setup and the native plugin are mutually exclusive — setup refuses to run while a managed `cmdr` plugin copy exists under `$KIMI_CODE_HOME/plugins/managed/`.

### Remaining real-host checks

Observed and source-verified semantics are above. Still open for live confirmation:

1. Watcher re-arm after a daemon restart.
2. Plugin install/enable reloading hooks without an app restart (expected from source; unconfirmed).
3. `${KIMI_SESSION_ID}` substitution through the plugin `sessionStart.skill` in newly created, resumed and compacted sessions. The `/skill:cmdr-identity` path is confirmed.
4. Whether slash-command files render `${KIMI_SESSION_ID}` (if they do, the identity paragraph can move into the `/cmdr` command too).

## Diagnostics and CLI members

See [Troubleshooting](troubleshooting.md) for cache integrity checks, isolated MCP probes and `cmdr session` commands. Member CLI uses protocol 1, `kind=mcp` and `transport=cli` registration. Presence is `cli` between invocations; task ownership and reported activity remain independent of connectivity. The daemon supports `admin.standby`, `admin.events` and `admin.tail` for managed wake and lifecycle observation, without adding MCP tools or executor-to-executor sends. See [long-running collaboration](long-running-collaboration.md). `_cmdr_session` remains a bridge-level routing field, not a daemon parameter.

## Automatic wake

Codex supports proxy and queue compatibility paths. Claude uses Monitor (or supported one-shot background Bash); ZCode and Kimi Code use background Bash completion notifications. Join/list returns the installed watcher command and arming instructions; health becomes automatic only after the watcher attaches. Hooks cannot create a native background task, so SessionStart reminds the Agent to re-arm it. Unknown MCP hosts remain manual. See [automatic standby](long-running-collaboration.md#automatic-standby).
