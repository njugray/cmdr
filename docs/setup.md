# Standalone setup

Available from cmdr-mcp 0.3.0. Requires macOS/Linux and Node.js >=22.5 (24 recommended).

```sh
npx -y --package=cmdr-mcp@latest cmdr setup --agent claude-code
```

Choose `claude-code`, `codex` or `zcode`. Setup installs a persistent runtime, the `cmdr` skill, MCP and user hooks, then checks the seven tools in temporary state. Use the printed CLI path (normally `~/.cmdr/bin/cmdr`), open a new host session and complete any trust prompts. Existing hook opt-outs are preserved. Other MCP hosts use `cmdr config --agent <host-id>`.

Before 0.3.0 is published, build the checkout and run `plugins/cmdr/bin/cmdr setup --agent …`, or use a locally packed tarball.

To install only the self-contained skill and its role/setup references:

```sh
npx skills add njugray/cmdr --skill cmdr
```

Add `-g` for global scope or `--agent <supported-agent>` to select a host. This installs no runtime or MCP configuration; use an existing cmdr integration or run setup. Choose setup or the native plugin for each host to avoid duplicate tools and hooks. Invoke the standalone skill through the host's skill interface or ask “use cmdr to join my-project”.

## Configuration

| Host | MCP configuration | User hooks | Skill |
| --- | --- | --- | --- |
| Claude Code (`claude-code`, alias `claude`) | `~/.claude.json` | `~/.claude/settings.json` | `~/.claude/skills/cmdr` |
| Codex | `$CODEX_HOME/config.toml`, default `~/.codex/config.toml` | `$CODEX_HOME/hooks.json` | `$CODEX_HOME/skills/cmdr` |
| ZCode | `~/.zcode/cli/config.json`, `mcp.servers` | Same file, `hooks.events` | `~/.zcode/skills/cmdr` |

| Option | Purpose |
| --- | --- |
| `--dry-run` | Preview destinations/conflicts without installing runtime or changing host configuration |
| `--json` | Return paths, changes, warnings and backup location as JSON |
| `--config-dir PATH` | Select a custom host **user** profile directory; launch the host with that same profile |

`CLAUDE_CONFIG_DIR` is respected; its MCP file is `<CLAUDE_CONFIG_DIR>/.claude.json`. ZCode loads user hooks, not workspace hooks. `CMDR_HOME` selects runtime/state storage (default `~/.cmdr`): build directories live in `runtimes/`, stable profile-specific launchers in `bin/`. They survive npx cache removal and bind the host/state directory, never a fixed session ID. See [host integration](agent-integration.md) for identity and lifecycle contracts.

## Upgrade and recovery

Repeat setup with the newer package to upgrade. Unchanged files stay unchanged; prior runtime directories remain available to existing processes. Setup does not restart the daemon. If it reports `UPGRADE_REQUIRED`, coordinate active work, run `<printed-cli> daemon restart`, then reconnect sessions.

Setup preserves other servers, settings and hooks. Codex retains unrelated TOML text/comments; JSON settings are reformatted without discarding other values. Malformed configuration, an enabled cmdr plugin, an unmanaged cmdr MCP entry or an unrelated skill named `cmdr` stops setup before host changes.

Existing copies/symlinks of this repository's skill are backed up and replaced with a link to the persistent runtime. Shared npx-skills sources are left intact; custom files in an adopted copy remain in its backup. Upgrade setup-managed skills through setup.

Backups live in `<CMDR_HOME>/setup-backups/<run>/`. `restore.json` maps each changed path to its backup (`null` marks a newly created entry). Failed writes are rolled back; concurrent edits are reported for manual recovery. After a crash, inspect that record before retrying. Remove a stale `setup.lock` only after confirming its recorded process has stopped.

For diagnostics, run `<printed-cli> doctor --deep`. Move a damaged runtime directory aside and rerun setup from an intact package. Native plugins require their own cache refresh. GUI trust, actual hook execution and automatic wake must be verified in the host; setup's isolated MCP check does not establish those capabilities.
