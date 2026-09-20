import { afterEach, expect, it } from 'vitest';
import { fixture } from './helpers.js';
import { StandbyManager } from '../src/daemon/standby.js';
import { Store } from '../src/daemon/store.js';
import type { Context } from '../src/daemon/core.js';
import type { HostAdapter } from '../src/daemon/adapters/codex.js';
import { WakeDeferred, type WakeRequest, type LifecycleEvent } from '../src/shared/protocol.js';
import { wakeEvent } from '../src/shared/wake.js';
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
it('keeps a queued wake unhealthy while host state is unknown and recovers without another enqueue', async () => {
  const { c, e, host } = await setup();
  await f.core.handle(c, 'msg.send', { to: e.sid, message: 'pending' });
  await manager.tick();
  const request = f.store.standby(e.sid!)!.request!;
  const starts = host.starts;
  manager.close();
  manager = new StandbyManager(f.core, () => host);
  host.status = 'unknown';
  for (let i = 0; i < 2; i++) {
    await manager.tick();
    expect((await f.core.handle(e, 'session.list')).me.listener).toMatchObject({
      health: 'error',
      host_state: 'unknown',
      can_auto_respond: false,
      request: { id: request.id, state: 'accepted' },
    });
    expect(f.store.standby(e.sid!)?.error).toContain('runtime state');
  }
  expect(host.starts).toBe(starts);
  host.status = 'idle';
  await manager.tick();
  expect((await f.core.handle(e, 'session.list')).me.listener).toMatchObject({
    health: 'healthy',
    host_state: 'idle',
    can_auto_respond: true,
    request: { id: request.id, state: 'accepted' },
  });
  expect(f.store.standby(e.sid!)?.error).toBeUndefined();
  expect(host.starts).toBe(starts + 1);
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
  await f.core.handle(c, 'msg.read'); // member_joined itself warrants a wake
  for (const status of ['ready', 'working'])
    await f.core.handle(e, 'msg.report', { status, message: status });
  await manager.tick();
  expect(host.requests).toHaveLength(0);
  await f.core.handle(e, 'msg.report', { status: 'done', message: 'done' });
  await manager.tick();
  expect(host.requests).toHaveLength(1);
});
it('preserves report attention decisions when live and replayed events omit data', async () => {
  f = fixture();
  const { c, e } = await f.squad();
  const notices: LifecycleEvent[] = [];
  const observer: Context = {
    notify: (method, value) => {
      if (method === 'lifecycle.event') notices.push(value as LifecycleEvent);
    },
  };
  f.core.connect(observer);
  await f.core.handle(observer, 'session.register', { kind: 'cli' });
  const cursor = f.store.eventCursor();
  await f.core.handle(observer, 'admin.tail', { for: c.sid, after: cursor });
  for (const [status, attention] of [
    ['ready', false],
    ['working', false],
    ['done', true],
    ['failed', true],
    ['blocked', true],
    ['cancelled', true],
  ] as const) {
    const report = await f.core.handle(e, 'msg.report', {
      status,
      message: status,
      data: { private: 'hidden' },
    });
    const live = notices.find((event) => event.message_id === report.id)!;
    expect(live.message).toMatchObject({ data: null, attn: attention });
    expect(wakeEvent(live, c.sid)).toBe(attention);
    const stored = f.store.events(cursor).find((event) => event.message_id === report.id)!;
    expect(stored.message?.data).toEqual({ private: 'hidden', status });
    expect(wakeEvent(stored, c.sid)).toBe(attention);
  }
  const replay = await f.core.handle(observer, 'admin.events', { for: c.sid, after: cursor });
  expect(replay.events).toEqual(notices);
});
it('exposes unsupported hosts as manual and stops/resumes a persisted listener', async () => {
  const { c, e, host } = await setup();
  const generic = await f.session('custom-host', 'custom');
  await f.core.handle(generic, 'session.join', {
    role: 'executor',
    squad: f.store.session(c.sid!)!.squad_id,
  });
  expect(manager.configure({ sid: generic.sid, action: 'start' }).wake_mode).toBe('manual');
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

it.each(['claude', 'zcode', 'kimi'])(
  'arms %s only with a live host lease, rejects duplicates and expires',
  async (agent) => {
    f = fixture();
    const c = await f.session(agent, 'host');
    await f.core.handle(c, 'session.join', { squad_name: 'host', role: 'commander' });
    manager = new StandbyManager(f.core, () => {
      throw new Error('host watcher must not invoke adapter');
    });
    const result = manager.configure({ sid: c.sid, action: 'start' });
    expect(result).toMatchObject({ wake_mode: agent, health: 'starting' });
    expect(f.core.standbyView(c.sid!).can_auto_respond).toBe(false);
    expect(f.core.standbyView(c.sid!).arm?.command).toContain('standby watch');
    manager.watch(c.sid!, 'first', 'attach');
    expect(f.core.standbyView(c.sid!).can_auto_respond).toBe(true);
    expect(() => manager.watch(c.sid!, 'second', 'attach')).toThrow('already owns');
    manager.configure({ sid: c.sid, action: 'start' });
    expect(f.store.standby(c.sid!)?.lease?.token).toBe('first');
    const e = await f.session('custom-host', 'executor');
    await f.core.handle(e, 'session.join', {
      role: 'executor',
      squad: f.store.session(c.sid!)!.squad_id,
    });
    await f.core.handle(c, 'msg.read');
    await f.core.handle(e, 'msg.report', { status: 'ready', message: 'ready' });
    expect(manager.watch(c.sid!, 'first', 'pulse').messages).toHaveLength(0);
    await f.core.handle(e, 'msg.report', { status: 'done', message: 'secret body' });
    const snapshot = manager.watch(c.sid!, 'first', 'pulse');
    expect(snapshot.messages).toHaveLength(1);
    expect(JSON.stringify(snapshot)).not.toContain('secret body');
    expect(f.core.inbox(f.store.session(c.sid!)!)).toHaveLength(2);
    const record = f.store.standby(c.sid!)!;
    record.lease!.expires_at = Date.now() - 1;
    f.store.saveStandby(record);
    expect(f.core.standbyView(c.sid!).can_auto_respond).toBe(false);
    await manager.tick();
    expect(f.store.standby(c.sid!)?.health).toBe('stalled');
    manager.watch(c.sid!, 'second', 'attach');
    manager.watch(c.sid!, 'first', 'detach');
    expect(f.store.standby(c.sid!)?.lease?.token).toBe('second');
    manager.watch(c.sid!, 'second', 'detach');
    expect(f.core.standbyView(c.sid!).can_auto_respond).toBe(false);
  },
);

it('upgrades an earlier manual host registration on join(auto)', async () => {
  f = fixture();
  const { c } = await f.squad();
  manager = new StandbyManager(f.core);
  manager.configure({ sid: c.sid, action: 'start', adapter: 'manual' });
  expect(manager.configure({ sid: c.sid, action: 'start' }).wake_mode).toBe('claude');
});
it('retries safely after a busy race that happened before any delivery attempt', async () => {
  const { c, e, host } = await setup();
  await f.core.handle(c, 'msg.send', { to: e.sid, message: 'later' });
  const enqueue = host.enqueue;
  host.enqueue = async () => {
    throw new WakeDeferred('busy before submission');
  };
  await manager.tick();
  expect(f.store.standby(e.sid!)?.request).toBeUndefined();
  expect(f.store.standby(e.sid!)?.health).toBe('healthy');
  host.enqueue = enqueue;
  await manager.tick();
  expect(host.requests).toHaveLength(1);
});
it('keeps broadcast info quiet, wakes for direct info and reminds host sessions to re-arm on start', async () => {
  const { c, e, host } = await setup();
  await f.core.handle(c, 'msg.send', { to: 'all', type: 'info', message: 'quiet' });
  await manager.tick();
  expect(host.requests).toHaveLength(0);
  await f.core.handle(c, 'msg.send', { to: e.sid, type: 'info', message: 'direct' });
  await manager.tick();
  expect(host.requests).toHaveLength(1);
  manager.configure({ sid: c.sid, action: 'start' });
  const hook = await f.hook(c, 'SessionStart');
  expect(hook.inject).toContain('re-arm');
  expect(hook.inject).not.toContain('direct');
});
it('moves the standby listener with the member when Claude clear re-identifies it', async () => {
  f = fixture();
  manager = new StandbyManager(f.core);
  const c = await f.session('claude', 'old', { host_pid: 12345, cwd: '/project' });
  await f.core.handle(c, 'session.join', { role: 'commander', squad_name: 'work' });
  manager.configure({ sid: c.sid, action: 'start' });
  manager.watch(c.sid!, 'before-clear', 'attach');
  f.store.saveStandby({
    ...f.store.standby(c.sid!)!,
    request: { id: 'w1', fingerprint: 'f', message_ids: [], created_at: 0, state: 'accepted' },
  });
  const restored = await f.core.handle({ notify: () => {} }, 'hook.event', {
    agent: 'claude',
    session_id: 'new',
    event: 'SessionStart',
    source: 'clear',
    cwd: '/project',
    ancestors: [12345],
  });
  expect(c.sid).toBe('claude:new');
  expect(f.store.standby('claude:old')).toBeUndefined();
  expect(f.store.standby('claude:new')).toMatchObject({
    enabled: true,
    wake_mode: 'claude',
    health: 'starting',
  });
  expect(f.store.standby('claude:new')?.request).toBeUndefined();
  expect(restored.inject).toContain('re-arm the host watcher');
  expect(() => manager.watch('claude:new', 'after-clear', 'attach')).not.toThrow();
});
it('drops standby listeners that earlier versions left without a session', async () => {
  f = fixture();
  const kept = await f.session('claude', 'kept');
  const listener = {
    enabled: true,
    wake_mode: 'claude',
    health: 'healthy',
    host_state: 'unknown',
    checked_at: null,
  } as const;
  f.store.saveStandby({ sid: kept.sid!, ...listener });
  f.store.saveStandby({ sid: 'claude:gone', ...listener });
  const reopened = new Store(f.p.db);
  try {
    expect(reopened.standbys().map((s) => s.sid)).toEqual([kept.sid]);
  } finally {
    reopened.close();
  }
});
