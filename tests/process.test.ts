import { afterEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, rmSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { build } from 'esbuild';
import { promisify } from 'node:util';
import { connect } from 'node:net';
import { quickCall } from '../src/shared/client.js';
import { paths } from '../src/shared/paths.js';
import { Rpc } from '../src/shared/rpc.js';
const run = promisify(execFile),
  clients: Client[] = [];
let home: string;
const cli = resolve('plugins/cmdr/bin/cmdr');
function env(extra: Record<string, string> = {}) {
  return { ...process.env, CMDR_HOME: home, CMDR_AGENT: 'generic', ...extra } as Record<
    string,
    string
  >;
}
async function host(agent: string, native?: string) {
  const client = new Client({ name: 'cmdr-test-host', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: resolve('plugins/cmdr/bin/cmdr-mcp'),
    env: env({ CMDR_AGENT: agent, ...(native ? { CMDR_SESSION_ID: native } : {}) }),
    stderr: 'pipe',
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}
async function tool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as any[])[0].text;
  if (result.isError) throw new Error(text);
  return JSON.parse(text);
}
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  if (home) {
    try {
      await quickCall('admin.shutdown', { reason: 'test' }, { home, timeout: 1000 });
    } catch {
      /* not started */
    }
    await new Promise((r) => setTimeout(r, 100));
    rmSync(home, { recursive: true, force: true });
  }
});
it('bundled MCP processes start one daemon, exchange messages, reconnect and retain queues', async () => {
  home = mkdtempSync(join(tmpdir(), 'cmdr-process-'));
  const [c, e] = await Promise.all([host('claude', 'c'), host('zcode', 'e')]);
  expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual([
    'ask',
    'join',
    'leave',
    'list',
    'read',
    'report',
    'send',
  ]);
  const q = await tool(c, 'join', { squad_name: 'Processes' });
  await tool(e, 'join', { role: 'executor', squad: q.squad.id, name: 'tests' });
  await tool(e, 'report', { status: 'ready', message: 'ready' });
  await tool(c, 'read');
  const pending = tool(e, 'read', { wait: 5 });
  await tool(c, 'send', { to: 'tests', message: 'command' });
  expect((await pending).messages[0].body).toBe('command');
  const asking = tool(e, 'ask', { question: 'suite?', wait: 5 });
  const question = (await tool(c, 'read', { wait: 5 })).messages[0];
  await tool(c, 'send', { to: 'tests', type: 'answer', reply_to: question.id, message: 'all' });
  expect((await asking).answer.body).toBe('all');
  await tool(c, 'send', { to: 'tests', message: 'survives restart' });
  const before = JSON.parse(readFileSync(paths(home).info, 'utf8')).pid;
  await run(cli, ['daemon', 'restart'], { env: env() });
  const after = JSON.parse(readFileSync(paths(home).info, 'utf8')).pid;
  expect(after).not.toBe(before);
  expect((await tool(e, 'read')).messages[0].body).toBe('survives restart');
  expect((await tool(c, 'list')).me.role).toBe('commander');
  expect(statSync(home).mode & 0o777).toBe(0o700);
  expect(statSync(paths(home).socket).mode & 0o777).toBe(0o600);
}, 20000);
it('isolates two ZCode sessions sharing a single MCP process', async () => {
  home = mkdtempSync(join(tmpdir(), 'cmdr-multiplex-'));
  const shared = await host('zcode');
  const a = await tool(shared, 'join', { squad_name: 'Shared', _cmdr_session: 'a' });
  const b = await tool(shared, 'join', { squad_name: 'Shared', _cmdr_session: 'b' });
  expect(a.me.sid).toBe('zcode:a');
  expect(b.me.sid).toBe('zcode:b');
  expect(b.me.role).toBe('executor');
  const pending = tool(shared, 'read', { wait: 5, _cmdr_session: 'b' });
  await tool(shared, 'send', { to: 'all', message: 'for B', _cmdr_session: 'a' });
  const read = await pending;
  expect(read.me.sid).toBe('zcode:b');
  expect(read.messages[0].to_sid).toBe('zcode:b');
  expect(
    (await tool(shared, 'read', { _cmdr_session: 'a' })).messages.every(
      (m: any) => m.body !== 'for B',
    ),
  ).toBe(true);
}, 10000);
it('runs hooks fail-open and stamps the installed ZCode tool namespace', async () => {
  home = mkdtempSync(join(tmpdir(), 'cmdr-hook-'));
  const hook = resolve('plugins/cmdr/bin/cmdr-hook');
  async function invoke(event: string, input: any, extra = {}) {
    return new Promise<string>((resolve, reject) => {
      const child = execFile(hook, [event], { env: env(extra) }, (error, stdout) =>
        error ? reject(error) : resolve(stdout),
      );
      child.stdin!.end(JSON.stringify(input));
    });
  }
  const stamp = JSON.parse(
    await invoke(
      'PreToolUse',
      {
        session_id: 's',
        tool_name: 'mcp__plugin_cmdr_cmdr__join',
        tool_input: { squad_name: 'x' },
      },
      { CMDR_AGENT: 'zcode' },
    ),
  );
  expect(stamp.hookSpecificOutput.updatedInput).toEqual({ squad_name: 'x', _cmdr_session: 's' });
  expect(await invoke('Stop', { session_id: 's' })).toBe('');
  expect(existsSync(paths(home).socket)).toBe(false);
  const c = await host('zcode', 's');
  await tool(c, 'join', { squad_name: 'x' });
  const restored = JSON.parse(
    await invoke(
      'SessionStart',
      { session_id: 's', source: 'compact', cwd: '/project' },
      { CMDR_AGENT: 'zcode' },
    ),
  );
  expect(restored.hookSpecificOutput.additionalContext).toContain('commander');
}, 10000);
it('requires hello before RPC operations and rejects incompatible protocol versions', async () => {
  home = mkdtempSync(join(tmpdir(), 'cmdr-rpc-'));
  await run(cli, ['daemon', 'start'], { env: env() });
  const socket = connect(paths(home).socket);
  await new Promise<void>((resolve) => socket.once('connect', resolve));
  const rpc = new Rpc(socket);
  try {
    await expect(rpc.request('session.register', { kind: 'cli' })).rejects.toMatchObject({
      code: 'PROTOCOL_MISMATCH',
    });
    await expect(rpc.request('hello', { protocol: 999, version: '99.0.0' })).rejects.toMatchObject({
      code: 'PROTOCOL_MISMATCH',
    });
  } finally {
    rpc.close();
  }
}, 10000);
it('propagates MCP cancellation without consuming a later message', async () => {
  home = mkdtempSync(join(tmpdir(), 'cmdr-cancel-'));
  const c = await host('generic', 'c'),
    e = await host('zcode', 'e');
  const q = await tool(c, 'join', { squad_name: 'Cancel' });
  await tool(e, 'join', { role: 'executor', squad: q.squad.id });
  const controller = new AbortController();
  const waiting = e.callTool({ name: 'read', arguments: { wait: 5 } }, undefined, {
    signal: controller.signal,
  });
  const rejected = expect(waiting).rejects.toThrow();
  await new Promise((r) => setTimeout(r, 50));
  controller.abort();
  await rejected;
  await tool(c, 'send', { to: 'all', message: 'after cancellation' });
  expect((await tool(e, 'read')).messages[0].body).toBe('after cancellation');
}, 10000);
it('recovers a daemon killed without shutdown and preserves queued messages', async () => {
  home = mkdtempSync(join(tmpdir(), 'cmdr-crash-'));
  const c = await host('generic', 'c'),
    e = await host('generic', 'e');
  const q = await tool(c, 'join', { squad_name: 'Crash' });
  await tool(e, 'join', { role: 'executor', squad: q.squad.id });
  await tool(c, 'send', { to: 'all', message: 'durable' });
  const pid = JSON.parse(readFileSync(paths(home).info, 'utf8')).pid;
  process.kill(pid, 'SIGKILL');
  // Let EOF trigger automatic reconnect; retry only read-only status until ready.
  await expect
    .poll(
      async () => {
        try {
          return (await tool(e, 'list')).me.role;
        } catch {
          return 'reconnecting';
        }
      },
      { timeout: 8000 },
    )
    .toBe('executor');
  expect((await tool(e, 'read')).messages[0].body).toBe('durable');
  expect(JSON.parse(readFileSync(paths(home).info, 'utf8')).pid).not.toBe(pid);
}, 12000);

it('upgrades an older daemon while retaining memberships and queued work', async () => {
  home = mkdtempSync(join(tmpdir(), 'cmdr-upgrade-'));
  const oldPath = join(home, 'old-daemon.mjs');
  await build({
    entryPoints: ['src/daemon/main.ts'],
    outfile: oldPath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    define: { __VERSION__: JSON.stringify('0.0.9') },
  });
  const old = spawn(process.execPath, ['--experimental-sqlite', oldPath], {
    env: env(),
    stdio: 'ignore',
  });
  const peers: Rpc[] = [];
  try {
    await expect.poll(() => existsSync(paths(home).info), { timeout: 5000 }).toBe(true);
    async function register(id: string) {
      const socket = connect(paths(home).socket);
      await new Promise<void>((r) => socket.once('connect', r));
      const rpc = new Rpc(socket);
      peers.push(rpc);
      await rpc.request('hello', { version: '0.0.9', protocol: 1 });
      await rpc.request('session.register', { kind: 'mcp', agent: 'generic', native_id: id });
      return rpc;
    }
    const c = await register('c'),
      e = await register('e');
    const q = await c.request('session.join', { squad_name: 'Upgrade' });
    await e.request('session.join', { role: 'executor', squad: q.squad.id });
    await c.request('msg.send', { to: 'all', message: 'before upgrade' });
    const upgraded = await host('generic', 'e');
    expect((await tool(upgraded, 'read')).messages[0].body).toBe('before upgrade');
    const info = JSON.parse(readFileSync(paths(home).info, 'utf8'));
    expect(info.version).toBe('0.1.0');
    expect(info.pid).not.toBe(old.pid);
    expect((await tool(upgraded, 'list')).me.role).toBe('executor');
  } finally {
    for (const peer of peers) peer.close();
    old.kill('SIGTERM');
  }
}, 15000);
