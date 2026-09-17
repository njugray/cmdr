import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.js';
import { Store } from '../src/daemon/store.js';
import { Core } from '../src/daemon/core.js';
import type { Question } from '../src/shared/dashboard.js';
import { LIMITS } from '../src/shared/protocol.js';

const fixtures: ReturnType<typeof fixture>[] = [];
const make = (options = {}) => {
  const f = fixture(options);
  fixtures.push(f);
  return f;
};
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
const answer = (q: Question, extra = {}) => ({
  question_id: q.id,
  version: q.version,
  submission_id: randomUUID(),
  text: 'Approved scope',
  ...extra,
});

it('persists plans and execution summaries independently of message retention and observes without consuming', async () => {
  const f = make();
  const { c, e, id } = await f.squad();
  const { task } = await f.core.handle(c, 'dashboard.task', {
    action: 'create',
    title: 'Ship dashboard',
    acceptance: 'Keep input stable',
  });
  expect(task.state).toBe('planned');
  const sent = await f.core.handle(c, 'msg.send', {
    task_id: task.id,
    to: e.sid,
    message: 'Implement',
  });
  expect(f.core.dashboardSnapshot(id).tasks[0].state).toBe('queued');
  expect(f.store.message(sent.ids[0])?.status).toBe('queued');
  await f.core.handle(e, 'msg.read');
  expect(f.store.dashboardRecord('task', task.id)?.state).toBe('read');
  await f.core.handle(e, 'msg.report', {
    status: 'working',
    reply_to: sent.ids[0],
    message: 'Started',
  });
  await f.core.handle(e, 'msg.report', {
    status: 'blocked',
    reply_to: sent.ids[0],
    message: 'Need decision',
  });
  expect(f.store.dashboardRecord('task', task.id)?.state).toBe('blocked');
  await expect(
    f.core.handle(c, 'dashboard.task', { action: 'archive', id: task.id }),
  ).rejects.toMatchObject({ code: 'UNFINISHED_WORK' });
  await f.core.handle(e, 'msg.report', {
    status: 'done',
    reply_to: sent.ids[0],
    message: 'Verified',
  });
  f.store.expireMessages(Number.MAX_SAFE_INTEGER);
  expect(f.store.message(sent.ids[0])).toBeUndefined();
  const saved = f.store.dashboardRecord('task', task.id)!;
  expect(saved.state).toBe('completed');
  expect(saved.runs[0].report?.message).toBe('Verified');
  await f.core.handle(c, 'dashboard.task', { action: 'archive', id: task.id });
  expect(f.store.dashboardRecord('task', task.id)?.archived).toBe(true);
});

it('preserves task association and cancellation gates through reassignment, late reports and member rebind', async () => {
  const f = make();
  const { c, e, id } = await f.squad();
  const other = await f.session('generic', 'replacement');
  await f.core.handle(other, 'session.join', { squad: id, role: 'executor' });
  const { task } = await f.core.handle(c, 'dashboard.task', {
    action: 'create',
    title: 'One owner',
  });
  const first = (
    await f.core.handle(c, 'msg.send', { task_id: task.id, to: e.sid, message: 'First' })
  ).ids[0];
  await f.core.handle(e, 'msg.report', { status: 'working', reply_to: first, message: 'Started' });
  await expect(
    f.core.handle(c, 'msg.send', { task_id: task.id, to: other.sid, message: 'Duplicate' }),
  ).rejects.toMatchObject({ code: 'TASK_OWNED' });
  const second = (
    await f.core.handle(c, 'msg.send', { to: other.sid, reassign: first, message: 'Replacement' })
  ).ids[0];
  expect(f.store.message(second)?.task_id).toBe(task.id);
  expect(f.store.dashboardRecord('task', task.id)?.state).toBe('blocked');
  await expect(
    f.core.handle(other, 'msg.report', {
      status: 'working',
      reply_to: second,
      message: 'Too early',
    }),
  ).rejects.toMatchObject({ code: 'REASSIGNMENT_PENDING' });
  await f.core.handle(e, 'msg.report', {
    status: 'done',
    reply_to: first,
    message: 'Original finished',
  });
  expect(f.store.dashboardRecord('task', task.id)?.state).toBe('queued');
  const rebound = await f.session('generic', 'new-endpoint');
  const member = f.store.session(other.sid!)!.member_id;
  await f.core.handle(rebound, 'session.join', { rebind: member });
  await f.core.handle(rebound, 'msg.report', {
    status: 'working',
    reply_to: second,
    message: 'Resumed',
  });
  expect(f.store.dashboardRecord('task', task.id)?.runs[1].member_id).toBe(member);
  expect(f.store.dashboardRecord('task', task.id)?.state).toBe('working');
});

it('deduplicates user submissions, retains unhandled answers after read and routes across commander handover', async () => {
  const f = make();
  const { c, e, id } = await f.squad();
  const { question } = await f.core.handle(c, 'msg.ask', {
    target: 'user',
    question: 'Pick scope',
    kind: 'single',
    options: [
      { id: 'small', label: 'Small' },
      { id: 'large', label: 'Large' },
    ],
  });
  const input = answer(question, { selected: ['small'], text: 'This one' });
  const notifications: unknown[] = [];
  f.core.dashboardObservers.add((change) => notifications.push(change));
  const receipt = f.core.submitUserAnswer(input);
  expect(f.core.submitUserAnswer(input)).toEqual(receipt);
  expect(notifications).toHaveLength(1);
  expect(() => f.core.submitUserAnswer({ ...input, text: 'Different' })).toThrowError(
    /Submission ID/,
  );
  expect(f.store.message(receipt.message_id)).toMatchObject({
    from_sid: 'user',
    from_role: 'user',
    to_sid: `squad:${id}`,
    attn: true,
  });
  expect(f.core.actionable(c.sid!).some((m) => m.id === receipt.message_id)).toBe(true);
  await f.core.handle(c, 'msg.read');
  expect(f.store.dashboardRecord('question', question.id)?.status).toBe('answered');
  await f.core.handle(e, 'session.join', { squad: id, role: 'commander', takeover: true });
  await expect(
    f.core.handle(c, 'msg.ask', {
      target: 'user',
      action: 'handle',
      id: question.id,
      version: 1,
      result: 'No',
    }),
  ).rejects.toMatchObject({ code: 'ROLE_NOT_ALLOWED' });
  const pending = await f.core.handle(e, 'msg.ask', {
    target: 'user',
    action: 'list',
    status: 'answered',
  });
  expect(pending.items.map((q: Question) => q.id)).toContain(question.id);
  await f.core.handle(e, 'msg.ask', {
    target: 'user',
    action: 'handle',
    id: question.id,
    version: 1,
    result: 'Dispatch small scope',
  });
  expect(f.store.dashboardRecord('question', question.id)?.status).toBe('handled');
  expect(f.core.submitUserAnswer(input)).toEqual(receipt);
});

it('retains full multilingual answers while bounding generated inbox summaries', async () => {
  const f = make();
  const { c } = await f.squad();
  const options = Array.from({ length: 20 }, (_, n) => ({
    id: `option-${n}`,
    label: '选'.repeat(300),
  }));
  const { question } = await f.core.handle(c, 'msg.ask', {
    target: 'user',
    question: '问'.repeat(200),
    kind: 'multiple',
    options,
  });
  const input = answer(question, { text: '答'.repeat(8000), selected: options.map((o) => o.id) });
  const receipt = f.core.submitUserAnswer(input);
  const message = f.store.message(receipt.message_id)!;
  expect(Buffer.byteLength(message.body)).toBeLessThanOrEqual(LIMITS.maxBody);
  expect(message.data).toMatchObject({ text: input.text, selected: options.map((o) => o.id) });
  expect(f.store.submission(receipt.submission_id)?.snapshot.question.options).toEqual(options);
});

it('saves orphaned answers and rolls back completely when the commander queue is full', async () => {
  const f = make({ maxQueue: 1 });
  const { c, e, id } = await f.squad();
  const { question } = await f.core.handle(c, 'msg.ask', {
    target: 'user',
    question: 'Proceed?',
    kind: 'confirm',
  });
  await f.core.handle(e, 'msg.report', { status: 'ready', message: 'Fill queue' });
  const input = answer(question, { confirmed: false });
  const cursor = f.store.eventCursor();
  expect(() => f.core.submitUserAnswer(input)).toThrowError(/full/);
  expect(f.store.dashboardRecord('question', question.id)?.status).toBe('pending');
  expect(f.store.submission(input.submission_id)).toBeUndefined();
  expect(f.store.eventCursor()).toBe(cursor);
  await f.core.handle(c, 'msg.read');
  await f.core.handle(c, 'session.leave');
  const receipt = f.core.submitUserAnswer(input);
  expect(f.store.message(receipt.message_id)?.to_sid).toBe(`squad:${id}`);
  await f.core.handle(e, 'session.join', { squad: id, role: 'commander' });
  expect(
    (await f.core.handle(e, 'msg.read')).messages.some((m: any) => m.id === receipt.message_id),
  ).toBe(true);
});

it('versions pending question artifacts and retains the exact submitted explanation after edits', async () => {
  const f = make();
  const { c } = await f.squad();
  const { artifact } = await f.core.handle(c, 'dashboard.artifact', {
    title: 'Plan',
    html: '<h1>Before</h1>',
  });
  const { question } = await f.core.handle(c, 'msg.ask', {
    target: 'user',
    question: 'Choose',
    artifact_ids: [artifact.id],
  });
  await f.core.handle(c, 'dashboard.artifact', {
    id: artifact.id,
    version: 1,
    title: 'Plan',
    html: '<h1>Revised</h1>',
  });
  expect(() => f.core.submitUserAnswer(answer(question))).toThrowError(/changed/);
  const q = f.store.dashboardRecord('question', question.id)!;
  expect(q.version).toBe(2);
  const receipt = f.core.submitUserAnswer(answer(q));
  await f.core.handle(c, 'dashboard.artifact', {
    id: artifact.id,
    version: 2,
    title: 'Plan',
    html: '<h1>Later</h1>',
  });
  expect(f.store.submission(receipt.submission_id)?.snapshot.artifacts[0].html).toBe(
    '<h1>Revised</h1>',
  );
  expect(f.store.dashboardRecord('question', question.id)?.version).toBe(2);
  await expect(
    f.core.handle(c, 'msg.ask', {
      target: 'user',
      action: 'update',
      id: q.id,
      version: 2,
      question: 'Change answered content',
    }),
  ).rejects.toMatchObject({ code: 'QUESTION_CLOSED' });
});

it('enforces role and squad boundaries, structured form validation and withdrawal', async () => {
  const f = make();
  const { c, e } = await f.squad();
  const outsider = await f.session('generic', 'other');
  await f.core.handle(outsider, 'session.join', { role: 'commander', squad_name: 'Other' });
  const { task } = await f.core.handle(c, 'dashboard.task', { action: 'create', title: 'Private' });
  await expect(
    f.core.handle(e, 'dashboard.task', { action: 'update', id: task.id, title: 'Unauthorized' }),
  ).rejects.toMatchObject({ code: 'ROLE_NOT_ALLOWED' });
  await expect(
    f.core.handle(outsider, 'dashboard.task', { action: 'get', id: task.id }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(
    f.core.handle(e, 'msg.ask', { target: 'user', question: 'Ask user' }),
  ).rejects.toMatchObject({ code: 'ROLE_NOT_ALLOWED' });
  await expect(
    f.core.handle(c, 'msg.ask', {
      target: 'user',
      question: 'Bad options',
      kind: 'single',
      options: [
        { id: 'a', label: 'A' },
        { id: 'a', label: 'B' },
      ],
    }),
  ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  const { question } = await f.core.handle(c, 'msg.ask', {
    target: 'user',
    question: 'Confirm',
    kind: 'confirm',
  });
  expect(() => f.core.submitUserAnswer(answer(question))).toThrow();
  expect(() =>
    f.core.submitUserAnswer({ ...answer(question, { confirmed: true }), from_sid: 'commander' }),
  ).toThrow();
  await f.core.handle(c, 'msg.ask', {
    target: 'user',
    action: 'withdraw',
    id: question.id,
    version: 1,
  });
  expect(() => f.core.submitUserAnswer(answer(question, { confirmed: true }))).toThrowError(
    'QUESTION_CLOSED',
  );
  // The existing executor -> commander ask remains intact.
  expect((await f.core.handle(e, 'msg.ask', { question: 'Need help' })).id).toBeTruthy();
});

it('recovers dashboard state after restart and preserves closed squads through retention', async () => {
  const f = make({ ttlDays: 0 });
  const { c, id } = await f.squad();
  const { question } = await f.core.handle(c, 'msg.ask', {
    target: 'user',
    question: 'Remember me',
  });
  const receipt = f.core.submitUserAnswer(answer(question));
  await f.core.handle(c, 'session.leave', { dissolve: true });
  f.core.housekeep();
  const db = new Store(f.p.db);
  const core = new Core(db, f.p, f.core.config);
  try {
    expect(core.dashboardSnapshot(id).questions[0].status).toBe('answered');
    expect(db.submission(receipt.submission_id)?.snapshot.question.question).toBe('Remember me');
    expect(core.submitUserAnswer(db.submission(receipt.submission_id)!.input)).toEqual(receipt);
    core.housekeep(true);
    expect(db.dashboardRecord('question', question.id)).toBeUndefined();
  } finally {
    core.close();
    db.close();
  }
});

it('preserves user notes for the next commander and honors queue capacity atomically', async () => {
  const f = make({ maxQueue: 1 });
  const { c, e, id } = await f.squad();
  await f.core.handle(c, 'session.leave');
  const input = { squad_id: id, submission_id: randomUUID(), text: 'Keep the smaller scope' };
  const receipt = f.core.submitUserMessage(input);
  const cursor = f.store.eventCursor();
  expect(() => f.core.submitUserMessage({ ...input, submission_id: randomUUID() })).toThrowError(
    /full/,
  );
  expect(f.store.eventCursor()).toBe(cursor);
  expect(f.core.submitUserMessage(input)).toEqual(receipt);
  const persisted = new Store(f.p.db);
  try {
    expect(persisted.message(receipt.message_id)?.body).toBe(input.text);
  } finally {
    persisted.close();
  }
  expect(
    (await f.core.handle(e, 'msg.read')).messages.some((m: any) => m.id === receipt.message_id),
  ).toBe(false);
  await f.core.handle(e, 'session.join', { squad: id, role: 'commander' });
  const messages = (await f.core.handle(e, 'msg.read')).messages;
  expect(messages.some((m: any) => m.id === receipt.message_id && m.from_role === 'user')).toBe(
    true,
  );
});
