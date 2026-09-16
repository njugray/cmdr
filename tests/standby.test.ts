import { afterEach, expect, it } from 'vitest';
import { fixture } from './helpers.js';
import { StandbyManager } from '../src/daemon/standby.js';
import type { HostAdapter } from '../src/daemon/adapters/codex.js';
import type { WakeRequest } from '../src/shared/protocol.js';
let f: ReturnType<typeof fixture>, manager: StandbyManager;
class Host implements HostAdapter {
  status: 'busy' | 'idle' | 'unknown' = 'idle';
  requests: WakeRequest[] = [];
  queued = new Map<string, string>();
  turns = new Set<string>();
  fail = false;
  starts = 0;
  state = async () => this.status;
  lookup = async (_id: string, r: WakeRequest) => ({
    found: this.queued.has(r.id) || this.turns.has(r.id),
    submission: this.queued.get(r.id),
  });
  enqueue = async (_id: string, r: WakeRequest) => {
    this.requests.push({ ...r });
    this.queued.set(r.id, 'submission-' + r.id);
    if (this.fail) throw new Error('lost response after host accepted');
    return 'submission-' + r.id;
  };
  start = async () => {
    this.starts++;
  };
  close() {}
}
afterEach(() => {
  manager?.close();
  f?.close();
});
async function setup() {
  f = fixture();
  const squad = await f.squad();
  const host = new Host();
  manager = new StandbyManager(f.core, () => host);
  manager.configure({ sid: squad.e.sid, action: 'start' });
  return { ...squad, host };
}
it('coalesces busy notifications and wakes once on idle, including repeated ticks', async () => {
  const { c, e, host } = await setup();
  host.status = 'busy';
  await f.core.handle(c, 'msg.send', { to: e.sid, message: 'one' });
  await f.core.handle(c, 'msg.send', { to: e.sid, message: 'two' });
  await manager.tick();
  expect(host.requests).toHaveLength(0);
  host.status = 'idle';
  await manager.tick();
  await manager.tick();
  expect(host.requests).toHaveLength(1);
  expect(host.requests[0].message_ids).toHaveLength(2);
  expect(f.store.standby(e.sid!)?.request?.state).toBe('accepted');
  expect(f.store.queue(e.sid!)).toHaveLength(2);
});
it('reconciles a lost acceptance response across listener restart without duplicate enqueue', async () => {
  const { c, e, host } = await setup();
  host.fail = true;
  await f.core.handle(c, 'msg.send', { to: e.sid, message: 'retained' });
  await manager.tick();
  expect(f.store.standby(e.sid!)?.health).toBe('uncertain');
  const wake = f.store.standby(e.sid!)!.request!.id;
  manager.close();
  manager = new StandbyManager(f.core, () => host);
  await manager.tick();
  expect(host.requests).toHaveLength(1);
  expect(f.store.standby(e.sid!)?.request).toMatchObject({ id: wake, state: 'accepted' });
});
it('surfaces a crash before enqueue as uncertain instead of silently marking work seen', async () => {
  const { c, e, host } = await setup();
  const command = (await f.core.handle(c, 'msg.send', { to: e.sid, message: 'pending' })).ids[0];
  const listener = f.store.standby(e.sid!)!;
  listener.request = {
    id: 'stable-wake',
    fingerprint: 'before-crash',
    message_ids: [command],
    created_at: Date.now(),
    state: 'requested',
  };
  f.store.saveStandby(listener);
  await manager.tick();
  await manager.tick();
  expect(host.requests).toHaveLength(0);
  expect(f.store.standby(e.sid!)?.health).toBe('uncertain');
  expect(f.store.message(command)?.status).toBe('queued');
  manager.configure({ sid: e.sid, action: 'resume', resolve: 'retry' });
  await manager.tick();
  expect(host.requests).toHaveLength(1);
});
it('recovers read-before-crash work when the host becomes idle without concurrent turns', async () => {
  const { c, e, host } = await setup();
  const command = (await f.core.handle(c, 'msg.send', { to: e.sid, message: 'recover' })).ids[0];
  await manager.tick();
  const wake = f.store.standby(e.sid!)!.request!.id;
  host.queued.delete(wake);
  host.turns.add(wake);
  host.status = 'busy';
  await f.core.handle(e, 'msg.read');
  await manager.tick();
  expect(host.requests).toHaveLength(1);
  host.status = 'idle';
  await manager.tick();
  expect(host.requests).toHaveLength(2);
  expect(host.requests[1].message_ids).toContain(command);
});
it('reports no-progress wake as stalled and does not repeatedly spend model turns', async () => {
  const { c, e, host } = await setup();
  await f.core.handle(c, 'msg.send', { to: e.sid, message: 'pending' });
  await manager.tick();
  const listener = f.store.standby(e.sid!)!;
  host.queued.clear();
  host.turns.add(listener.request!.id);
  listener.request!.created_at -= 120000;
  f.store.saveStandby(listener);
  await manager.tick();
  await manager.tick();
  expect(host.requests).toHaveLength(1);
  expect(f.store.standby(e.sid!)?.health).toBe('stalled');
});
it('does not wake a commander for working/ready, but does for actionable reports', async () => {
  f = fixture();
  const c = await f.session('codex', 'commander');
  const q = await f.core.handle(c, 'session.join', { squad_name: 'attention', role: 'commander' });
  const e = await f.session('generic', 'e');
  await f.core.handle(e, 'session.join', { squad: q.squad.id, role: 'executor' });
  const host = new Host();
  manager = new StandbyManager(f.core, () => host);
  manager.configure({ sid: c.sid, action: 'start' });
  for (const status of ['ready', 'working'])
    await f.core.handle(e, 'msg.report', { status, message: status });
  await manager.tick();
  expect(host.requests).toHaveLength(0);
  await f.core.handle(e, 'msg.report', { status: 'done', message: 'done' });
  await manager.tick();
  expect(host.requests).toHaveLength(1);
});
it('exposes unsupported hosts as manual and stops/resumes a persisted listener', async () => {
  const { c, e, host } = await setup();
  expect(manager.configure({ sid: c.sid, action: 'start' }).wake_mode).toBe('manual');
  manager.configure({ sid: e.sid, action: 'stop' });
  await f.core.handle(c, 'msg.send', { to: e.sid, message: 'later' });
  await manager.tick();
  expect(host.requests).toHaveLength(0);
  manager.configure({ sid: e.sid, action: 'resume' });
  await manager.tick();
  expect(host.requests).toHaveLength(1);
});
it('does not revive a listener stopped during an in-flight host query', async () => {
  const { c, e, host } = await setup();
  await f.core.handle(c, 'msg.send', { to: e.sid, message: 'later' });
  let resolve!: (v: 'idle') => void;
  host.state = () =>
    new Promise((r) => {
      resolve = r;
    });
  const tick = manager.tick();
  manager.configure({ sid: e.sid, action: 'stop' });
  resolve('idle');
  await tick;
  expect(host.requests).toHaveLength(0);
  expect(f.store.standby(e.sid!)?.health).toBe('stopped');
});
it('rejects unconfirmed identities and unregistered sessions', async () => {
  f = fixture();
  manager = new StandbyManager(f.core);
  const s = await f.session('codex', null);
  await f.core.handle(s, 'session.join', { squad_name: 'provisional' });
  expect(() => manager.configure({ sid: s.sid, action: 'start' })).toThrow(
    'Join with the real host',
  );
  expect(() => manager.configure({ sid: 'codex:invented', action: 'start' })).toThrow();
});

it('keeps the queued wake slot when hooks consumed its messages before the host starts', async () => {
  const { c, e, host } = await setup();
  const old = (await f.core.handle(c, 'msg.send', { to: e.sid, message: 'old' })).ids[0];
  await manager.tick();
  await f.core.handle(e, 'msg.report', { status: 'done', reply_to: old, message: 'done by hook' });
  await f.core.handle(c, 'msg.send', { to: e.sid, message: 'new' });
  await manager.tick();
  expect(host.requests).toHaveLength(1);
  expect(f.store.standby(e.sid!)?.request?.message_ids).toHaveLength(2);
});

it('stops all channel listeners on explicit closure without dropping their work', async () => {
  const { c, e } = await setup();
  await f.core.handle(c, 'msg.send', { to: e.sid, message: 'still owned' });
  await f.core.handle(c, 'session.leave', { dissolve: true });
  expect(f.store.standby(e.sid!)?.enabled).toBe(false);
  expect(manager.active).toBe(false);
  expect(f.store.commands(e.sid!)).toHaveLength(1);
});
