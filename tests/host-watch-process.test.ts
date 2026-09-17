import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { quickCall } from '../src/shared/client.js';
const run = promisify(execFile),
  cli = resolve('plugins/cmdr/bin/cmdr');
let home = '';
const children: ChildProcess[] = [];
const env = () => ({ ...process.env, CMDR_HOME: home, CMDR_AGENT: '', CMDR_SESSION_ID: '' });
const command = async (args: string[]) => JSON.parse((await run(cli, args, { env: env() })).stdout);
const member = (agent: string, native: string, action: string, input = {}) =>
  command([
    'session',
    action,
    '--agent',
    agent,
    '--native-id',
    native,
    '--input',
    JSON.stringify(input),
  ]);
function follower(args: string[]) {
  const child = spawn(cli, args, { env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let out = '',
    err = '';
  child.stdout!.on('data', (b) => (out += b));
  child.stderr!.on('data', (b) => (err += b));
  const exited = new Promise<number | null>((r) => child.once('exit', r));
  return { child, exited, output: () => out, error: () => err };
}
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
it.each(['claude', 'zcode'])(
  '%s watcher is silent when idle, non-consuming and re-armable',
  async (agent) => {
    home = mkdtempSync(join(tmpdir(), 'cmdr-watch-'));
    await member('custom', 'c', 'join', { role: 'commander', squad_name: 'watch' });
    await member(agent, 'e', 'join', { squad_name: 'watch', standby: 'auto' });
    const watcher = follower(['standby', 'watch', '--session', `${agent}:e`]);
    await expect
      .poll(async () => (await member(agent, 'e', 'list')).me.listener.can_auto_respond)
      .toBe(true);
    expect(watcher.output()).toBe('');
    await expect(
      run(cli, ['standby', 'watch', '--session', `${agent}:e`], { env: env() }),
    ).rejects.toThrow('WATCHER_ACTIVE');
    const id = (
      await member('custom', 'c', 'send', { to: `${agent}:e`, message: 'sensitive task body' })
    ).ids[0];
    await expect.poll(() => watcher.output()).toContain(id);
    expect(watcher.output()).not.toContain('sensitive task body');
    expect((await member(agent, 'e', 'read', { peek: true })).messages[0].id).toBe(id);
    if (agent === 'zcode') expect(await watcher.exited).toBe(0);
    else {
      watcher.child.kill();
      await watcher.exited;
    }
    await member(agent, 'e', 'read');
    await member(agent, 'e', 'report', { status: 'working', message: 'accepted', reply_to: id });
    await member(agent, 'e', 'report', { status: 'done', message: 'finished', reply_to: id });
    const again = follower(['standby', 'watch', '--session', `${agent}:e`, '--once']);
    await expect
      .poll(async () => (await member(agent, 'e', 'list')).me.listener.can_auto_respond)
      .toBe(true);
    expect(again.output()).toBe('');
    await run(cli, ['daemon', 'restart'], { env: env() });
    expect(await again.exited).toBe(1);
    expect(again.error()).toContain('re-arm');
    expect((await member(agent, 'e', 'list')).me.listener.can_auto_respond).toBe(false);
  },
  15000,
);
it('actionable tail filters role-inbox reports and starts at now without losing the subscription race', async () => {
  home = mkdtempSync(join(tmpdir(), 'cmdr-watch-tail-'));
  await member('claude', 'c', 'join', { role: 'commander', squad_name: 'tail' });
  await member('custom', 'e', 'join', { squad_name: 'tail' });
  const old = await member('custom', 'e', 'report', { status: 'done', message: 'old' });
  const watch = follower(['tail', '--follow', '--actionable', '--json', '--for', 'claude:c']);
  await expect
    .poll(async () =>
      (await command(['status'])).clients.some((c: any) => c.observing?.for === 'claude:c'),
    )
    .toBe(true);
  await member('custom', 'e', 'report', { status: 'ready', message: 'quiet' });
  const done = await member('custom', 'e', 'report', { status: 'done', message: 'new' });
  await expect.poll(() => watch.output()).toContain(done.id);
  expect(watch.output()).not.toContain(old.id);
  expect(watch.output()).not.toContain('quiet');
  const replay = await run(
    cli,
    ['tail', '--actionable', '--json', '--for', 'claude:c', '--after', '0'],
    { env: env() },
  );
  expect(replay.stdout).toContain(done.id);
  expect(replay.stdout).not.toContain('quiet');
  const line = await run(
    cli,
    ['tail', '--actionable', '--format', 'line', '--for', 'claude:c', '--after', '0'],
    { env: env() },
  );
  expect(line.stdout).toContain(done.id);
  expect(line.stdout).not.toContain(' old');
}, 15000);
