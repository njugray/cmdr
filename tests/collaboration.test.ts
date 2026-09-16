import { afterEach, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fixture } from './helpers.js';
import { Core } from '../src/daemon/core.js';
import { Store } from '../src/daemon/store.js';
import { defaults } from '../src/shared/config.js';
let f: ReturnType<typeof fixture>;
afterEach(() => f?.close());
async function operator() {
  const ctx = { notify: (_m: string, _p: unknown) => {} };
  f.core.connect(ctx);
  await f.core.handle(ctx, 'session.register', { kind: 'cli' });
  return ctx;
}
it('retains read-but-unaccepted and accepted tasks across disconnect and restart', async () => {
  f = fixture();
  const { c, e } = await f.squad();
  const sent = await f.core.handle(c, 'msg.send', { to: e.sid, message: 'D69', task_key: 'D69' });
  const id = sent.ids[0];
  const read = await f.core.handle(e, 'msg.read');
  expect(read.squad_summary).toBeUndefined();
  expect(read.messages[0].work.state).toBe('read');
  f.core.disconnect(e);
  const store = new Store(f.p.db),
    core = new Core(store, f.p, defaults);
  try {
    const ctx = { notify: () => {} };
    core.connect(ctx);
    await core.handle(ctx, 'session.register', {
      kind: 'mcp',
      transport: 'cli',
      agent: 'codex',
      native_id: 'executor',
    });
    expect(
      (await core.handle(ctx, 'msg.read', { recover: true })).messages.map((m: any) => m.id),
    ).toEqual([id]);
    await core.handle(ctx, 'msg.report', { status: 'working', reply_to: id, message: 'Accepted' });
    core.disconnect(ctx);
    const listing = await f.core.handle(c, 'session.list');
    const member = listing.sessions.find((s: any) => s.sid === e.sid);
    expect(member).toMatchObject({ presence: 'cli', activity: 'busy', pending: 0, in_progress: 1 });
    expect(member.commands[0]).toMatchObject({ id, state: 'accepted', unacked_for: null });
    expect(member.last_progress_at).toBeGreaterThan(0);
    expect(listing.squads[0].members).toBeUndefined();
  } finally {
    core.close();
    store.close();
  }
});
it('gates reassignment on a terminal acknowledgement and reserves cancel priority', async () => {
  f = fixture({ maxQueue: 2 });
  const { c, e, id: squad } = await f.squad();
  const n = await f.session('generic', 'replacement');
  await f.core.handle(n, 'session.join', { role: 'executor', squad });
  const original = (
    await f.core.handle(c, 'msg.send', { to: e.sid, message: 'D69', task_key: 'D69' })
  ).ids[0];
  await f.core.handle(e, 'msg.read');
  await f.core.handle(e, 'msg.report', {
    status: 'working',
    reply_to: original,
    message: 'started',
  });
  await f.core.handle(c, 'msg.read');
  await expect(
    f.core.handle(c, 'msg.send', { to: n.sid, message: 'duplicate', task_key: 'D69' }),
  ).rejects.toMatchObject({ code: 'TASK_OWNED' });
  await f.core.handle(c, 'msg.send', { to: e.sid, message: 'fills normal queue', type: 'info' });
  await f.core.handle(c, 'msg.send', { to: e.sid, message: 'fills normal queue 2', type: 'info' });
  const replacement = await f.core.handle(c, 'msg.send', {
    to: n.sid,
    message: 'D69 replacement',
    reassign: original,
  });
  expect(replacement.blocked_by).toBe(original);
  expect((await f.core.handle(n, 'msg.read')).messages).toHaveLength(0);
  await expect(
    f.core.handle(n, 'msg.report', {
      status: 'working',
      reply_to: replacement.ids[0],
      message: 'too soon',
    }),
  ).rejects.toMatchObject({ code: 'REASSIGNMENT_PENDING' });
  const cancel = (await f.core.handle(e, 'msg.read', { limit: 1 })).messages[0];
  expect(cancel).toMatchObject({ type: 'cancel', reply_to: original, priority: -1 });
  expect(
    f.store.events().some((e) => e.kind === 'message.read' && e.message_id === cancel.id),
  ).toBe(true);
  await f.core.handle(e, 'msg.report', {
    status: 'cancelled',
    reply_to: original,
    message: 'stopped at checkpoint',
  });
  expect((await f.core.handle(n, 'msg.read')).messages[0].id).toBe(replacement.ids[0]);
  await expect(
    f.core.handle(e, 'msg.report', { status: 'working', reply_to: original, message: 'late' }),
  ).rejects.toMatchObject({ code: 'WORK_TERMINAL' });
});
it('cancels unread work immediately without delivering it to the old owner', async () => {
  f = fixture();
  const { c, e, id } = await f.squad();
  const n = await f.session('generic', 'next');
  await f.core.handle(n, 'session.join', { role: 'executor', squad: id });
  const command = (await f.core.handle(c, 'msg.send', { to: e.sid, message: 'old' })).ids[0];
  await f.core.handle(c, 'msg.send', { to: n.sid, message: 'new', reassign: command });
  expect((await f.core.handle(e, 'msg.read')).messages.map((m: any) => m.type)).toEqual(['cancel']);
  expect((await f.core.handle(n, 'msg.read')).messages[0].body).toBe('new');
});
it('warns about unfinished work and rejects reports from the wrong member', async () => {
  f = fixture();
  const { c, e, id } = await f.squad();
  const other = await f.session('generic', 'other');
  await f.core.handle(other, 'session.join', { role: 'executor', squad: id });
  const command = (await f.core.handle(c, 'msg.send', { to: e.sid, message: 'first' })).ids[0];
  const sent = await f.core.handle(c, 'msg.send', { to: e.sid, message: 'second' });
  expect(sent.warnings[0].command_ids).toEqual([command]);
  await expect(
    f.core.handle(other, 'msg.report', { status: 'done', reply_to: command, message: 'wrong' }),
  ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  const report = await f.core.handle(e, 'msg.report', { status: 'done', message: 'uncorrelated' });
  expect(report.warning).toContain('reply_to');
  expect(f.store.commands(e.sid!)).toHaveLength(2);
});
it('provides non-consuming recovery/id lookup and full output only on request', async () => {
  f = fixture();
  const { c, e } = await f.squad();
  const id = (await f.core.handle(c, 'msg.send', { to: e.sid, message: 'full body' })).ids[0];
  for (const options of [{ peek: true }, { recover: true }, { id }]) {
    const read = await f.core.handle(e, 'msg.read', options);
    expect(read.messages[0].body).toBe('full body');
    expect(f.store.message(id)?.status).toBe('queued');
  }
  expect(
    (await f.core.handle(e, 'msg.read', { full: true, peek: true })).squad_summary,
  ).toBeDefined();
  await expect(f.core.handle(c, 'msg.read', { id })).rejects.toMatchObject({
    code: 'MESSAGE_NOT_FOUND',
  });
});
it('replays queued/read/accepted/completed events without consuming inboxes and signals retention gaps', async () => {
  f = fixture();
  const { c, e, id } = await f.squad();
  const op = await operator();
  const notices: any[] = [];
  op.notify = (method, value) => {
    if (method === 'lifecycle.event') notices.push(value);
  };
  const cursor = f.store.eventCursor();
  await f.core.handle(op, 'admin.tail', { after: cursor, for: e.sid, full: true, squad: id });
  const command = (await f.core.handle(c, 'msg.send', { to: e.sid, message: 'complete body' }))
    .ids[0];
  const peek = await f.core.handle(op, 'admin.events', { after: cursor, for: e.sid, full: true });
  expect(peek.events[0].message.body).toBe('complete body');
  expect(f.store.message(command)?.status).toBe('queued');
  await f.core.handle(e, 'msg.read');
  await f.core.handle(e, 'msg.report', { status: 'working', reply_to: command, message: 'ack' });
  await f.core.handle(e, 'msg.report', { status: 'done', reply_to: command, message: 'done' });
  expect(notices.map((e) => e.kind)).toEqual([
    'message.queued',
    'message.read',
    'work.accepted',
    'work.completed',
  ]);
  const replay = await f.core.handle(op, 'admin.events', { after: cursor, for: e.sid, full: true });
  expect(replay.events.map((e: any) => e.event_seq)).toEqual(notices.map((e) => e.event_seq));
  f.store.expireEvents(Date.now() + 1);
  expect((await f.core.handle(op, 'admin.events', { after: cursor })).gap).toBe(true);
});
it('creates commander-free channels, explicitly claims and transfers the stable role inbox', async () => {
  f = fixture();
  const e = await f.session('codex', 'first');
  const channel = await f.core.handle(e, 'session.join', {
    squad_name: 'Long lived',
    role: 'executor',
  });
  expect(channel.me.role).toBe('executor');
  expect(channel.squad.commander_sid).toBeNull();
  const ask = await f.core.handle(e, 'msg.ask', { question: 'retained' });
  const c = await f.session();
  await f.core.handle(c, 'session.join', { squad_name: 'long LIVED', role: 'commander' });
  const next = await f.session('zcode', 'next');
  await expect(
    f.core.handle(next, 'session.join', { role: 'commander', squad: channel.squad.id }),
  ).rejects.toMatchObject({ code: 'SQUAD_HAS_COMMANDER' });
  await f.core.handle(next, 'session.join', {
    role: 'commander',
    squad: channel.squad.id,
    takeover: true,
  });
  expect(f.store.session(c.sid!)?.role).toBe('executor');
  expect((await f.core.handle(c, 'msg.read')).messages.some((m: any) => m.id === ask.id)).toBe(
    false,
  );
  expect((await f.core.handle(next, 'msg.read')).messages.some((m: any) => m.id === ask.id)).toBe(
    true,
  );
  expect(f.store.message(ask.id)?.to_sid).toBe(`squad:${channel.squad.id}`);
});
it('rebinds a stable member, preserves work and revokes the old endpoint across restart', async () => {
  f = fixture();
  const { c, e } = await f.squad();
  const command = (await f.core.handle(c, 'msg.send', { to: e.sid, message: 'recover me' })).ids[0];
  await f.core.handle(e, 'msg.read');
  await f.core.handle(e, 'msg.report', {
    status: 'working',
    reply_to: command,
    message: 'working',
  });
  const member = f.store.session(e.sid!)!.member_id;
  const next = await f.session('codex', 'new-native');
  const rebound = await f.core.handle(next, 'session.join', { rebind: member });
  expect(rebound.me.member_id).toBe(member);
  expect(f.store.message(command)?.to_sid).toBe(next.sid);
  expect((await f.core.handle(next, 'msg.read', { recover: true })).messages[0].id).toBe(command);
  await expect(f.core.handle(e, 'msg.read')).rejects.toMatchObject({ code: 'ENDPOINT_REPLACED' });
  await expect(f.session('codex', 'executor')).rejects.toMatchObject({ code: 'ENDPOINT_REPLACED' });
  expect(await f.hook(e, 'SessionStart')).toEqual({});
  await f.core.handle(next, 'msg.report', { status: 'done', reply_to: command, message: 'done' });
  expect(f.store.commands()).toHaveLength(0);
});
it('keeps unfinished commands and empty channels through retention', async () => {
  f = fixture({ ttlDays: 0.00001 });
  const { c, e, id } = await f.squad();
  const command = (await f.core.handle(c, 'msg.send', { to: e.sid, message: 'must survive' }))
    .ids[0];
  const m = f.store.message(command)!;
  m.created_at = 1;
  f.store.saveMessage(m);
  await f.core.handle(c, 'session.leave');
  await f.core.handle(e, 'session.leave');
  const q = f.store.squad(id)!;
  q.updated_at = 1;
  f.store.saveSquad(q);
  f.core.housekeep();
  expect(f.store.message(command)).toBeDefined();
  expect(f.store.squad(id)).toBeDefined();
});
it('restores commander hook flags for stable inbox messages after housekeeping', async () => {
  f = fixture();
  const { c, e } = await f.squad();
  await f.core.handle(e, 'msg.report', { status: 'done', message: 'attention' });
  f.core.housekeep();
  expect(existsSync(f.p.flag(c.sid!))).toBe(true);
});

it('migrates legacy correlated reports without resurrecting completed work', async () => {
  f = fixture();
  const { c, e } = await f.squad();
  const done = (await f.core.handle(c, 'msg.send', { to: e.sid, message: 'legacy done' })).ids[0];
  const pending = (await f.core.handle(c, 'msg.send', { to: e.sid, message: 'legacy unread' }))
    .ids[0];
  await f.core.handle(e, 'msg.report', {
    status: 'done',
    reply_to: done,
    message: 'old terminal report',
  });
  for (const id of [done, pending]) {
    const m = f.store.message(id)!;
    delete m.work;
    f.store.saveMessage(m);
  }
  const migrated = new Store(f.p.db);
  try {
    expect(migrated.message(done)?.work?.state).toBe('completed');
    expect(migrated.commands(e.sid!).map((m) => m.id)).toEqual([pending]);
    expect(migrated.events().filter((e) => e.kind === 'work.migrated')).toHaveLength(2);
  } finally {
    migrated.close();
  }
});
it('bounds large event and read pages below the RPC frame limit without losing the next cursor', async () => {
  f = fixture({ rateLimitPerMinute: 500 });
  const { c, e } = await f.squad();
  const op = await operator();
  const cursor = f.store.eventCursor();
  for (let i = 0; i < 30; i++)
    await f.core.handle(c, 'msg.send', {
      to: e.sid,
      message: 'x'.repeat(32000),
      data: { large: 'y'.repeat(60000) },
    });
  const first = await f.core.handle(op, 'admin.events', { after: cursor, for: e.sid, full: true });
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(2 * 1024 * 1024);
  expect(first.events.length).toBeLessThan(30);
  const ids = new Set(first.events.map((e: any) => e.message_id));
  let next = first.next;
  while (next < first.high) {
    const page = await f.core.handle(op, 'admin.events', { after: next, for: e.sid, full: true });
    for (const e of page.events) ids.add(e.message_id);
    next = page.next;
  }
  expect(ids.size).toBe(30);
  expect(f.store.queue(e.sid!)).toHaveLength(30);
  const read = await f.core.handle(e, 'msg.read', { limit: 100 });
  expect(Buffer.byteLength(JSON.stringify(read))).toBeLessThan(2 * 1024 * 1024);
  expect(read.remaining + read.messages.length).toBe(30);
});
it('preserves cancellation gates after message retention and handles purge during a waiting read', async () => {
  f = fixture();
  const { c, e, id } = await f.squad();
  const n = await f.session('generic', 'next');
  await f.core.handle(n, 'session.join', { role: 'executor', squad: id });
  const original = (await f.core.handle(c, 'msg.send', { to: e.sid, message: 'old' })).ids[0];
  await f.core.handle(e, 'msg.read');
  const replacement = (
    await f.core.handle(c, 'msg.send', { to: n.sid, message: 'replacement', reassign: original })
  ).ids[0];
  await f.core.handle(e, 'msg.report', {
    status: 'cancelled',
    reply_to: original,
    message: 'stopped',
  });
  const old = f.store.message(original)!;
  old.created_at = 1;
  f.store.saveMessage(old);
  f.core.housekeep();
  expect(f.store.message(original)).toBeDefined();
  expect((await f.core.handle(n, 'msg.read')).messages[0].id).toBe(replacement);
  const waiting = f.core.handle(n, 'msg.read', { wait: 5 });
  const rejection = expect(waiting).rejects.toMatchObject({ code: 'NOT_JOINED' });
  f.core.housekeep(true);
  await rejection;
});

it('keeps provisional hosts joinable with explicit manual standby until identity is confirmed', async () => {
  f = fixture();
  f.core.configureStandby = () => {
    throw new Error('must not register provisional host');
  };
  const p = await f.session('generic', null);
  const result = await f.core.handle(p, 'session.join', { squad_name: 'generic', standby: 'auto' });
  expect(result.me.identity).toBe('provisional');
  expect(result.standby.wake_mode).toBe('manual');
  expect(result.standby.reason).toContain('confirmed native session ID');
  expect(f.store.squads()).toHaveLength(1);
});

it('does not hide abandoned ownership and permits its owner to finish after leaving', async () => {
  f = fixture();
  const { c, e } = await f.squad();
  const command = (await f.core.handle(c, 'msg.send', { to: e.sid, message: 'still owned' }))
    .ids[0];
  await f.core.handle(e, 'msg.read');
  await f.core.handle(e, 'session.leave');
  const list = await f.core.handle(c, 'session.list');
  expect(list.sessions.find((s: any) => s.sid === e.sid).commands[0].id).toBe(command);
  await f.core.handle(e, 'msg.report', {
    status: 'cancelled',
    reply_to: command,
    message: 'stopped after leaving',
  });
  expect(f.store.commands(e.sid!)).toHaveLength(0);
});
it('rejects broadcasting a unique ticket to multiple owners', async () => {
  f = fixture();
  const { c, id } = await f.squad();
  const other = await f.session('generic', 'other');
  await f.core.handle(other, 'session.join', { squad: id, role: 'executor' });
  await expect(
    f.core.handle(c, 'msg.send', { to: 'all', message: 'one ticket', task_key: 'D69' }),
  ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  expect(f.store.commands()).toHaveLength(0);
});
