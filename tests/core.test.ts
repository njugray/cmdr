import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fixture } from './helpers.js';
import { Store } from '../src/daemon/store.js';
let f: ReturnType<typeof fixture>;
afterEach(() => f?.close());
describe('squads and queues', () => {
  it('atomically creates/joins case-insensitive names and stays idempotent', async () => {
    f = fixture();
    const a = await f.session(),
      b = await f.session('zcode', 'b');
    const [first, second] = await Promise.all([
      f.core.handle(a, 'session.join', { squad_name: ' Alpha ' }),
      f.core.handle(b, 'session.join', { squad_name: 'alpha' }),
    ]);
    expect(first.me.role).toBe('commander');
    expect(second.me.role).toBe('executor');
    expect(first.squad.id).toBe(second.squad.id);
    expect((await f.core.handle(a, 'session.join', { squad_name: 'Alpha' })).me.role).toBe(
      'commander',
    );
    expect(f.store.squads()).toHaveLength(1);
    expect(f.store.session(b.sid!)?.name).toBeNull();
    await expect(f.core.handle(b, 'session.join', { squad_name: 'Other' })).rejects.toMatchObject({
      code: 'ALREADY_JOINED',
    });
  });
  it('supports arbitrary host IDs without assigning them Codex behavior', async () => {
    f = fixture();
    const a = await f.session('custom_agent', 'same-id'),
      b = await f.session('zcode', 'same-id');
    expect(a.sid).toBe('custom_agent:same-id');
    expect(b.sid).toBe('zcode:same-id');
    expect((await f.core.handle(a, 'session.list')).me.recommended_wait).toBe(45);
  });
  it('enforces roles, recipients and queue priority; peek/history do not dequeue', async () => {
    f = fixture();
    const { c, e } = await f.squad();
    await expect(f.core.handle(e, 'msg.send', { to: 'all', message: 'no' })).rejects.toMatchObject({
      code: 'ROLE_NOT_ALLOWED',
    });
    await expect(
      f.core.handle(c, 'msg.report', { status: 'ready', message: 'no' }),
    ).rejects.toMatchObject({ code: 'ROLE_NOT_ALLOWED' });
    await expect(
      f.core.handle(c, 'msg.send', { to: 'missing', message: 'no' }),
    ).rejects.toMatchObject({ code: 'RECIPIENT_NOT_FOUND' });
    await f.core.handle(c, 'msg.send', { to: 'tests', message: 'info', type: 'info' });
    await f.core.handle(c, 'msg.send', { to: 'tests', message: 'command' });
    expect((await f.core.handle(e, 'msg.peek')).messages.map((m: any) => m.body)).toEqual([
      'command',
      'info',
    ]);
    const read = await f.core.handle(e, 'msg.read', { limit: 1 });
    expect(read.remaining).toBe(1);
    const history = await f.core.handle(e, 'msg.history');
    expect(history.messages[0].body).toBe('command');
    expect((await f.core.handle(e, 'msg.read')).messages[0].body).toBe('info');
    expect(existsSync(f.p.flag(e.sid!))).toBe(false);
  });
  it('wakes long polls immediately and matches only the correlated answer', async () => {
    f = fixture();
    const { c, e } = await f.squad();
    const pending = f.core.handle(e, 'msg.read', { wait: 5 });
    await f.core.handle(c, 'msg.send', { to: 'tests', message: 'run tests' });
    expect((await pending).messages[0].body).toBe('run tests');
    const asking = f.core.handle(e, 'msg.ask', { question: 'which suite?', wait: 5 });
    const ask = (await f.core.handle(c, 'msg.read')).messages[0];
    await f.core.handle(c, 'msg.send', { to: 'tests', message: 'unrelated', type: 'info' });
    await f.core.handle(c, 'msg.send', {
      to: 'tests',
      message: 'unit',
      type: 'answer',
      reply_to: ask.id,
    });
    expect((await asking).answer.body).toBe('unit');
    expect((await f.core.handle(e, 'msg.read')).messages.map((m: any) => m.body)).toEqual([
      'unrelated',
    ]);
  });
  it('keeps late answers in the queue after ask timeout', async () => {
    f = fixture();
    const { c, e } = await f.squad();
    const ask = await f.core.handle(e, 'msg.ask', { question: 'q', wait: 0.01 });
    expect(ask.answered).toBe(false);
    await f.core.handle(c, 'msg.send', {
      to: 'tests',
      message: 'later',
      type: 'answer',
      reply_to: ask.id,
    });
    expect((await f.core.handle(e, 'msg.read')).messages[0].body).toBe('later');
  });
  it('orphans, holds reports and questions, transfers inbox, dissolves without deleting queued work', async () => {
    f = fixture();
    const { c, e, id } = await f.squad();
    await f.core.handle(c, 'session.leave');
    await f.core.handle(e, 'msg.report', { status: 'done', message: 'done offline' });
    const ask = await f.core.handle(e, 'msg.ask', { question: 'next?' });
    const n = await f.session('zcode', 'new');
    await expect(f.core.handle(n, 'session.join', { squad_name: 'alpha' })).rejects.toMatchObject({
      code: 'SQUAD_ORPHANED',
    });
    await f.core.handle(n, 'session.join', { role: 'commander', squad: id });
    const result = await f.core.handle(n, 'msg.read');
    expect(result.messages.map((m: any) => m.body)).toEqual(['next?', 'done offline']);
    await f.core.handle(n, 'msg.send', {
      to: 'tests',
      message: 'finish',
      type: 'answer',
      reply_to: ask.id,
    });
    await f.core.handle(n, 'session.leave', { dissolve: true });
    expect(f.store.session(e.sid!)?.role).toBe('none');
    expect(
      (await f.core.handle(e, 'msg.read')).messages.some((m: any) => m.body === 'squad_dissolved'),
    ).toBe(true);
    await expect(
      f.core.handle(c, 'session.join', { role: 'executor', squad: id }),
    ).rejects.toMatchObject({ code: 'SQUAD_NOT_FOUND' });
    expect((await f.core.handle(c, 'session.join', { squad_name: 'alpha' })).squad.id).not.toBe(id);
  });
  it('rejects oversized/invalid messages and ambiguous names', async () => {
    f = fixture();
    const { c, id } = await f.squad();
    const other = await f.session('zcode', 'other');
    await f.core.handle(other, 'session.join', { role: 'executor', squad: id, name: 'tests' });
    await expect(
      f.core.handle(c, 'msg.send', { to: 'tests', message: 'hi' }),
    ).rejects.toMatchObject({ code: 'RECIPIENT_NOT_FOUND' });
    await expect(
      f.core.handle(c, 'msg.send', { to: 'all', message: '汉'.repeat(12000) }),
    ).rejects.toMatchObject({ code: 'MESSAGE_TOO_LARGE' });
    await expect(f.core.handle(c, 'msg.read', { wait: 301 })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(
      f.core.handle(c, 'msg.send', { to: 'all', message: 'x', data: { large: 'x'.repeat(65536) } }),
    ).rejects.toMatchObject({ code: 'MESSAGE_TOO_LARGE' });
  });
  it('rolls back the whole broadcast on queue overflow', async () => {
    f = fixture({ maxQueue: 2 });
    const { c, e, id } = await f.squad();
    const other = await f.session('zcode', 'other');
    await f.core.handle(other, 'session.join', { role: 'executor', squad: id });
    await f.core.handle(c, 'msg.send', { to: other.sid, message: 'one' });
    await f.core.handle(c, 'msg.send', { to: other.sid, message: 'two' });
    await expect(
      f.core.handle(c, 'msg.send', { to: 'all', message: 'broadcast' }),
    ).rejects.toMatchObject({ code: 'QUEUE_FULL' });
    expect(f.store.queue(e.sid!)).toHaveLength(0);
  });
  it('limits sends per session', async () => {
    f = fixture({ rateLimitPerMinute: 1 });
    const { c } = await f.squad();
    await f.core.handle(c, 'msg.send', { to: 'all', message: 'first' });
    await expect(
      f.core.handle(c, 'msg.send', { to: 'all', message: 'second' }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
  it('persists history and queued messages in SQLite', async () => {
    f = fixture();
    const { c, e } = await f.squad();
    await f.core.handle(c, 'msg.send', { to: 'all', message: 'persist' });
    const reopened = new Store(f.p.db);
    expect(reopened.queue(e.sid!)[0].body).toBe('persist');
    reopened.close();
  });
  it('does not dequeue a disconnected long poll', async () => {
    f = fixture();
    const { c, e } = await f.squad();
    const pending = f.core.handle(e, 'msg.read', { wait: 5 });
    const disconnected = expect(pending).rejects.toMatchObject({ code: 'DAEMON_UNAVAILABLE' });
    f.core.disconnect(e);
    await f.core.handle(c, 'msg.send', { to: 'tests', message: 'retained' });
    await disconnected;
    expect(f.store.queue(e.sid!)[0].body).toBe('retained');
  });
});
it('requires commanders to leave before switching named squads and allows in-squad takeover', async () => {
  f = fixture();
  const { c, e, id } = await f.squad();
  await expect(f.core.handle(c, 'session.join', { squad_name: 'Different' })).rejects.toMatchObject(
    { code: 'ALREADY_JOINED' },
  );
  await f.core.handle(c, 'session.leave');
  const takeover = await f.core.handle(e, 'session.join', { role: 'commander', squad: id });
  expect(takeover.me.role).toBe('commander');
  expect(f.store.squad(id)?.commander_sid).toBe(e.sid);
});
