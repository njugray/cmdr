import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { paths } from '../shared/paths.js';
import { inspectInstallation, probeMcp } from './doctor.js';
import {
  checkPlugin,
  codexConfig,
  jsonConfig,
  kimiHooksConfig,
  mergeHooks,
  mergeJsonServer,
  shellQuote,
  type SetupHost,
} from './setup-config.js';
import { applyChanges, fileChange, skillChange, type SetupChange } from './setup-files.js';

function read(path: string) {
  try {
    return readFileSync(path, 'utf8');
  } catch (e: any) {
    if (e.code === 'ENOENT') return '';
    throw e;
  }
}
// Preserve symlinked dotfiles by editing their resolved destination.
function configPath(path: string) {
  return existsSync(path) ? realpathSync(path) : path;
}

function launcher(
  runtime: string,
  entry: string,
  state: string,
  agent?: SetupHost,
  codexHome?: string,
) {
  return `#!/bin/sh\n# Managed by cmdr setup (https://github.com/njugray/cmdr).\nexport CMDR_HOME=${shellQuote(state)}\n${agent ? `export CMDR_AGENT=${shellQuote(agent)}\n` : ''}${agent === 'codex' || agent === 'zcode' || agent === 'kimi' ? 'export CMDR_TOOL_TIMEOUT_SEC=600\n' : ''}${codexHome ? `export CODEX_HOME=${shellQuote(codexHome)}\n` : ''}exec ${shellQuote(join(runtime, 'bin', entry))} "$@"\n`;
}

export async function runSetup(argv: string[], sourceRoot: string) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      agent: { type: 'string' },
      'config-dir': { type: 'string' },
      'dry-run': { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      'cmdr setup --agent claude-code|codex|zcode|kimi-code [--config-dir PATH] [--dry-run] [--json]\nInstall or upgrade for the current user. CMDR_HOME selects runtime/state storage; --config-dir selects the host user profile.',
    );
    return;
  }
  const agent =
    values.agent === 'claude-code'
      ? 'claude'
      : values.agent === 'kimi-code'
        ? 'kimi'
        : values.agent;
  if (positionals.length || !agent || !['claude', 'codex', 'zcode', 'kimi'].includes(agent))
    throw new Error(
      'Use cmdr setup --agent claude-code|codex|zcode|kimi-code. Other MCP hosts can use cmdr config --agent HOST.',
    );
  const host = agent as SetupHost;
  const source = await inspectInstallation(sourceRoot);
  if (!source.ok)
    throw new Error(`The source installation is incomplete: ${(source.errors || []).join('; ')}`);
  const state = paths().home;
  const digest = createHash('sha256')
    .update(readFileSync(join(sourceRoot, 'dist/integrity.json')))
    .digest('hex')
    .slice(0, 16);
  const runtime = join(state, 'runtimes', `${source.version}-${digest}`);
  const bin = join(state, 'bin');
  const hostRoot = values['config-dir']
    ? resolve(values['config-dir'])
    : host === 'claude'
      ? resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'))
      : host === 'codex'
        ? resolve(process.env.CODEX_HOME || join(homedir(), '.codex'))
        : host === 'kimi'
          ? resolve(process.env.KIMI_CODE_HOME || join(homedir(), '.kimi-code'))
          : join(homedir(), '.zcode');
  // Independent host profiles may share daemon state, but must not overwrite
  // each other's launchers (especially their bound CODEX_HOME).
  const profile = createHash('sha256').update(hostRoot).digest('hex').slice(0, 12);
  const mcp = join(bin, `cmdr-mcp-${host}-${profile}`),
    hook = join(bin, `cmdr-hook-${host}-${profile}`);
  const changes: SetupChange[] = [];
  const warnings: string[] = [];
  // The host plugin manager copies enabled plugins to plugins/managed/<id>;
  // standalone setup must not add a second MCP server and hook set.
  if (host === 'kimi' && existsSync(join(hostRoot, 'plugins/managed/cmdr')))
    throw new Error(
      'The cmdr plugin is already enabled. Use its installation, or remove it before running standalone setup to avoid duplicate tools and hooks.',
    );
  const add = (change: SetupChange | undefined) => {
    if (change) changes.push(change);
  };
  const writeConfig = (path: string, config: unknown) =>
    add(fileChange(path, JSON.stringify(config, null, 2) + '\n'));
  let config: string;
  if (host === 'kimi') {
    config = configPath(join(hostRoot, 'mcp.json'));
    const servers = jsonConfig(read(config), config);
    mergeJsonServer(servers, mcp, 'kimi');
    writeConfig(config, servers);
    const hooksPath = configPath(join(hostRoot, 'config.toml'));
    add(fileChange(hooksPath, kimiHooksConfig(read(hooksPath), hook)));
  } else if (host === 'codex') {
    config = configPath(join(hostRoot, 'config.toml'));
    const merged = codexConfig(read(config), mcp);
    add(fileChange(config, merged.text));
    const hooksPath = configPath(join(hostRoot, 'hooks.json'));
    const hooks = jsonConfig(read(hooksPath), hooksPath);
    mergeHooks(hooks, hook, host);
    writeConfig(hooksPath, hooks);
    if (merged.hooksDisabled)
      warnings.push(
        'Codex hooks are explicitly disabled. Enable features.hooks in Codex to use identity stamps and lifecycle reminders.',
      );
    if (merged.serverDisabled)
      warnings.push('The existing cmdr MCP server remains disabled; enable it in Codex.');
  } else {
    const settingsPath = configPath(
      join(hostRoot, host === 'claude' ? 'settings.json' : 'cli/config.json'),
    );
    const settings = jsonConfig(read(settingsPath), settingsPath);
    checkPlugin(settings, host);
    // Claude keeps user MCP servers outside settings; ZCode uses the same file.
    config =
      host === 'claude'
        ? configPath(
            values['config-dir'] || process.env.CLAUDE_CONFIG_DIR
              ? join(hostRoot, '.claude.json')
              : join(homedir(), '.claude.json'),
          )
        : settingsPath;
    const servers = config === settingsPath ? settings : jsonConfig(read(config), config);
    mergeJsonServer(servers, mcp, host);
    if (mergeHooks(settings, hook, host))
      warnings.push(
        `${host} user hooks remain disabled; enable them in the host settings to use lifecycle reminders.`,
      );
    writeConfig(settingsPath, settings);
    if (config !== settingsPath) writeConfig(config, servers);
  }
  for (const [path, entry, boundHost] of [
    [join(bin, 'cmdr'), 'cmdr', undefined],
    [mcp, 'cmdr-mcp', host],
    [hook, 'cmdr-hook', host],
  ] as const) {
    const current = read(path);
    if (
      current &&
      !current.startsWith('#!/bin/sh\n# Managed by cmdr setup (https://github.com/njugray/cmdr).\n')
    )
      throw new Error(`Unmanaged executable at ${path}; move it before running setup.`);
    add(
      fileChange(
        path,
        launcher(runtime, entry, state, boundHost, boundHost === 'codex' ? hostRoot : undefined),
        0o755,
      ),
    );
  }
  const skill = join(hostRoot, 'skills/cmdr');
  add(skillChange(skill, join(runtime, 'skills/cmdr')));
  if (host === 'kimi')
    add(skillChange(join(hostRoot, 'skills/cmdr-identity'), join(runtime, 'kimi-identity')));
  const result = {
    agent: values.agent,
    version: source.version,
    runtime,
    cli: join(bin, 'cmdr'),
    config,
    skill,
    dry_run: !!values['dry-run'],
    changed: changes.map((change) => change.path),
    warnings,
    restart:
      host === 'kimi'
        ? 'Restart the Kimi Code app: it loads config.toml hooks only at startup.'
        : 'Start a new host session and review any hook trust prompts.',
  };
  const output = (extra: Record<string, unknown>) => {
    if (values.json) console.log(JSON.stringify({ ...result, ...extra }, null, 2));
    else {
      console.log(
        `${values['dry-run'] ? 'Setup preview' : 'Setup complete'}: cmdr ${source.version} for ${values.agent}\nRuntime: ${runtime}\nSkill: ${skill}\nConfig: ${config}\nCLI: ${join(bin, 'cmdr')}\n${changes.length} files/links ${values['dry-run'] ? 'would change' : 'changed'}.`,
      );
      if (extra.backup) console.log(`Backups: ${extra.backup}`);
      for (const warning of warnings) console.log(warning);
      console.log(result.restart);
    }
  };
  if (values['dry-run']) {
    output({});
    return;
  }
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const lock = join(state, 'setup.lock');
  try {
    writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  } catch (e: any) {
    if (e.code === 'EEXIST')
      throw new Error(
        `Another setup may be running. If it was interrupted, remove ${lock} after confirming that process has stopped, then retry.`,
      );
    throw e;
  }
  let staging: string | undefined;
  try {
    if (!existsSync(runtime)) {
      mkdirSync(join(state, 'runtimes'), { recursive: true, mode: 0o700 });
      staging = `${runtime}.tmp-${randomUUID()}`;
      cpSync(sourceRoot, staging, { recursive: true, dereference: false });
      const integrity = await inspectInstallation(staging);
      if (!integrity.ok) throw new Error('Copied runtime failed integrity verification.');
      renameSync(staging, runtime);
      staging = undefined;
    } else if (!(await inspectInstallation(runtime)).ok) {
      throw new Error(`Installed runtime is damaged: ${runtime}. Move it aside and rerun setup.`);
    }
    const probe = await probeMcp(runtime);
    if (!probe.ok)
      throw new Error(
        `MCP self-check failed: ${'error' in probe ? probe.error : 'unknown error'}. Host configuration was not changed.`,
      );
    const backup = applyChanges(changes, join(state, 'setup-backups'));
    output({ ok: true, backup, mcp: probe });
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
    rmSync(lock, { force: true });
  }
}
