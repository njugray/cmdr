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
it.each(['claude', 'zcode'])(
  '%s one-shot watcher waits for answers when re-armed around blocked work and still observes cancellation',
  async (agent) => {
    home = mkdtempSync(join(tmpdir(), 'cmdr-watch-blocked-'));
    const sid = `${agent}:e`;
    const watchArgs = [
      'standby',
      'watch',
      '--session',
      sid,
      ...(agent === 'claude' ? ['--once'] : []),
    ];
    const listener = () => command(['standby', 'status', '--session', sid]);
    await member('custom', 'c', 'join', { role: 'commander', squad_name: 'blocked' });
    await member(agent, 'e', 'join', { squad_name: 'blocked', standby: 'auto' });
    const id = (await member('custom', 'c', 'send', { to: sid, message: 'task' })).ids[0];
    await member(agent, 'e', 'read');
    await member(agent, 'e', 'report', { status: 'working', reply_to: id, message: 'accepted' });
    await member(agent, 'e', 'report', { status: 'blocked', reply_to: id, message: 'need input' });
    const question = await member(agent, 'e', 'ask', { question: 'Which option?', reply_to: id });
    const arm = async () => {
      const watcher = follower(watchArgs);
      await expect.poll(async () => (await listener()).health).toBe('healthy');
      const checked = (await listener()).checked_at;
      // Force another snapshot so silence is checked after attach and a live pulse.
      await member('custom', 'c', 'send', { to: 'all', type: 'info', message: 'quiet' });
      await expect.poll(async () => (await listener()).checked_at).toBeGreaterThan(checked);
      expect(watcher.output()).toBe('');
      expect(watcher.child.exitCode).toBeNull();
      return watcher;
    };
    const first = await arm();
    first.child.kill();
    await first.exited;
    await run(cli, ['daemon', 'restart'], { env: env() });
    const again = await arm();
    const answer = (
      await member('custom', 'c', 'send', {
        to: sid,
        type: 'answer',
        reply_to: question.id,
        message: 'Use option A',
      })
    ).ids[0];
    expect(await again.exited).toBe(0);
    expect(JSON.parse(again.output()).messages.map((m: any) => m.id)).toEqual([answer]);
    expect((await member(agent, 'e', 'read', { recover: true })).messages).toMatchObject([
      { id, work: { state: 'accepted' } },
    ]);
    // The answer is still unread, so the next attach must notify immediately.
    const unread = follower(watchArgs);
    expect(await unread.exited).toBe(0);
    expect(JSON.parse(unread.output()).messages.map((m: any) => m.id)).toEqual([answer]);
    await member(agent, 'e', 'read');
    const cancelling = await arm();
    const cancel = (
      await member('custom', 'c', 'send', {
        to: sid,
        type: 'cancel',
        reply_to: id,
        message: 'Stop at a safe checkpoint',
      })
    ).ids[0];
    expect(await cancelling.exited).toBe(0);
    expect(JSON.parse(cancelling.output()).messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: cancel, type: 'cancel' }),
        expect.objectContaining({ id, cancel_requested_at: expect.any(Number) }),
      ]),
    );
    await member(agent, 'e', 'read');
    // Consuming the cancel message does not acknowledge cancellation of the work.
    const pendingCancel = follower(watchArgs);
    expect(await pendingCancel.exited).toBe(0);
    expect(JSON.parse(pendingCancel.output()).messages).toMatchObject([
      { id, work_state: 'accepted', cancel_requested_at: expect.any(Number) },
    ]);
  },
  15000,
);
it.each(['queued', 'read'])(
  'notifies for %s but unaccepted commands already present when a watcher attaches',
  async (state) => {
    home = mkdtempSync(join(tmpdir(), 'cmdr-watch-backlog-'));
    await member('custom', 'c', 'join', { role: 'commander', squad_name: 'backlog' });
    await member('zcode', 'e', 'join', { squad_name: 'backlog', standby: 'auto' });
    const id = (await member('custom', 'c', 'send', { to: 'zcode:e', message: 'task' })).ids[0];
    if (state === 'read') await member('zcode', 'e', 'read');
    const watcher = follower(['standby', 'watch', '--session', 'zcode:e']);
    expect(await watcher.exited).toBe(0);
    expect(JSON.parse(watcher.output()).messages).toMatchObject([{ id, work_state: state }]);
    expect((await member('zcode', 'e', 'read', { recover: true })).messages).toMatchObject([
      { id, work: { state } },
    ]);
  },
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
  const quietIds: string[] = [];
  for (const status of ['ready', 'working'])
    quietIds.push((await member('custom', 'e', 'report', { status, message: 'quiet' })).id);
  const reports: { id: string; status: string }[] = [];
  for (const status of ['done', 'failed', 'blocked', 'cancelled']) {
    const report = await member('custom', 'e', 'report', {
      status,
      message: 'new',
      data: { private: 'hidden' },
    });
    reports.push({ id: report.id, status });
    // Multiple reports must arrive through this same long-lived subscription.
    await expect.poll(() => watch.output()).toContain(report.id);
  }
  expect(watch.output()).not.toContain(old.id);
  const parseEvents = (output: string) =>
    output
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  const live = parseEvents(watch.output());
  expect(live.map((event) => event.message_id)).toEqual(reports.map((report) => report.id));
  for (const event of live) expect(event.message).toMatchObject({ data: null, attn: true });
  const replay = await run(
    cli,
    ['tail', '--actionable', '--json', '--for', 'claude:c', '--after', '0'],
    { env: env() },
  );
  const replayed = parseEvents(replay.stdout);
  expect(
    replayed.filter((event) => reports.some((report) => report.id === event.message_id)),
  ).toEqual(live);
  for (const id of quietIds) expect(replay.stdout).not.toContain(id);
  const full = await run(
    cli,
    ['tail', '--actionable', '--json', '--full', '--for', 'claude:c', '--after', '0'],
    { env: env() },
  );
  const fullEvents = parseEvents(full.stdout);
  for (const report of reports)
    expect(fullEvents.find((event) => event.message_id === report.id)?.message.data).toEqual({
      private: 'hidden',
      status: report.status,
    });
  const line = await run(
    cli,
    ['tail', '--actionable', '--format', 'line', '--for', 'claude:c', '--after', '0'],
    { env: env() },
  );
  for (const report of reports) expect(line.stdout).toContain(report.id);
  expect(line.stdout).not.toContain(' old');
}, 15000);
