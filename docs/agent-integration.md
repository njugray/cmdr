# Agent integration

Build a source checkout with `npm ci && npm run build`, or use the unpacked/installed npm package. Git does not contain generated runtime bundles. `npm pack` / `npm publish` builds and includes them automatically.

The daemon and message model accept arbitrary lowercase Agent IDs (`[a-z][a-z0-9_-]{0,63}`), not a closed Claude/Codex enum. All hosts share the same seven MCP tools. Specialized adapters add identity, working-directory discovery and lifecycle reminders; none is required to use the queue.

From 0.3.0, `cmdr setup --agent claude-code|codex|zcode` installs a persistent runtime, a self-contained skill and user-level MCP/hooks without registering a native plugin. It preserves unrelated settings and verifies MCP in isolated state. See [standalone setup](setup.md) for configuration locations, repeat installs, backups and custom profiles. Choose one integration per host to avoid duplicate servers/hooks. `npx skills add njugray/cmdr --skill cmdr` installs only skill instructions and references.

## Other MCP hosts

```sh
/path/to/cmdr/plugins/cmdr/bin/cmdr config --agent my-agent
```

The output uses an absolute executable path and a conventional `mcpServers` object. Merge it into the host's MCP configuration, adapting the enclosing keys if that host uses another format. Do not overwrite other configured servers.

Environment contract:

| Variable | Meaning |
| --- | --- |
| `CMDR_AGENT` | Stable host identifier, e.g. `opencode`, `zcode`, `my-agent`; default `generic` when undetected |
| `CMDR_SESSION_ID` | Optional unique native session ID, stable across resume; never reuse one ID for concurrent independent sessions |
| `CMDR_CWD` | Optional actual session directory, useful when MCP launches in a plugin directory |
| `CMDR_SESSION_TITLE` | Optional session title for the board |
| `CMDR_TOOL_TIMEOUT_SEC` | The timeout **already configured on the host**; informs wait recommendations, does not change the host timeout |
| `CMDR_HOME` | Shared daemon/state directory; all participating sessions must use the same value |

Without a native session ID, the MCP process gets a random provisional identity and retains it across daemon reconnects. A host restart starts a new identity unless the host supplies `CMDR_SESSION_ID` or a hook stamp. `read(wait)` and `unread` remain functional without hooks. Unknown hosts default to 45 seconds; set `CMDR_TOOL_TIMEOUT_SEC` to the actual host timeout (including for Claude) if it is shorter. Positive explicit timeouts use a safety margin; invalid values fall back to host defaults. Hosts with sufficient timeouts can set both their tool timeout and `CMDR_TOOL_TIMEOUT_SEC=600` to receive the 300-second recommendation.

A host that shares one MCP process among multiple sessions **must pass `_cmdr_session` on every tool call** (preferably via a hook), or launch a separate MCP process for each session. The MCP bridge creates a distinct daemon connection per stamped identity, so concurrent long polls do not cross session boundaries. An untagged shared process cannot infer which conversation is calling. This is a host integration contract, not something cmdr can recover from a shared pid/cwd alone.

For hosts without a skill loader, use this instruction:

```text
Use cmdr join(squad_name="my-project"). If executor, report ready with cwd,
capabilities and context. Use read(wait=me.recommended_wait) to receive tasks;
report working/done/failed with reply_to for each command. Ask when blocked.
Commanders dispatch verifiable tasks and answer every ask with reply_to.
Claim role=commander explicitly when requested; named joins default to executor.
Use join(standby="auto") and check list for listener health. With a healthy
listener, end the idle turn; otherwise use at most two waits and explain manual
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

By default this command builds an npm tarball and tests its unpacked contents. An existing unpacked package root can be passed as `npm run verify:zcode -- /path/to/package`. The test invokes the actual desktop runtime's stdio app-server, validates and installs cmdr in an isolated workspace/storage directory, checks discovered components, and confirms a connected MCP server with seven tools. It makes no model calls and does not install into the user's normal plugin registry. GUI-driven model collaboration remains a separate manual check.

References checked 2026-09-08: [ZCode plugin format](https://zcode.z.ai/cn/docs/plugin), [MCP configuration](https://zcode.z.ai/cn/docs/mcp-services), [hook contracts](https://zcode.z.ai/cn/docs/hooks). Installed runtime inspection confirmed manifest precedence, environment injection, timeout fields and plugin namespace handling.

## Diagnostics and CLI members

See [Troubleshooting](troubleshooting.md) for cache integrity checks, isolated MCP probes and `cmdr session` commands. Member CLI uses protocol 1, `kind=mcp` and `transport=cli` registration. Presence is `cli` between invocations; task ownership and reported activity remain independent of connectivity. The daemon supports `admin.standby`, `admin.events` and `admin.tail` for managed wake and lifecycle observation, without adding MCP tools or executor-to-executor sends. See [long-running collaboration](long-running-collaboration.md). `_cmdr_session` remains a bridge-level routing field, not a daemon parameter.
