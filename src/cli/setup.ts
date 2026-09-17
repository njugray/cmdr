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
  return `#!/bin/sh\n# Managed by cmdr setup (https://github.com/njugray/cmdr).\nexport CMDR_HOME=${shellQuote(state)}\n${agent ? `export CMDR_AGENT=${shellQuote(agent)}\n` : ''}${agent === 'codex' || agent === 'zcode' ? 'export CMDR_TOOL_TIMEOUT_SEC=600\n' : ''}${codexHome ? `export CODEX_HOME=${shellQuote(codexHome)}\n` : ''}exec ${shellQuote(join(runtime, 'bin', entry))} "$@"\n`;
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
      'cmdr setup --agent claude-code|codex|zcode [--config-dir PATH] [--dry-run] [--json]\nInstalls this bundled release for the current user. Existing unrelated configuration is preserved. Repeat to upgrade. CMDR_HOME selects the persistent runtime/state directory. --config-dir overrides the host user configuration directory (not a project scope).',
    );
    return;
  }
  const agent = values.agent === 'claude-code' ? 'claude' : values.agent;
  if (positionals.length || !agent || !['claude', 'codex', 'zcode'].includes(agent))
    throw new Error(
      'Use cmdr setup --agent claude-code|codex|zcode. Other MCP hosts can use cmdr config --agent HOST.',
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
        : join(homedir(), '.zcode');
  // Independent host profiles may share daemon state, but must not overwrite
  // each other's launchers (especially their bound CODEX_HOME).
  const profile = createHash('sha256').update(hostRoot).digest('hex').slice(0, 12);
  const mcp = join(bin, `cmdr-mcp-${host}-${profile}`),
    hook = join(bin, `cmdr-hook-${host}-${profile}`);
  const changes: SetupChange[] = [];
  const warnings: string[] = [];
  const add = (change: SetupChange | undefined) => {
    if (change) changes.push(change);
  };
  const writeConfig = (path: string, config: unknown) =>
    add(fileChange(path, JSON.stringify(config, null, 2) + '\n'));
  let config: string;
  if (host === 'codex') {
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
    warnings.push(
      'Review and trust the cmdr hooks in Codex when prompted. Setup does not change hook trust.',
    );
  } else if (host === 'claude') {
    // CLAUDE_CONFIG_DIR relocates both settings and the user MCP config.
    config = configPath(
      values['config-dir'] || process.env.CLAUDE_CONFIG_DIR
        ? join(hostRoot, '.claude.json')
        : join(homedir(), '.claude.json'),
    );
    const settingsPath = configPath(join(hostRoot, 'settings.json'));
    const settings = jsonConfig(read(settingsPath), settingsPath);
    checkPlugin(settings, host);
    const servers = jsonConfig(read(config), config);
    mergeJsonServer(servers, mcp, host);
    writeConfig(config, servers);
    if (mergeHooks(settings, hook, host))
      warnings.push('Claude Code hooks are explicitly disabled; that preference was preserved.');
    writeConfig(settingsPath, settings);
  } else {
    config = configPath(join(hostRoot, 'cli/config.json'));
    const settings = jsonConfig(read(config), config);
    checkPlugin(settings, host);
    mergeJsonServer(settings, mcp, host);
    if (mergeHooks(settings, hook, host))
      warnings.push(
        'ZCode user hooks are explicitly disabled; enable hooks.enabled to use identity stamps and reminders.',
      );
    writeConfig(config, settings);
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
      'Start a new host session after setup. Automatic wake is available only where the host adapter reports a healthy managed listener.',
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
