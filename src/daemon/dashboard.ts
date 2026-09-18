import { randomUUID } from 'node:crypto';
import { fail, type Message, type Session } from '../shared/protocol.js';
import {
  DASHBOARD_LIMITS,
  type Task,
  type Question,
  type Artifact,
  type AnswerInput,
  type Submission,
} from '../shared/dashboard.js';
import { Store } from './store.js';

const ended = (state: string) => ['completed', 'failed', 'cancelled'].includes(state);
const summary = ({ html: _html, ...artifact }: Artifact) => artifact;
const page = <T>(items: T[], p: { offset: number; limit: number }) => ({
  items: items.slice(p.offset, p.offset + p.limit),
  total: items.length,
  next: p.offset + p.limit < items.length ? p.offset + p.limit : null,
});

// Called inside Core's transaction. The browser and MCP share the same records;
// only Core's trusted user submission entry point can enqueue a user answer.
export class Dashboard {
  constructor(
    private store: Store,
    private changed: (kind: string, squad: string, id: string) => void,
  ) {}
  private capacity(kind: 'task' | 'question' | 'artifact', squad: string) {
    if (this.store.dashboardRecords(kind, squad).length >= DASHBOARD_LIMITS.recordsPerKind)
      fail(
        'DASHBOARD_FULL',
        `At most ${DASHBOARD_LIMITS.recordsPerKind} ${kind} records per squad, including archived records.`,
      );
  }
  get<K extends 'task' | 'question' | 'artifact'>(kind: K, id: string | undefined, squad: string) {
    const record = id && this.store.dashboardRecord(kind, id);
    if (!record || record.squad_id !== squad) fail('NOT_FOUND', `${kind} not found in this squad`);
    return record;
  }
  private artifacts(ids: string[], squad: string) {
    if (new Set(ids).size !== ids.length) fail('INVALID_ARGUMENT', 'Duplicate artifact IDs');
    return ids.map((id) => this.get('artifact', id, squad));
  }
  private write(kind: 'task' | 'question' | 'artifact', record: Task | Question | Artifact) {
    this.store.saveDashboard(kind, record);
    this.changed(`dashboard.${kind}`, record.squad_id, record.id);
  }
  task(s: Session, p: any) {
    const squad = s.squad_id!;
    if (p.action === 'get') return this.taskDetail(p.id, squad, p.offset, p.limit);
    if (p.action === 'list')
      return page(
        this.store
          .dashboardRecords('task', squad)
          .filter((t) => p.archived === undefined || t.archived === p.archived)
          .map(({ runs, description: _description, acceptance: _acceptance, ...t }) => ({
            ...t,
            current: runs.at(-1)
              ? { command_id: runs.at(-1)!.command_id, member_id: runs.at(-1)!.member_id }
              : null,
          })),
        p,
      );
    if (s.role !== 'commander') fail('ROLE_NOT_ALLOWED');
    let task: Task;
    if (p.action === 'create') {
      this.capacity('task', squad);
      if (!p.title || p.id) fail('INVALID_ARGUMENT', 'Creating a task requires title and no id');
      task = {
        id: `task:${randomUUID()}`,
        squad_id: squad,
        title: p.title,
        description: '',
        acceptance: '',
        position: Date.now(),
        artifact_ids: [],
        archived: false,
        state: 'planned',
        runs: [],
        created_at: Date.now(),
        updated_at: Date.now(),
      };
    } else task = this.get('task', p.id, squad);
    if (p.action === 'archive' || p.action === 'restore') {
      if (p.action === 'archive' && task.runs.some((r) => !ended(r.work.state)))
        fail('UNFINISHED_WORK', 'Unfinished work cannot be archived');
      task.archived = p.action === 'archive';
    } else {
      if (p.archived !== undefined) fail('INVALID_ARGUMENT', 'Use archive/restore actions');
      for (const key of ['title', 'description', 'acceptance', 'position', 'artifact_ids'] as const)
        if (p[key] !== undefined) (task as any)[key] = p[key];
      this.artifacts(task.artifact_ids, squad);
    }
    task.updated_at = Date.now();
    this.write('task', task);
    return this.taskDetail(task.id, squad, 0, 20);
  }
  taskDetail(id: string, squad: string, offset = 0, limit = 20) {
    const task = this.get('task', id, squad);
    const runs = page([...task.runs].reverse(), { offset, limit });
    return { task: { ...task, runs: runs.items, run_count: runs.total }, next: runs.next };
  }
  beforeDispatch(id: string, squad: string, previous?: Message) {
    const task = this.get('task', id, squad);
    if (task.archived) fail('TASK_ARCHIVED');
    if (task.runs.length >= DASHBOARD_LIMITS.runsPerTask)
      fail('DASHBOARD_FULL', 'Task execution history is full');
    const active = task.runs.filter((r) => !ended(r.work.state));
    if (active.some((r) => r.command_id !== previous?.id))
      fail('TASK_OWNED', 'Use reassign for this task’s current unfinished command');
    if (previous && (previous.task_id !== task.id || task.runs.at(-1)?.command_id !== previous.id))
      fail('INVALID_ARGUMENT', 'Reassignment must preserve its task');
    return task;
  }
  attach(task: Task, m: Message, owner: Session) {
    task.runs.push({
      command_id: m.id,
      member_id: owner.member_id || owner.sid,
      sid: owner.sid,
      name: owner.name,
      message: m.body.slice(0, 2000),
      work: { ...m.work! },
      blocked_by: m.blocked_by,
      created_at: m.created_at,
    });
    this.store.linkTask(m.id, task.id);
    this.store.saveDashboard('task', task);
    this.syncCommand(m);
  }
  syncCommand(m: Message, report?: { status: string; message: string; at: number }) {
    if (m.type !== 'command') return;
    const task = this.store.commandTask(m.id);
    if (!task) return;
    const run = task.runs.find((r) => r.command_id === m.id)!;
    run.work = { ...m.work! };
    if (report) run.report = { ...report, message: report.message.slice(0, 2000) };
    const current = task.runs.at(-1)!;
    const waiting =
      current.blocked_by &&
      !ended(task.runs.find((r) => r.command_id === current.blocked_by)?.work.state || 'queued');
    task.state = waiting
      ? 'blocked'
      : current.work.state === 'accepted'
        ? current.report?.status === 'blocked'
          ? 'blocked'
          : 'working'
        : current.work.state;
    task.updated_at = Date.now();
    this.write('task', task);
  }
  question(s: Session, p: any) {
    if (s.role !== 'commander') fail('ROLE_NOT_ALLOWED');
    const squad = s.squad_id!;
    if (p.wait || p.reply_to || p.data)
      fail(
        'INVALID_ARGUMENT',
        'User questions use durable answers; wait/reply_to/data are for executor asks',
      );
    if (p.action === 'list')
      return page(
        this.store
          .dashboardRecords('question', squad)
          .filter((q) => !p.status || p.status === q.status)
          .map(({ question, description: _description, options: _options, answer, ...q }) => ({
            ...q,
            question: question.slice(0, 300),
            answer: answer
              ? { submission_id: answer.submission_id, received_at: answer.received_at }
              : undefined,
          })),
        p,
      );
    if (p.action === 'get') return { question: this.get('question', p.id, squad) };
    let q: Question;
    if (p.action === 'create') {
      this.capacity('question', squad);
      if (!p.question || p.id || p.version)
        fail('INVALID_ARGUMENT', 'Creating a question requires question and no id/version');
      q = {
        id: `question:${randomUUID()}`,
        squad_id: squad,
        question: p.question,
        description: '',
        kind: 'text',
        options: [],
        artifact_ids: [],
        version: 1,
        status: 'pending',
        created_at: Date.now(),
        updated_at: Date.now(),
      };
    } else {
      q = this.get('question', p.id, squad);
      if (p.version !== q.version)
        fail('VERSION_CONFLICT', 'Read the current question before changing it');
    }
    if (p.action === 'handle') {
      if (!['answered', 'handled'].includes(q.status) || !p.result?.trim())
        fail('INVALID_ARGUMENT', 'An answered question and a nonempty result are required');
      q.status = 'handled';
      q.result = p.result;
    } else if (p.action === 'withdraw') {
      if (!['pending', 'withdrawn'].includes(q.status)) fail('QUESTION_CLOSED');
      q.status = 'withdrawn';
    } else {
      if (q.status !== 'pending') fail('QUESTION_CLOSED', 'Create a new question to ask again');
      for (const key of [
        'question',
        'description',
        'kind',
        'options',
        'artifact_ids',
        'task_id',
      ] as const)
        if (p[key] !== undefined) (q as any)[key] = p[key];
      if (q.task_id) this.get('task', q.task_id, squad);
      this.artifacts(q.artifact_ids, squad);
      const choice = ['single', 'multiple'].includes(q.kind);
      if (
        (choice && q.options.length < 2) ||
        (!choice && q.options.length) ||
        new Set(q.options.map((o) => o.id)).size !== q.options.length
      )
        fail(
          'INVALID_ARGUMENT',
          'Choice questions require 2–20 unique options; text/confirm questions have none',
        );
      if (p.action === 'update') q.version++;
    }
    q.updated_at = Date.now();
    this.write('question', q);
    return { question: q };
  }
  artifact(s: Session, p: any) {
    const squad = s.squad_id!;
    if (p.action === 'list')
      return page(this.store.dashboardRecords('artifact', squad).map(summary), p);
    if (p.action === 'get') return { artifact: this.get('artifact', p.id, squad) };
    if (s.role !== 'commander') fail('ROLE_NOT_ALLOWED');
    if (!p.title || !p.html)
      fail('INVALID_ARGUMENT', 'Publishing requires title and self-contained html');
    let a: Artifact;
    if (p.id) {
      a = this.get('artifact', p.id, squad);
      if (p.version !== a.version) fail('VERSION_CONFLICT');
      a.version++;
    } else {
      if (p.version) fail('INVALID_ARGUMENT');
      this.capacity('artifact', squad);
      a = {
        id: `artifact:${randomUUID()}`,
        squad_id: squad,
        title: '',
        html: '',
        version: 1,
        created_at: Date.now(),
        updated_at: Date.now(),
      };
    }
    const bytes = this.store
      .dashboardRecords('artifact', squad)
      .filter((x) => x.id !== a.id)
      .reduce((n, x) => n + Buffer.byteLength(x.html), Buffer.byteLength(p.html));
    if (bytes > DASHBOARD_LIMITS.htmlBytesPerSquad)
      fail('DASHBOARD_FULL', 'HTML quota exceeded (8 MiB per squad)');
    a.title = p.title;
    a.html = p.html;
    a.updated_at = Date.now();
    this.write('artifact', a);
    for (const q of this.store.dashboardRecords('question', squad))
      if (q.status === 'pending' && q.artifact_ids.includes(a.id)) {
        q.version++;
        q.updated_at = Date.now();
        this.write('question', q);
      }
    return { artifact: summary(a) };
  }
  answer(
    input: AnswerInput,
    enqueue: (q: Question, body: string, data: Record<string, unknown>) => Message,
  ) {
    const normalized = { ...input, selected: [...input.selected].sort() };
    const prior = this.store.submission(input.submission_id);
    if (prior) {
      if (JSON.stringify(prior.input) !== JSON.stringify(normalized))
        fail('SUBMISSION_CONFLICT', 'Submission ID was already used with different content');
      return prior.receipt;
    }
    const q = this.store.dashboardRecord('question', input.question_id) || fail('NOT_FOUND');
    if (q.version !== input.version)
      fail('VERSION_CONFLICT', 'Question changed; review the new content before submitting');
    if (q.status !== 'pending') fail('QUESTION_CLOSED');
    if (this.store.squad(q.squad_id)?.status === 'dissolved')
      fail('QUESTION_CLOSED', 'Squad is closed');
    const choices = ['single', 'multiple'].includes(q.kind);
    if (
      new Set(input.selected).size !== input.selected.length ||
      input.selected.some((id) => !q.options.some((o) => o.id === id)) ||
      (q.kind === 'single' && input.selected.length !== 1) ||
      (q.kind === 'multiple' && !input.selected.length) ||
      (!choices && input.selected.length) ||
      (q.kind === 'confirm' ? input.confirmed === undefined : input.confirmed !== undefined) ||
      (q.kind === 'text' && !input.text.trim())
    )
      fail('INVALID_ARGUMENT', 'Answer does not match question type/options');
    const snapshot = {
      question: structuredClone(q),
      artifacts: this.artifacts(q.artifact_ids, q.squad_id),
    };
    const selected = q.options
      .filter((o) => input.selected.includes(o.id))
      .map((o) => o.label)
      .join(', ')
      .slice(0, 2000);
    const m = enqueue(
      q,
      `User answered: ${q.question.slice(0, 200)}\n${selected || (input.confirmed === undefined ? '' : input.confirmed ? 'Confirmed' : 'Declined')}\n${input.text}`.trim(),
      {
        source: 'dashboard',
        question_id: q.id,
        version: q.version,
        submission_id: input.submission_id,
        selected: input.selected,
        text: input.text,
        ...(input.confirmed === undefined ? {} : { confirmed: input.confirmed }),
      },
    );
    const receipt = {
      question_id: q.id,
      version: q.version,
      submission_id: input.submission_id,
      received_at: Date.now(),
      message_id: m.id,
    };
    const submission: Submission = { input: normalized, receipt, snapshot };
    this.store.saveSubmission(submission);
    q.answer = { ...normalized, received_at: receipt.received_at, message_id: m.id };
    q.status = 'answered';
    q.updated_at = receipt.received_at;
    this.write('question', q);
    return receipt;
  }
  summaries() {
    return this.store.squads().map((q) => {
      const tasks = this.store.dashboardRecords('task', q.id).filter((t) => !t.archived);
      const questions = this.store.dashboardRecords('question', q.id);
      return {
        ...q,
        task_count: tasks.length,
        active_tasks: tasks.filter((t) => !ended(t.state) && t.state !== 'planned').length,
        pending_questions: questions.filter((x) => x.status === 'pending').length,
        unanswered_decisions: questions.filter((x) => x.status === 'answered').length,
      };
    });
  }
  snapshot(squad: string) {
    return {
      squad: this.store.squad(squad) || fail('SQUAD_NOT_FOUND'),
      tasks: this.store
        .dashboardRecords('task', squad)
        .map((t) => ({ ...t, runs: t.runs.slice(-1), run_count: t.runs.length })),
      questions: this.store.dashboardRecords('question', squad),
      artifacts: this.store.dashboardRecords('artifact', squad).map(summary),
      activity: this.store.recentEvents(squad).map((e) => ({
        id: e.event_seq,
        at: e.at,
        kind: e.kind,
        message: e.message?.body.slice(0, 200) || e.reason,
      })),
    };
  }
}
