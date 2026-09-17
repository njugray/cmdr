# Setup and recovery

Requires macOS/Linux and Node.js >=22.5 (24 recommended). Setup is available in cmdr-mcp >=0.3.0. When the user asks to install or repair cmdr, run the appropriate command for the actual host:

```sh
npx -y --package=cmdr-mcp@latest cmdr setup --agent claude-code
npx -y --package=cmdr-mcp@latest cmdr setup --agent codex
npx -y --package=cmdr-mcp@latest cmdr setup --agent zcode
```

Run only the selected host's command. `--dry-run` previews paths and conflicts. Setup persists its bundled runtime independently of npx's cache, installs this self-contained skill, merges MCP and hooks, and checks the seven tools in temporary daemon state. Repeating setup with a newer package upgrades the installed runtime. It preserves unrelated configuration, explicit hook opt-outs and host trust requirements. Existing enabled cmdr plugins or unmanaged cmdr MCP entries must be reconciled before standalone setup to avoid duplicates. Do not remove unrelated services or hooks.

After successful setup, use the absolute CLI path printed by setup (normally `~/.cmdr/bin/cmdr`), complete any host trust review, and open a new host session. Do not claim that the current session has reloaded tools, that hooks have executed, or that automatic wake works merely because setup succeeded. Codex wake support depends on the public shared app-server and the reported listener health; other hosts remain manual.

`npx skills add njugray/cmdr --skill cmdr` installs only this skill and its references. If the user requested only a skill installation, explain the remaining runtime/MCP setup rather than silently changing host configuration. A healthy existing cmdr integration needs no second installation.

For a different MCP host, install `cmdr-mcp`, run `cmdr config --agent <actual-host-id>`, and merge the output according to that host's supported configuration. Host IDs are open strings. Do not disguise an unknown host as Codex, Claude or ZCode to use an installer adapter.

For setup installations, run the printed CLI with `doctor --deep`; if necessary inspect the `runtime` path printed by setup using `doctor --plugin-root <runtime> --deep`. For native plugins, inspect the actual plugin cache instead. A damaged source checkout needs `npm ci && npm run build`; a damaged published installation needs a complete package. Never borrow another installation's dist files.

With an intact runtime but unavailable MCP, `cmdr session` is a fallback only when the host's real native ID is available. Supply `--agent` and `--native-id`; never guess IDs or read private host data to fabricate them. CLI presence is `cli` and does not mean execution stopped. Refer to `cmdr session --help` for arguments. Existing sessions and their unfinished tasks survive installation; daemon upgrades require an explicit `cmdr daemon restart` when reported as necessary.
