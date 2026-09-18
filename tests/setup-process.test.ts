import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse } from 'smol-toml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { quickCall } from '../src/shared/client.js';

const run = promisify(execFile);
const plugin = resolve('plugins/cmdr');
const roots: string[] = [],
  clients: Client[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cmdr setup 'quoted'-"));
  roots.push(root);
  const state = join(root, 'state'),
    host = join(root, 'host');
  const env = { ...process.env, CMDR_HOME: state };
  const cli = (args: string[], source = plugin) =>
    run(
      process.execPath,
      [
        '--experimental-sqlite',
        '--disable-warning=ExperimentalWarning',
        join(source, 'dist/cli.mjs'),
        ...args,
      ],
      { env, timeout: 20000 },
    );
  return { root, state, host, env, cli };
}
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const root of roots.splice(0)) {
    for (const state of ['state', 'unrelated-state']) {
      try {
        await quickCall(
          'admin.shutdown',
          { reason: 'setup-test' },
          { home: join(root, state), timeout: 1000 },
        );
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 100));
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(['claude-code', 'codex', 'zcode', 'kimi-code'])(
  'installs %s from a disposable source, keeps user config and works after source removal',
  async (agent) => {
    const f = fixture(),
      source = join(f.root, 'npx-cache');
    cpSync(plugin, source, { recursive: true });
    mkdirSync(f.host, { recursive: true });
    const otherHook = { hooks: [{ type: 'command', command: 'echo existing' }] };
    if (agent === 'codex') {
      writeFileSync(
        join(f.host, 'config.toml'),
        '# Keep comments\nmodel = "user-model"\n[mcp_servers.other]\ncommand = "keep"\n',
      );
      writeFileSync(join(f.host, 'hooks.json'), JSON.stringify({ hooks: { Stop: [otherHook] } }));
    } else if (agent === 'claude-code') {
      writeFileSync(
        join(f.host, '.claude.json'),
        JSON.stringify({
          projects: { '/keep': { trusted: true } },
          mcpServers: { other: { command: 'keep' } },
        }),
      );
      writeFileSync(
        join(f.host, 'settings.json'),
        JSON.stringify({ permissions: { allow: ['Read'] }, hooks: { Stop: [otherHook] } }),
      );
    } else if (agent === 'kimi-code') {
      writeFileSync(
        join(f.host, 'config.toml'),
        'default_model = "user-model"\n\n[[hooks]]\nevent = "Stop"\ncommand = "echo existing"\ntimeout = 3\n',
      );
    } else {
      mkdirSync(join(f.host, 'cli'));
      writeFileSync(
        join(f.host, 'cli/config.json'),
        JSON.stringify({
          model: 'user-model',
          mcp: { servers: { other: { command: 'keep' } } },
          hooks: { enabled: true, events: { Stop: [otherHook] } },
        }),
      );
    }
    const args = ['setup', '--agent', agent, '--config-dir', f.host, '--json'];
    const preview = JSON.parse((await f.cli([...args, '--dry-run'], source)).stdout);
    expect(preview.dry_run).toBe(true);
    expect(existsSync(f.state)).toBe(false);
    const installed = JSON.parse((await f.cli(args, source)).stdout);
    expect(installed.ok).toBe(true);
    expect(installed.mcp.tools).toHaveLength(9);
    expect(installed.backup).toBeTruthy();
    expect(existsSync(join(f.state, 'cmdr.db'))).toBe(false);
    expect(readFileSync(join(installed.skill, 'references/setup.md'), 'utf8')).toContain(
      'cmdr setup',
    );
    const config =
      agent === 'codex'
        ? (parse(readFileSync(installed.config, 'utf8')) as any)
        : JSON.parse(readFileSync(installed.config, 'utf8'));
    const servers =
      agent === 'codex'
        ? config.mcp_servers
        : agent === 'zcode'
          ? config.mcp.servers
          : config.mcpServers;
    if (agent === 'kimi-code') {
      expect(servers.cmdr.toolTimeoutMs).toBe(600000);
      expect(servers.cmdr.env).toBeUndefined(); // the launcher binds CMDR_AGENT
    } else expect(servers.other.command).toBe('keep');
    const hookConfig =
      agent === 'codex'
        ? JSON.parse(readFileSync(join(f.host, 'hooks.json'), 'utf8'))
        : agent === 'claude-code'
          ? JSON.parse(readFileSync(join(f.host, 'settings.json'), 'utf8'))
          : agent === 'kimi-code'
            ? (parse(readFileSync(join(f.host, 'config.toml'), 'utf8')) as any)
            : config;
    if (agent === 'kimi-code') {
      expect(hookConfig.hooks[0]).toEqual({ event: 'Stop', command: 'echo existing', timeout: 3 });
      expect(
        hookConfig.hooks.filter((h: any) => /cmdr-hook/.test(h.command)).map((h: any) => h.event),
      ).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop', 'SessionEnd']);
      // The identity skill ships only to Kimi and renders ${KIMI_SESSION_ID}.
      const identity = readFileSync(
        join(installed.skill.replace(/cmdr$/, 'cmdr-identity'), 'SKILL.md'),
        'utf8',
      );
      expect(identity).toContain('${KIMI_SESSION_ID}');
      expect(identity).toContain('_cmdr_session');
    } else {
      const hooks = agent === 'zcode' ? hookConfig.hooks.events : hookConfig.hooks;
      expect(hooks.Stop[0]).toEqual(otherHook);
    }
    if (agent === 'claude-code') {
      expect(config.projects['/keep'].trusted).toBe(true);
      expect(hookConfig.permissions.allow).toEqual(['Read']);
    } else if (agent === 'kimi-code') {
      expect(hookConfig.default_model).toBe('user-model');
    } else expect(config.model).toBe('user-model');
    expect(lstatSync(installed.cli).mode & 0o111).not.toBe(0);
    const repeated = JSON.parse((await f.cli(args, source)).stdout);
    expect(repeated.changed).toEqual([]);
    expect(repeated.backup).toBeNull();
    rmSync(source, { recursive: true });
    expect((await run(installed.cli, ['--help'], { env: f.env })).stdout).toContain(
      'setup --agent',
    );
    const dashboard = JSON.parse(
      (await run(installed.cli, ['dashboard', '--no-open'], { env: f.env })).stdout,
    );
    expect((await fetch(new URL('/app.js', dashboard.url))).status).toBe(200);
    expect(dashboard.home).toBe(f.state);
    const client = new Client({ name: 'setup-test', version: '1' });
    const native = `setup-${agent}`;
    const env = {
      ...f.env,
      CMDR_AGENT: 'wrong',
      ...(agent === 'claude-code' ? { CMDR_SESSION_ID: native } : {}),
    } as Record<string, string>;
    if (agent !== 'claude-code') delete env.CMDR_SESSION_ID;
    await client.connect(
      new StdioClientTransport({
        command: servers.cmdr.command,
        args: servers.cmdr.args,
        env,
        stderr: 'pipe',
      }),
    );
    clients.push(client);
    expect((await client.listTools()).tools).toHaveLength(9);
    const expectedAgent =
      agent === 'claude-code' ? 'claude' : agent === 'kimi-code' ? 'kimi' : agent;
    let input: any = { squad_name: 'setup', standby: agent === 'codex' ? 'manual' : 'auto' };
    if (agent === 'zcode' || agent === 'codex') {
      const hooks = agent === 'zcode' ? hookConfig.hooks.events : hookConfig.hooks;
      const handler = hooks.PreToolUse.at(-1).hooks[0];
      const stamped = await new Promise<string>((resolve, reject) => {
        const child =
          agent === 'zcode'
            ? execFile(handler.command, handler.args, { env }, (error, out) =>
                error ? reject(error) : resolve(out),
              )
            : execFile('/bin/sh', ['-c', handler.command], { env }, (error, out) =>
                error ? reject(error) : resolve(out),
              );
        child.stdin!.end(
          JSON.stringify({ session_id: native, tool_name: 'mcp__cmdr__join', tool_input: input }),
        );
      });
      input = JSON.parse(stamped).hookSpecificOutput.updatedInput;
      expect(input._cmdr_session).toBe(native);
    }
    // Kimi pools one MCP process per workspace: unstamped calls are rejected
    // with instructions, and the model stamps every call with its session id.
    if (agent === 'kimi-code') {
      const rejected = await client.callTool({ name: 'list', arguments: {} });
      expect(rejected.isError).toBeTruthy();
      expect((rejected.content as any[])[0].text).toContain('SESSION_STAMP_REQUIRED');
      const preToolUse = hookConfig.hooks.find(
        (h: any) => h.event === 'PreToolUse' && /cmdr-hook/.test(h.command),
      );
      const stamp = async (tool_input: any) =>
        new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
          execFile('/bin/sh', ['-c', preToolUse.command], { env }, (error, stdout, stderr) =>
            error && (error as any).code !== 2
              ? reject(error)
              : resolve({ code: (error as any)?.code ?? 0, stdout, stderr }),
          ).stdin!.end(
            JSON.stringify({ session_id: native, tool_name: 'mcp__cmdr__join', tool_input }),
          );
        });
      expect(await stamp({ squad_name: 'setup' })).toMatchObject({
        code: 2,
        stdout: '',
      });
      expect((await stamp({ squad_name: 'setup' })).stderr).toContain(native);
      expect(await stamp({ squad_name: 'setup', _cmdr_session: native })).toEqual({
        code: 0,
        stdout: '',
        stderr: '',
      });
      input._cmdr_session = native;
    }
    const result = await client.callTool({ name: 'join', arguments: input });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse((result.content as any[])[0].text);
    if (agent === 'kimi-code') {
      // The stamped call binds the pooled connection to this session directly.
      expect(body.me.sid).toBe(`kimi:${native}`);
      expect(body.me.identity).toBe('confirmed');
    } else expect(body.me.sid).toBe(`${expectedAgent}:${native}`);
    let meSid = body.me.sid;
    let armCommand = body.me.listener?.arm?.command;
    if (agent === 'kimi-code') {
      // SessionStart registers hook presence but must not rebind the pooled
      // MCP connection (startup restores would hijack it).
      const sessionStart = hookConfig.hooks.find(
        (h: any) => h.event === 'SessionStart' && /cmdr-hook/.test(h.command),
      );
      await new Promise<void>((resolve, reject) => {
        const child = execFile('/bin/sh', ['-c', sessionStart.command], { env }, (error) =>
          error ? reject(error) : resolve(),
        );
        child.stdin!.end(
          JSON.stringify({
            session_id: native,
            cwd: process.cwd(),
            hook_event_name: 'SessionStart',
            source: 'startup',
          }),
        );
      });
      await run(installed.cli, ['standby', 'start', '--session', `kimi:${native}`], {
        env: { ...f.env, CMDR_AGENT: '', CMDR_SESSION_ID: '' },
        timeout: 10000,
      });
      const listed = JSON.parse(
        (
          (await client.callTool({ name: 'list', arguments: { _cmdr_session: native } }))
            .content as any[]
        )[0].text,
      );
      meSid = listed.me.sid;
      armCommand = listed.me.listener?.arm?.command;
      expect(meSid).toBe(`kimi:${native}`);
      expect(listed.me.identity).toBe('confirmed');
      expect(listed.me.listener.wake_mode).toBe('kimi');
    }
    if (agent !== 'codex') {
      const commander = async (action: string, input: object) =>
        JSON.parse(
          (
            await run(
              installed.cli,
              [
                'session',
                action,
                '--agent',
                'custom',
                '--native-id',
                'commander',
                '--input',
                JSON.stringify(input),
              ],
              { env: { ...f.env, CMDR_AGENT: '', CMDR_SESSION_ID: '' }, timeout: 10000 },
            )
          ).stdout,
        );
      await commander('join', { squad_name: 'setup', role: 'commander' });
      const {
        ids: [id],
      } = await commander('send', {
        to: meSid,
        message: 'private setup task',
      });
      // Execute exactly what the host receives, without the MCP launcher's state.
      const { stdout } = await run('/bin/sh', ['-c', `${armCommand} --once`], {
        env: { ...f.env, CMDR_HOME: join(f.root, 'unrelated-state') },
        timeout: 10000,
      });
      expect(JSON.parse(stdout).messages).toEqual(
        expect.arrayContaining([expect.objectContaining({ id })]),
      );
      expect(stdout).not.toContain('private setup task');
      expect(existsSync(join(f.root, 'unrelated-state'))).toBe(false);
      const unread = await client.callTool({
        name: 'read',
        arguments: {
          peek: true,
          ...(agent === 'zcode' || agent === 'kimi-code' ? { _cmdr_session: native } : {}),
        },
      });
      expect(JSON.parse((unread.content as any[])[0].text).messages).toEqual(
        expect.arrayContaining([expect.objectContaining({ id })]),
      );
    }
  },
  30000,
);

it('upgrades a persisted build and skill without changing stable hook commands or deleting the prior runtime', async () => {
  const f = fixture(),
    source = join(f.root, 'upgrade-source');
  const args = ['setup', '--agent', 'codex', '--config-dir', f.host, '--json'];
  const first = JSON.parse((await f.cli(args)).stdout);
  const hooks = readFileSync(join(f.host, 'hooks.json'), 'utf8');
  cpSync(plugin, source, { recursive: true });
  const path = 'skills/cmdr/references/executor.md';
  writeFileSync(
    join(source, path),
    readFileSync(join(source, path), 'utf8') + '\nUpgrade fixture.\n',
  );
  const manifest = JSON.parse(readFileSync(join(source, 'dist/integrity.json'), 'utf8'));
  manifest.files[path] = createHash('sha256')
    .update(readFileSync(join(source, path)))
    .digest('hex');
  writeFileSync(join(source, 'dist/integrity.json'), JSON.stringify(manifest));
  const second = JSON.parse((await f.cli(args, source)).stdout);
  expect(second.runtime).not.toBe(first.runtime);
  expect(existsSync(first.runtime)).toBe(true);
  expect(readlinkSync(first.skill)).toBe(join(second.runtime, 'skills/cmdr'));
  expect(readFileSync(join(first.skill, 'references/executor.md'), 'utf8')).toContain(
    'Upgrade fixture.',
  );
  expect(readFileSync(join(f.host, 'hooks.json'), 'utf8')).toBe(hooks);
  expect(second.changed).not.toContain(first.config);
}, 30000);

it('leaves host config untouched on malformed input, an incomplete source or an installation conflict', async () => {
  const f = fixture();
  mkdirSync(f.host);
  const path = join(f.host, 'settings.json');
  writeFileSync(path, '{ invalid');
  const args = ['setup', '--agent', 'claude-code', '--config-dir', f.host];
  await expect(f.cli(args)).rejects.toMatchObject({
    stderr: expect.stringContaining('Cannot parse'),
  });
  expect(readFileSync(path, 'utf8')).toBe('{ invalid');
  expect(existsSync(f.state)).toBe(false);
  writeFileSync(path, JSON.stringify({ enabledPlugins: { 'cmdr@cmdr': true } }));
  await expect(f.cli(args)).rejects.toMatchObject({
    stderr: expect.stringContaining('already enabled'),
  });
  expect(existsSync(join(f.host, '.claude.json'))).toBe(false);
  const source = join(f.root, 'damaged');
  cpSync(plugin, source, { recursive: true });
  rmSync(join(source, 'dist/mcp.mjs'));
  await expect(f.cli(args, source)).rejects.toMatchObject({
    stderr: expect.stringContaining('incomplete'),
  });
  expect(readdirSync(f.host)).toEqual(['settings.json']);
});

it('keeps launchers for separate Codex profiles independent when they share daemon state', async () => {
  const f = fixture();
  const first = JSON.parse(
    (await f.cli(['setup', '--agent', 'codex', '--config-dir', f.host, '--json'])).stdout,
  );
  const firstServer = (parse(readFileSync(first.config, 'utf8')) as any).mcp_servers.cmdr;
  const original = readFileSync(firstServer.command, 'utf8');
  const otherProfile = join(f.root, 'other-profile');
  const second = JSON.parse(
    (await f.cli(['setup', '--agent', 'codex', '--config-dir', otherProfile, '--json'])).stdout,
  );
  const secondServer = (parse(readFileSync(second.config, 'utf8')) as any).mcp_servers.cmdr;
  expect(firstServer.command).not.toBe(secondServer.command);
  expect(readFileSync(firstServer.command, 'utf8')).toBe(original);
  expect(readFileSync(secondServer.command, 'utf8')).toContain('other-profile');
}, 20000);
