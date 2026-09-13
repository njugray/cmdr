import { afterEach, expect, it } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { quickCall } from '../src/shared/client.js';
import { diagnostic, diagnosticStatus } from '../src/shared/diagnostics.js';
const run = promisify(execFile);
const cli = resolve('plugins/cmdr/bin/cmdr');
let home = '';
const clients: Client[] = [];
const env = () => ({ ...process.env, CMDR_HOME: home, CMDR_AGENT: '', CMDR_SESSION_ID: '' });
async function session(id: string, action: string, input: Record<string, unknown> = {}) {
  return JSON.parse(
    (
      await run(
        cli,
        [
          'session',
          action,
          '--agent',
          'zcode',
          '--native-id',
          id,
          '--input',
          JSON.stringify(input),
        ],
        { env: env() },
      )
    ).stdout,
  );
}
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  if (home) {
    try {
      await quickCall('admin.shutdown', { reason: 'test' }, { home, timeout: 1000 });
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
    rmSync(home, { recursive: true, force: true });
  }
});
it('completes member CLI workflow and shares native identity with stamped MCP calls', async () => {
  home = mkdtempSync(join(tmpdir(), 'cmdr-release-'));
  const q = await session('c', 'join', { squad_name: 'release' });
  await session('e', 'join', { squad_name: 'release' });
  const sent = await session('c', 'send', { to: 'zcode:e', message: 'test command' });
  const messages = (await session('e', 'read')).messages;
  const command = messages.find((m: any) => m.body === 'test command');
  expect(command).toBeDefined();
  await session('e', 'report', { status: 'done', message: 'done', reply_to: command.id });
  const question = await session('e', 'ask', { question: 'next?' });
  await session('c', 'send', {
    to: 'zcode:e',
    type: 'answer',
    message: 'finish',
    reply_to: question.id,
  });
  const client = new Client({ name: 'zcode-test', version: '1' });
  clients.push(client);
  await client.connect(
    new StdioClientTransport({
      command: resolve('plugins/cmdr/bin/cmdr-mcp'),
      env: { ...env(), CMDR_AGENT: 'zcode' },
      stderr: 'pipe',
    }),
  );
  // Run the real hook to generate a stamp rather than inventing the bridged input.
  const hook = spawn(resolve('plugins/cmdr/bin/cmdr-hook'), ['PreToolUse'], {
    env: { ...env(), CMDR_AGENT: 'zcode' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  hook.stdout.on('data', (b) => (output += b));
  hook.stdin.end(
    JSON.stringify({
      session_id: 'e',
      tool_name: 'mcp__plugin:cmdr:cmdr__read',
      tool_input: { peek: true },
    }),
  );
  await new Promise<void>((r) => hook.on('exit', () => r()));
  const input = JSON.parse(output).hookSpecificOutput.updatedInput;
  const response = await client.callTool({ name: 'read', arguments: input });
  expect(response.isError).toBeFalsy();
  const read = JSON.parse((response.content as any[])[0].text);
  expect(read.me.sid).toBe('zcode:e');
  expect(read.messages.find((m: any) => m.body === 'finish').reply_to).toBe(question.id);
  const listing = await session('c', 'list', { scope: 'all' });
  expect(listing.sessions.filter((s: any) => s.sid === 'zcode:e')).toHaveLength(1);
  await client.close();
  expect((await session('c', 'list')).sessions.find((s: any) => s.sid === 'zcode:e').presence).toBe(
    'offline',
  );
  await session('e', 'leave');
  await session('c', 'leave', { dissolve: true });
  expect(q.squad.id).toBeTruthy();
  expect(sent).toBeTruthy();
}, 15000);
it('CLI timeout and SIGTERM leave future messages unread and do not retry asks', async () => {
  home = mkdtempSync(join(tmpdir(), 'cmdr-cancel-'));
  await session('c', 'join', { squad_name: 'cancel' });
  await session('e', 'join', { squad_name: 'cancel' });
  await session('e', 'read');
  await expect(
    run(
      cli,
      [
        'session',
        'ask',
        '--agent',
        'zcode',
        '--native-id',
        'e',
        '--wait',
        '30',
        '--timeout',
        '0.2',
        'question',
      ],
      { env: env() },
    ),
  ).rejects.toMatchObject({ code: 1 });
  const asks = (await session('c', 'read')).messages.filter((m: any) => m.type === 'ask');
  expect(asks).toHaveLength(1);
  const waiting = spawn(
    cli,
    ['session', 'read', '--agent', 'zcode', '--native-id', 'e', '--wait', '30'],
    { env: env(), stdio: 'ignore' },
  );
  const exited = new Promise<void>((r) => waiting.once('exit', () => r()));
  try {
    await expect
      .poll(
        async () =>
          (await session('c', 'list')).sessions.find((s: any) => s.sid === 'zcode:e').presence,
      )
      .toBe('online');
    waiting.kill('SIGTERM');
    await exited;
  } finally {
    waiting.kill('SIGKILL');
  }
  await session('c', 'send', { to: 'zcode:e', message: 'after cancellation' });
  expect(
    (await session('e', 'read')).messages.some((m: any) => m.body === 'after cancellation'),
  ).toBe(true);
}, 15000);
it('rejects ambiguous identity and inappropriate member roles', async () => {
  home = mkdtempSync(join(tmpdir(), 'cmdr-identity-'));
  await expect(
    run(cli, ['session', 'join', '--squad-name', 'x'], { env: env() }),
  ).rejects.toMatchObject({ code: 1 });
  await expect(
    run(cli, ['session', 'join', '--agent', 'zcode', '--native-id', 'e'], {
      env: { ...env(), CMDR_SESSION_ID: 'other' },
    }),
  ).rejects.toMatchObject({ code: 1 });
  await session('c', 'join', { squad_name: 'x' });
  await session('e', 'join', { squad_name: 'x' });
  await expect(session('e', 'send', { to: 'all', message: 'not commander' })).rejects.toMatchObject(
    { code: 1 },
  );
});
it('diagnoses missing runtime without cli bundle and keeps hook failures bounded', async () => {
  home = mkdtempSync(join(tmpdir(), 'cmdr-diagnostic-'));
  const broken = join(home, 'plugin');
  cpSync(resolve('plugins/cmdr'), broken, { recursive: true });
  rmSync(join(broken, 'dist'), { recursive: true });
  await expect(run(join(broken, 'bin/cmdr'), ['doctor'], { env: env() })).rejects.toMatchObject({
    code: 1,
    stdout: expect.stringContaining('Missing or invalid dist/integrity.json'),
  });
  const call = () => run(join(broken, 'bin/cmdr-hook'), ['SessionStart'], { env: env() });
  expect((await call()).stdout).toBe('');
  const file = join(home, 'logs/diagnostics/bootstrap-runtime.json');
  const content = readFileSync(file, 'utf8');
  await call();
  expect(readFileSync(file, 'utf8')).toBe(content);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  const blocked = join(home, 'unwritable');
  writeFileSync(blocked, 'file instead of directory');
  expect(
    (await run(join(broken, 'bin/cmdr-hook'), ['Stop'], { env: { ...env(), CMDR_HOME: blocked } }))
      .stdout,
  ).toBe('');
  expect(existsSync(join(home, 'cmdr.sock'))).toBe(false);
});
it('diagnostic snapshots discard payloads, throttle writes and tolerate missing directories', () => {
  home = mkdtempSync(join(tmpdir(), 'cmdr-snapshot-'));
  diagnostic('hook-error', { message: 'SECRET', agent: 'zcode' }, home);
  const before = diagnosticStatus(home)['hook-error'];
  diagnostic('hook-error', { agent: 'other' }, home);
  expect(diagnosticStatus(home)['hook-error']).toEqual(before);
  expect(JSON.stringify(before)).not.toContain('SECRET');
  expect(diagnosticStatus(home)['hook-Stop']).toBe('unknown');
  const blocked = join(home, 'blocked');
  writeFileSync(blocked, 'file');
  expect(() => diagnostic('hook-error', {}, blocked)).not.toThrow();
});

it('deep probe reports handshake timeouts and tears down its child', async () => {
  const { probeMcp } = await import('../src/cli/doctor.js');
  home = mkdtempSync(join(tmpdir(), 'cmdr-probe-'));
  const root = join(home, 'plugin');
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'bin/cmdr-mcp'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  const result = await probeMcp(root);
  expect(result).toMatchObject({
    ok: false,
    isolated: true,
    error: expect.stringContaining('timed out'),
  });
  expect(existsSync(join(home, 'cmdr.sock'))).toBe(false);
}, 12000);

it('rejects stale cache versions and corrupted hook runtime while remaining fail-open', async () => {
  home = mkdtempSync(join(tmpdir(), 'cmdr-stale-'));
  const root = join(home, 'plugin');
  cpSync(resolve('plugins/cmdr'), root, { recursive: true });
  const manifest = join(root, '.zcode-plugin/plugin.json');
  const config = JSON.parse(readFileSync(manifest, 'utf8'));
  config.version = '0.0.1';
  writeFileSync(manifest, JSON.stringify(config));
  await expect(run(cli, ['doctor', '--plugin-root', root], { env: env() })).rejects.toMatchObject({
    code: 1,
    stdout: expect.stringContaining('version differs'),
  });
  cpSync(resolve('plugins/cmdr'), root, { recursive: true });
  writeFileSync(join(root, 'dist/hook.mjs'), 'this is invalid JavaScript');
  expect((await run(join(root, 'bin/cmdr-hook'), ['Stop'], { env: env() })).stdout).toBe('');
  expect(diagnosticStatus(home)['bootstrap-runtime'].code).toBe('bootstrap-runtime');
});

it('records conflicting hook identity without stamping or binding the wrong session', async () => {
  home = mkdtempSync(join(tmpdir(), 'cmdr-conflict-'));
  const child = spawn(resolve('plugins/cmdr/bin/cmdr-hook'), ['PreToolUse'], {
    env: { ...env(), CMDR_AGENT: 'zcode', CMDR_SESSION_ID: 'fixed' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (b) => (output += b));
  child.stdin.end(
    JSON.stringify({
      session_id: 'other',
      tool_name: 'mcp__cmdr__join',
      tool_input: { squad_name: 'wrong' },
    }),
  );
  await new Promise<void>((r) => child.once('exit', () => r()));
  expect(output).toBe('');
  expect(diagnosticStatus(home)['identity-conflict']).toMatchObject({ agent: 'zcode' });
  expect(existsSync(join(home, 'cmdr.sock'))).toBe(false);
});
