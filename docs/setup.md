# Standalone setup and skills installation

`cmdr setup` is introduced in **0.3.0**. Until that version is published, use a built checkout (`npm ci && npm run build`, then `plugins/cmdr/bin/cmdr setup …`) or a locally packed tarball. The public `@latest` command requires a release containing setup; the GitHub skills command requires these skill files on the selected branch.

## Install

Requires macOS/Linux and Node.js >=22.5 (24 recommended). Run **one** command for the host you use:

```sh
npx -y --package=cmdr-mcp@latest cmdr setup --agent claude-code
npx -y --package=cmdr-mcp@latest cmdr setup --agent codex
npx -y --package=cmdr-mcp@latest cmdr setup --agent zcode
```

The explicit package and executable names are intentional: `cmdr-mcp` publishes multiple executables, while setup is a subcommand of `cmdr`.

Setup uses the runtime already bundled in the selected npm release, verifies its integrity, copies it to a persistent directory, and probes all seven MCP tools with temporary daemon state. It then installs the self-contained skill and merges the host's user MCP/hooks configuration. It does not need developer dependencies or a second network download after npx has obtained the package. It does not modify shell profiles; use the printed absolute CLI path, or add its directory to PATH yourself.

Start a new host session after setup. Complete any host trust review, including Codex hook trust. An isolated MCP probe proves the runtime works; it does not prove the host has reloaded configuration, run hooks, or enabled managed wake. Hook opt-outs remain unchanged and are reported. Automatic wake still depends on the host adapter and listener health; unsupported hosts remain manual.

## Paths and options

| Host | MCP configuration | User hooks | Skill |
| --- | --- | --- | --- |
| Claude Code (`claude-code`, alias `claude`) | `~/.claude.json` | `~/.claude/settings.json` | `~/.claude/skills/cmdr` |
| Codex (`codex`) | `$CODEX_HOME/config.toml`, default `~/.codex/config.toml` | `$CODEX_HOME/hooks.json` | `$CODEX_HOME/skills/cmdr` |
| ZCode (`zcode`) | `~/.zcode/cli/config.json`, `mcp.servers` | Same file, `hooks.events` | `~/.zcode/skills/cmdr` |

Claude's `CLAUDE_CONFIG_DIR` is respected; with an override, its user MCP file is `<CLAUDE_CONFIG_DIR>/.claude.json`. `--config-dir PATH` overrides the chosen host's user configuration directory, useful for a custom profile or isolated verification. It does not create a workspace-scoped setup. The host must be launched against that same profile; setting this option alone does not redirect the host. ZCode user hooks are not loaded from workspace configuration.

`CMDR_HOME` selects the shared state and installation directory (default `~/.cmdr`). Setup installs each build under `runtimes/<version>-<digest>` and creates stable launchers in `bin/`. Each host profile gets its own MCP/hook launchers, so profiles sharing daemon state do not overwrite each other's configuration binding. The launchers bind the chosen host identity and state directory; Codex also gets its chosen configuration directory. They never pin a host session ID. Hooks supply real session stamps where supported; per-process MCP identity remains provisional if no native identity is available. Do not reuse one fixed session ID across independent conversations.

```sh
# Preview destinations and conflicts; no runtime is installed or probed.
npx -y --package=cmdr-mcp@latest cmdr setup --agent codex --dry-run

# Machine-readable outcome, including changed paths, warnings and backups.
npx -y --package=cmdr-mcp@latest cmdr setup --agent codex --json
```

The existing launcher may cache the selected Node executable as part of normal CLI startup. Dry-run does not change host configuration or install a runtime.

Other MCP hosts continue to use `cmdr config --agent <host-id>` and their supported configuration format. The setup adapter list does not restrict protocol agent identifiers.

## Repeat, upgrade and recover

Run the same command with a newer npm version to upgrade. Identical setup does not duplicate hooks or rewrite unchanged files. Prior runtime directories remain available for existing processes and backup recovery. Setup never restarts or kills active sessions/daemons; if a running daemon reports `UPGRADE_REQUIRED`, explicitly run the printed CLI with `daemon restart` after coordinating active work, then reconnect host sessions.

Configuration edits preserve other servers, settings and hooks. Codex edits only its marked cmdr block and verifies that all other TOML values are unchanged, preserving their original text/comments. JSON settings are reformatted but retain unrelated values. Invalid configuration, an unmanaged `cmdr` MCP entry, an enabled cmdr plugin, or an unrelated skill named `cmdr` stops setup before host changes. Resolve just that conflict before retrying. Setup does not silently disable plugins or discard an existing MCP definition.

Existing copies/symlinks of this repository's `cmdr` skill can be adopted. They are backed up before replacement with a link to the persisted runtime skill; a shared npx-skills source is never edited through that link. Custom additions in an adopted copy remain in the backup. For a setup-managed installation, use setup to upgrade the skill and runtime together.

Changed files and replaced skill entries are backed up under `<CMDR_HOME>/setup-backups/<run>/`. Before each change, `restore.json` records its original path and backup (`null` means a newly created entry). On an ordinary write failure setup restores changes made in that run, unless another process edited the same path meanwhile; then it reports the paths requiring recovery. Backups may contain existing host credentials and remain inside a private directory. A machine crash can interrupt a multi-file change: inspect the backup and installation state before retrying. An interrupted run may leave `setup.lock`; remove it only after confirming the recorded process has stopped. Do not delete daemon/session data to repair installation.

Run `<printed-cli> doctor --deep` to inspect the persistent runtime. For a damaged runtime, move just the reported runtime directory aside and rerun setup from an intact release. Do not link another installation's `dist` into it. Native-plugin installations still use their own cache and update mechanism.

## Install only the skill with skills CLI

```sh
npx skills add njugray/cmdr --list
npx skills add njugray/cmdr --skill cmdr
```

Add `-g` for global skill scope or `--agent <supported-agent>` to select a host. The repository's plugin layout is discoverable without duplicating skills at the repository root. This command installs `SKILL.md` plus the skill's own references. It does **not** install the npm runtime, register MCP, run setup automatically, or install plugin commands/hooks. The skill guides initialization when the user requests it. An already-working plugin or manual MCP installation needs no duplicate server.

The three existing skill names remain compatible. The new `cmdr` entry contains both role protocols in its own directory, so standalone installation does not rely on separate role skills. Role reference files are the maintained source; the build refreshes the legacy role entries from them. Native plugin `/cmdr` commands remain available; standalone invocation uses the host's skill interface or a natural-language request such as “use cmdr to join my-project”.

Configuration contracts: [skills CLI](https://github.com/vercel-labs/skills#plugin-manifest-discovery), [Codex hooks](https://learn.chatgpt.com/docs/hooks), [Claude MCP scopes](https://code.claude.com/docs/en/mcp#mcp-installation-scopes), [Claude hooks](https://code.claude.com/docs/en/hooks), [ZCode user hooks](https://zcode.z.ai/en/docs/hooks), [ZCode MCP](https://zcode.z.ai/en/docs/mcp-services).
