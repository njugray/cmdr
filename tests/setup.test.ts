import { afterEach, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  lstatSync,
  symlinkSync,
  readlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'smol-toml';
import {
  codexConfig,
  jsonConfig,
  kimiHooksConfig,
  mergeHooks,
  mergeJsonServer,
  checkPlugin,
} from '../src/cli/setup-config.js';
import { applyChanges, fileChange, skillChange } from '../src/cli/setup-files.js';

const temporary: string[] = [];
function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'cmdr-setup-unit-'));
  temporary.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('preserves Codex values, comments and quoted keys while installing and updating one server', () => {
  const original =
    '# personal preferences\nmodel = "custom-model"\n[features]\nhooks = false\n[mcp_servers."other.server"]\ncommand = "/opt/a b/tool" # keep this comment\nenv = { TOKEN = "opaque" }\n';
  const first = codexConfig(original, '/some user/bin/mcp');
  expect(first.text.startsWith(original)).toBe(true);
  expect(first.hooksDisabled).toBe(true);
  expect(codexConfig(first.text, '/some user/bin/mcp').text).toBe(first.text);
  const edited = first.text.replace(
    'tool_timeout_sec = 600',
    'tool_timeout_sec = 30\nenabled = false',
  );
  const updated = codexConfig(edited, '/some user/bin/mcp');
  expect(updated.serverDisabled).toBe(true);
  const config = parse(updated.text) as any;
  expect(config.mcp_servers.cmdr.tool_timeout_sec).toBe(600);
  delete config.mcp_servers.cmdr;
  expect(config).toEqual(parse(original));
});

it('rejects malformed, conflicting or deceptively placed TOML markers without rewriting configuration', () => {
  expect(() => codexConfig('invalid = [', '/cmdr')).toThrow('Cannot parse');
  expect(() => codexConfig('[mcp_servers.cmdr]\ncommand = "/other"', '/cmdr')).toThrow('unmanaged');
  expect(() => codexConfig('note = "# BEGIN cmdr setup and # END cmdr setup"', '/cmdr')).toThrow(
    'Cannot safely merge',
  );
  expect(() =>
    codexConfig('# BEGIN cmdr setup\nmodel = "keep"\n# END cmdr setup\n', '/cmdr'),
  ).toThrow('Cannot safely merge');
  expect(() => codexConfig('mcp_servers = { other = { command = "keep" } }', '/cmdr')).toThrow(
    'Cannot safely merge',
  );
});

it('merges JSON MCP config without losing other servers or per-server customizations', () => {
  const config = {
    custom: 1,
    mcpServers: { other: { command: 'other', env: { KEY: 'keep' } } },
  } as any;
  mergeJsonServer(config, '/cmdr', 'claude');
  config.mcpServers.cmdr.env = { CUSTOM: 'keep' };
  mergeJsonServer(config, '/cmdr', 'claude');
  expect(config.mcpServers.other).toEqual({ command: 'other', env: { KEY: 'keep' } });
  expect(config.mcpServers.cmdr.env.CUSTOM).toBe('keep');
  expect(config.custom).toBe(1);
  expect(() => mergeJsonServer(config, '/different', 'claude')).toThrow('unmanaged');
  expect(() => jsonConfig('[]', 'settings')).toThrow('Cannot parse');
});

it.each(['claude', 'codex', 'zcode'] as const)(
  'keeps unrelated %s hooks and avoids duplicate cmdr handlers on rerun',
  (host) => {
    const other = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo other' }] };
    const config = (
      host === 'zcode'
        ? { hooks: { enabled: false, timeoutMs: 12000, events: { PreToolUse: [other] } } }
        : { disableAllHooks: true, hooks: { PreToolUse: [other] } }
    ) as any;
    expect(mergeHooks(config, "/a user's/cmdr-hook", host)).toBe(true);
    const once = JSON.stringify(config);
    mergeHooks(config, "/a user's/cmdr-hook", host);
    expect(JSON.stringify(config)).toBe(once);
    const hooks = host === 'zcode' ? config.hooks.events : config.hooks;
    expect(hooks.PreToolUse[0]).toEqual(other);
    expect(hooks.PreToolUse).toHaveLength(2);
    expect(Object.keys(hooks)).toHaveLength(host === 'zcode' ? 4 : 5);
    if (host === 'zcode') expect(config.hooks.enabled).toBe(false);
    else expect(config.disableAllHooks).toBe(true);
  },
);

it('merges Kimi Code mcp.json with the native tool timeout and preserves other servers', () => {
  const config = {
    custom: 1,
    mcpServers: { other: { command: 'other', env: { KEY: 'keep' } } },
  } as any;
  mergeJsonServer(config, '/cmdr', 'kimi');
  expect(config.mcpServers.cmdr).toEqual({
    command: '/cmdr',
    args: [],
    type: 'stdio',
    toolTimeoutMs: 600000,
  });
  expect(config.mcpServers.other).toEqual({ command: 'other', env: { KEY: 'keep' } });
  expect(config.custom).toBe(1);
  expect(() =>
    mergeJsonServer({ mcpServers: { cmdr: { command: '/different' } } } as any, '/cmdr', 'kimi'),
  ).toThrow('unmanaged');
});

const KIMI_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'StopFailure',
  'SessionEnd',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PostToolUseFailure',
  'Notification',
];

it('installs only documented Kimi Code hooks, preserves content and stays idempotent', () => {
  const original =
    'default_model = "user-model"\n\n[[hooks]]\nevent = "Stop"\ncommand = "echo user"\ntimeout = 3\n';
  const first = kimiHooksConfig(original, "/a user's/cmdr-hook");
  expect(first.startsWith(original)).toBe(true);
  expect(kimiHooksConfig(first, "/a user's/cmdr-hook")).toBe(first);
  const parsed = parse(first) as any;
  expect(parsed.default_model).toBe('user-model');
  expect(parsed.hooks).toHaveLength(6);
  expect(parsed.hooks[0]).toEqual({ event: 'Stop', command: 'echo user', timeout: 3 });
  for (const hook of parsed.hooks) expect(KIMI_EVENTS).toContain(hook.event);
  const block = parsed.hooks.slice(-5);
  expect(block.map((hook: any) => hook.event)).toEqual([
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'Stop',
    'SessionEnd',
  ]);
  expect(block.map((hook: any) => hook.timeout)).toEqual([5, 5, 5, 5, 1]);
  for (const hook of block) expect(hook.command.startsWith("'")).toBe(true);
  for (const hook of block)
    expect(Object.keys(hook).sort()).toEqual(
      ['command', 'event', 'matcher', 'timeout']
        .filter((key) => key !== 'matcher' || hook.event === 'PreToolUse')
        .sort(),
    );
  const preToolUse = block.find((hook: any) => hook.event === 'PreToolUse');
  expect(new RegExp(preToolUse.matcher).test('mcp__cmdr__join')).toBe(true);
  expect(new RegExp(preToolUse.matcher).test('mcp__other__join')).toBe(false);
});

it('rejects malformed Kimi Code config and deceptive markers without rewriting it', () => {
  expect(() => kimiHooksConfig('invalid = [', '/cmdr')).toThrow('Cannot parse');
  expect(() =>
    kimiHooksConfig('note = "# BEGIN cmdr setup and # END cmdr setup"', '/cmdr'),
  ).toThrow('Cannot safely merge');
  expect(() =>
    kimiHooksConfig('# BEGIN cmdr setup\nmodel = "keep"\n# END cmdr setup\n', '/cmdr'),
  ).toThrow('Cannot safely merge');
  expect(() => kimiHooksConfig('hooks = 3\n', '/cmdr')).toThrow(
    'hooks must be an array of [[hooks]] tables.',
  );
});

it('ships a Kimi Code plugin manifest in sync with the package version', () => {
  const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
  const manifest = JSON.parse(
    readFileSync(resolve('plugins/cmdr/.kimi-plugin/plugin.json'), 'utf8'),
  );
  expect(manifest.name).toBe('cmdr');
  expect(manifest.version).toBe(pkg.version);
  expect(manifest.skills).toEqual(['./skills/', './kimi-identity/']);
  expect(manifest.sessionStart).toEqual({ skill: 'cmdr-identity' });
  expect(manifest.mcpServers.cmdr).toMatchObject({
    command: './bin/cmdr-mcp',
    toolTimeoutMs: 600000,
    env: { CMDR_AGENT: 'kimi', CMDR_TOOL_TIMEOUT_SEC: '600' },
  });
  expect(manifest.hooks.map((hook: any) => hook.event)).toEqual([
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'Stop',
    'SessionEnd',
  ]);
  for (const hook of manifest.hooks)
    expect(Object.keys(hook).sort()).toEqual(
      ['command', 'event', 'matcher', 'timeout']
        .filter((key) => key !== 'matcher' || hook.event === 'PreToolUse')
        .sort(),
    );
});

it('does not configure a duplicate native plugin installation', () => {
  expect(() => checkPlugin({ plugins: { 'cmdr@cmdr': { enabled: true } } }, 'codex')).toThrow(
    'already enabled',
  );
  expect(() => checkPlugin({ enabledPlugins: { 'cmdr@custom': true } }, 'claude')).toThrow(
    'already enabled',
  );
  expect(() => checkPlugin({ plugins: { enabledPlugins: { cmdr: true } } }, 'zcode')).toThrow(
    'already enabled',
  );
  expect(() =>
    checkPlugin({ plugins: { 'cmdr@cmdr': { enabled: false } } }, 'codex'),
  ).not.toThrow();
});

it('backs up existing configuration and restores it if a later installation write fails', () => {
  const dir = directory(),
    first = join(dir, 'settings.json');
  writeFileSync(first, 'original', { mode: 0o600 });
  expect(() =>
    applyChanges(
      [fileChange(first, 'changed')!, { path: join(dir, 'bad-link'), before: null, link: '\0' }],
      join(dir, 'backups'),
    ),
  ).toThrow();
  expect(readFileSync(first, 'utf8')).toBe('original');
  expect(lstatSync(first).mode & 0o777).toBe(0o600);
  expect(existsSync(join(dir, 'bad-link'))).toBe(false);
});

it('detects concurrent edits before modifying any files', () => {
  const dir = directory(),
    target = join(dir, 'config');
  writeFileSync(target, 'original');
  const change = fileChange(target, 'setup')!;
  writeFileSync(target, 'user edit');
  expect(() => applyChanges([change], join(dir, 'backups'))).toThrow('changed during setup');
  expect(readFileSync(target, 'utf8')).toBe('user edit');
  expect(existsSync(join(dir, 'backups'))).toBe(false);
});

it('adopts an npx-skills copy with a backup and restores its contents on failure', () => {
  const dir = directory(),
    skill = join(dir, 'skill');
  mkdirSync(skill);
  const text = '---\nname: cmdr\nmetadata:\n  source: https://github.com/njugray/cmdr\n---\n';
  writeFileSync(join(skill, 'SKILL.md'), text);
  writeFileSync(join(skill, 'custom.md'), 'user notes');
  expect(() =>
    applyChanges(
      [
        skillChange(skill, join(dir, 'runtime'))!,
        { path: join(dir, 'bad-link'), before: null, link: '\0' },
      ],
      join(dir, 'backups'),
    ),
  ).toThrow();
  expect(lstatSync(skill).isDirectory()).toBe(true);
  expect(readFileSync(join(skill, 'custom.md'), 'utf8')).toBe('user notes');
  const backup = applyChanges([skillChange(skill, join(dir, 'runtime'))!], join(dir, 'backups'));
  expect(readlinkSync(skill)).toBe(join(dir, 'runtime'));
  const restore = JSON.parse(readFileSync(join(backup!, 'restore.json'), 'utf8'));
  expect(readFileSync(join(restore[0].backup, 'custom.md'), 'utf8')).toBe('user notes');
});

it('does not write through an npx-skills symlink or replace an unrelated skill', () => {
  const dir = directory(),
    canonical = join(dir, 'canonical'),
    skill = join(dir, 'skill');
  mkdirSync(canonical);
  writeFileSync(
    join(canonical, 'SKILL.md'),
    '---\nname: cmdr\nmetadata:\n  source: https://github.com/njugray/cmdr\n---\n',
  );
  symlinkSync(canonical, skill);
  applyChanges([skillChange(skill, join(dir, 'runtime'))!], join(dir, 'backups'));
  expect(existsSync(join(canonical, 'SKILL.md'))).toBe(true);
  writeFileSync(join(canonical, 'SKILL.md'), '---\nname: cmdr\n---\nUnrelated skill');
  expect(() => skillChange(canonical, join(dir, 'runtime'))).toThrow('unrelated');
});
