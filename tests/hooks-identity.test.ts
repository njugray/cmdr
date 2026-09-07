import { afterEach, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fixture } from './helpers.js';
let f: ReturnType<typeof fixture>;
afterEach(() => f?.close());
it('stamps provisional identity without losing membership or messages', async () => {
  f = fixture();
  const p = await f.session('zcode', null, { cwd: null, wait_hint: 300 });
  const joined = await f.core.handle(p, 'session.join', { squad_name: 'Mixed' });
  const old = p.sid!;
  await f.core.handle({ notify: () => {} }, 'hook.event', {
    agent: 'zcode',
    session_id: 'real',
    event: 'UserPromptSubmit',
    cwd: '/project',
  });
  await f.core.handle(p, 'session.identify', { native_id: 'real' });
  expect(p.sid).toBe('zcode:real');
  expect(f.store.session(old)).toBeUndefined();
  expect(f.store.squad(joined.squad.id)?.commander_sid).toBe(p.sid);
  expect(f.store.session(p.sid!)?.cwd).toBe('/project');
  await f.core.handle(p, 'session.register', {
    kind: 'mcp',
    agent: 'zcode',
    native_id: 'real',
    cwd: null,
  });
  expect(f.store.session(p.sid!)?.cwd).toBe('/project');
});
it('migrates executor queues and waiting reads', async () => {
  f = fixture();
  const c = await f.session(),
    e = await f.session('codex', null);
  const q = await f.core.handle(c, 'session.join', { squad_name: 'x' });
  await f.core.handle(e, 'session.join', { role: 'executor', squad: q.squad.id });
  const pending = f.core.handle(e, 'msg.read', { wait: 5 });
  await f.core.handle(e, 'session.identify', { native_id: 'bound' });
  await f.core.handle(c, 'msg.send', { to: 'all', message: 'new' });
  expect((await pending).messages[0].to_sid).toBe('codex:bound');
});
it('reminds using metadata only and prevents repeated Stop blocks', async () => {
  f = fixture();
  const { c, e } = await f.squad();
  await f.core.handle(c, 'msg.send', { to: 'tests', message: 'SECRET BODY' });
  const reminder = await f.hook(e, 'PreToolUse');
  expect(reminder.inject).not.toContain('SECRET');
  expect(reminder.inject.length).toBeLessThanOrEqual(300);
  expect(existsSync(f.p.flag(e.sid!))).toBe(false);
  expect(await f.hook(e, 'PreToolUse')).toEqual({});
  expect((await f.hook(e, 'Stop')).block).toBe(true);
  expect((await f.hook(e, 'Stop')).block).toBeUndefined();
  await f.core.handle(c, 'msg.send', { to: 'tests', message: 'second' });
  expect((await f.hook(e, 'Stop', { stop_hook_active: true })).block).toBeUndefined();
  expect((await f.hook(e, 'Stop')).block).toBe(true);
});
it('ready and working reports do not block Stop; done does', async () => {
  f = fixture();
  const { c, e } = await f.squad();
  for (const status of ['ready', 'working'])
    await f.core.handle(e, 'msg.report', { status, message: status });
  expect((await f.hook(c, 'Stop')).block).toBeUndefined();
  await f.core.handle(e, 'msg.report', { status: 'done', message: 'done' });
  expect((await f.hook(c, 'Stop')).block).toBe(true);
});
it('does not create ghost sessions on unknown SessionEnd, restores context and wait hints', async () => {
  f = fixture();
  const c = await f.session('codex', 'c', { wait_hint: 300 });
  await f.core.handle(c, 'session.join', { squad_name: 'work' });
  const result = await f.hook(c, 'SessionStart', { source: 'compact' });
  expect(result.inject).toContain('wait=300');
  await f.core.handle({ notify: () => {} }, 'hook.event', {
    agent: 'codex',
    session_id: 'unknown',
    event: 'SessionEnd',
  });
  expect(f.store.sessions()).toHaveLength(1);
});
it('rebinds Claude clear only when exactly one host process matches', async () => {
  f = fixture();
  const c = await f.session('claude', 'old', { host_pid: 12345, cwd: '/project' });
  await f.core.handle(c, 'session.join', { squad_name: 'work' });
  await f.core.handle({ notify: () => {} }, 'hook.event', {
    agent: 'claude',
    session_id: 'new',
    event: 'SessionStart',
    source: 'clear',
    cwd: '/project',
    ancestors: [12345],
  });
  expect(c.sid).toBe('claude:new');
  expect(f.store.session(c.sid!)?.role).toBe('commander');
});
it('keeps presence online until the last MCP connection closes', async () => {
  f = fixture();
  const a = await f.session(),
    b = await f.session();
  f.core.disconnect(a);
  expect(f.store.session(b.sid!)?.presence).toBe('online');
  f.core.disconnect(b);
  expect(f.store.session(b.sid!)?.presence).toBe('offline');
});
it('expires messages and offline sessions and orphans an expired commander', async () => {
  f = fixture({ ttlDays: 0.001 });
  const { c, e, id } = await f.squad();
  f.core.disconnect(c);
  const old = f.store.session(c.sid!)!;
  old.last_seen_at = Date.now() - 86400000;
  f.store.saveSession(old);
  f.core.housekeep();
  expect(f.store.session(c.sid!)).toBeUndefined();
  expect(f.store.squad(id)?.status).toBe('orphaned');
  expect(f.store.queue(e.sid!).some((m) => m.body === 'commander_expired')).toBe(true);
});
it('canonicalizes provisional ask senders so answers remain routable after identity binding', async () => {
  f = fixture();
  const c = await f.session(),
    e = await f.session('generic', null);
  const q = await f.core.handle(c, 'session.join', { squad_name: 'identity' });
  await f.core.handle(e, 'session.join', { role: 'executor', squad: q.squad.id });
  const ask = await f.core.handle(e, 'msg.ask', { question: 'question' });
  await f.core.handle(e, 'session.identify', { native_id: 'real' });
  await f.core.handle(c, 'msg.send', {
    to: e.sid,
    message: 'answer',
    type: 'answer',
    reply_to: ask.id,
  });
  expect(f.store.queue(e.sid!)[0].body).toBe('answer');
});
it('cancels a waiting read without consuming the next message', async () => {
  f = fixture();
  const { c, e } = await f.squad();
  const controller = new AbortController();
  const read = f.core.handle(e, 'msg.read', { wait: 5 }, controller.signal);
  const error = expect(read).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
  controller.abort();
  await error;
  await f.core.handle(c, 'msg.send', { to: e.sid, message: 'retained' });
  expect(f.store.queue(e.sid!)[0].body).toBe('retained');
});
it('renews reminders for unread high-priority messages after the reminder interval', async () => {
  f = fixture();
  const { c, e } = await f.squad();
  await f.core.handle(c, 'msg.send', { to: e.sid, message: 'pending' });
  await f.hook(e, 'UserPromptSubmit');
  const s = f.store.session(e.sid!)!;
  s.last_notified_at = 0;
  f.store.saveSession(s);
  f.core.housekeep();
  expect(existsSync(f.p.flag(e.sid!))).toBe(true);
  expect((await f.hook(e, 'PreToolUse')).inject).toContain('unread');
});
