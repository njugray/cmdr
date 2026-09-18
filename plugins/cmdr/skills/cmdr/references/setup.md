# Setup and recovery

Requires macOS/Linux, Node.js >=22.5 and cmdr-mcp >=0.4.0. When installation or repair is requested, choose the actual host (`claude-code`, `codex`, `zcode` or `kimi-code`):

```sh
npx -y --package=cmdr-mcp@latest cmdr setup --agent claude-code
```

`--dry-run` previews changes. Repeat with a newer package to upgrade. Use the printed CLI path (normally `~/.cmdr/bin/cmdr`), complete host trust prompts and open a new session. Preserve explicit hook opt-outs. Resolve conflicting cmdr plugin/MCP installations before retrying; do not remove unrelated services.

Skills-only installation does not configure runtime/MCP. If that was all the user requested, explain the remaining setup. An existing healthy integration needs no duplicate installation. Other MCP hosts use `cmdr config --agent <actual-host-id>` with their supported configuration format.

For setup installs, run `<printed-cli> doctor --deep`. For native plugins, use `doctor --plugin-root <actual-cache> --deep`. Reinstall damaged runtimes from a complete package; source checkouts need `npm ci && npm run build`. Never borrow another installation's dist. Setup preserves active sessions; `UPGRADE_REQUIRED` needs an explicit `cmdr daemon restart` and host reconnection.

With an intact runtime but unavailable MCP, `cmdr session --help` describes the CLI fallback. Supply `--agent` and the host's real `--native-id`; never guess session IDs. Installation success does not establish host hook execution or automatic wake: use the reported listener health.
