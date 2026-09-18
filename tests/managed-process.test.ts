import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { paths } from '../src/shared/paths.js';
import { quickCall } from '../src/shared/client.js';
const run = promisify(execFile),
  cli = resolve('plugins/cmdr/bin/cmdr');
let home = '';
const children: ChildProcess[] = [];
const env = () => ({ ...process.env, CMDR_HOME: home, CMDR_AGENT: '', CMDR_SESSION_ID: '' });
const command = async (args: string[]) => JSON.parse((await run(cli, args, { env: env() })).stdout);
const member = (native: string, action: string, input: unknown = {}) =>
  command([
    'session',
    action,
    '--agent',
    'codex',
    '--native-id',
    native,
    '--input',
    JSON.stringify(input),
  ]);
afterEach(async () => {
  for (const p of children.splice(0)) p.kill();
  if (home) {
    try {
      await quickCall('admin.shutdown', { reason: 'test' }, { home });
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
    rmSync(home, { recursive: true, force: true });
  }
});
it('uses public Codex queue IPC, persists its wake across daemon restart and exposes client versions', async () => {
  home = mkdtempSync(join(tmpdir(), 'cmdr-managed-'));
  const hostFile = join(home, 'host.json'),
    adapter = join(home, 'codex');
  writeFileSync(hostFile, JSON.stringify({ status: 'notLoaded', queue: [], turns: [], count: 0 }));
  // The manager passes only fixed proxy arguments; the fixture deliberately ignores them.
  writeFileSync(
    adapter,
    `#!${process.execPath}\nprocess.argv[2]=${JSON.stringify(hostFile)};import(${JSON.stringify(resolve('tests/fixtures/codex-proxy.mjs'))});\n`,
    { mode: 0o700 },
  );
  await member('c', 'join', { squad_name: 'managed', role: 'commander' });
  await member('e', 'join', { squad_name: 'managed' });
  await command(['standby', 'start', '--session', 'codex:e', '--executable', adapter]);
  await expect
    .poll(async () => (await command(['standby', 'status', '--session', 'codex:e'])).health, {
      timeout: 5000,
    })
    .toBe('healthy');
  const sent = await member('c', 'send', { to: 'codex:e', message: 'wake existing session' });
  await expect
    .poll(() => JSON.parse(readFileSync(hostFile, 'utf8')).count, { timeout: 5000 })
    .toBe(1);
  const before = await command(['standby', 'status', '--session', 'codex:e']);
  await run(cli, ['daemon', 'restart'], { env: env() });
  await expect
    .poll(async () => (await command(['standby', 'status', '--session', 'codex:e'])).checked_at, {
      timeout: 5000,
    })
    .toBeGreaterThan(before.checked_at);
  expect(JSON.parse(readFileSync(hostFile, 'utf8')).count).toBe(1);
  expect((await member('e', 'read')).messages[0].id).toBe(sent.ids[0]);
  const calls = readFileSync(hostFile + '.requests', 'utf8')
    .trim()
    .split('\n')
    .map((s) => JSON.parse(s));
  expect(calls.find((c) => c.method === 'thread/resume').params).toEqual({
    threadId: 'e',
    excludeTurns: true,
  });
  expect(calls.filter((c) => c.method === 'thread/queue/add')).toHaveLength(1);
  expect(calls.filter((c) => c.method === 'thread/queue/start')).toHaveLength(1);
  expect(calls.find((c) => c.method === 'thread/queue/add').params.clientUserMessageId).toBe(
    before.request.id,
  );
  expect((await command(['status'])).clients[0].version).toBeDefined();
}, 15000);
it('tail follows read and acceptance events, reconnects by cursor, and never consumes messages', async () => {
  home = mkdtempSync(join(tmpdir(), 'cmdr-events-'));
  await member('c', 'join', { role: 'commander', squad_name: 'events' });
  await member('e', 'join', { squad_name: 'events' });
  const follower = spawn(
    cli,
    ['tail', '--follow', '--json', '--full', '--after', '0', '--for', 'codex:e'],
    { env: env(), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(follower);
  let output = '';
  follower.stdout!.on('data', (b) => (output += b));
  const events = () =>
    output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((s) => JSON.parse(s));
  await expect.poll(() => events().length).toBeGreaterThan(0);
  const one = (await member('c', 'send', { to: 'codex:e', message: 'before restart' })).ids[0];
  await expect
    .poll(() => events().some((e) => e.kind === 'message.queued' && e.message_id === one))
    .toBe(true);
  expect((await member('e', 'read', { peek: true })).messages[0].id).toBe(one);
  await member('e', 'read');
  await member('e', 'report', { status: 'working', reply_to: one, message: 'accepted' });
  await expect
    .poll(() => events().some((e) => e.kind === 'work.accepted' && e.message_id === one))
    .toBe(true);
  await run(cli, ['daemon', 'restart'], { env: env() });
  const two = (await member('c', 'send', { to: 'codex:e', message: 'after restart' })).ids[0];
  await expect
    .poll(() => events().some((e) => e.kind === 'message.queued' && e.message_id === two), {
      timeout: 5000,
    })
    .toBe(true);
  expect(new Set(events().map((e) => e.event_seq)).size).toBe(events().length);
  expect((await member('e', 'read', { peek: true })).messages.map((m: any) => m.id)).toContain(two);
}, 15000);
it('refuses to stop the live daemon when the replacement bundle fails preflight', async () => {
  home = mkdtempSync(join(tmpdir(), 'cmdr-preflight-'));
  await member('c', 'join', { role: 'commander', squad_name: 'safe-upgrade' });
  await member('e', 'join', { squad_name: 'safe-upgrade' });
  await member('c', 'send', { to: 'codex:e', message: 'still usable' });
  const before = JSON.parse(readFileSync(paths(home).info, 'utf8')).pid;
  const broken = join(home, 'broken');
  cpSync(resolve('plugins/cmdr'), broken, { recursive: true });
  writeFileSync(
    join(broken, 'dist/daemon.mjs'),
    'throw new Error("replacement cannot open schema")',
  );
  await expect(
    run(join(broken, 'bin/cmdr'), ['daemon', 'restart'], { env: env() }),
  ).rejects.toMatchObject({ code: 1 });
  expect(existsSync(paths(home).socket)).toBe(true);
  expect(JSON.parse(readFileSync(paths(home).info, 'utf8')).pid).toBe(before);
  expect((await member('e', 'read')).messages[0].body).toBe('still usable');
}, 10000);
