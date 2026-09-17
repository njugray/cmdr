import { Fragment, useEffect, useRef, useState } from 'react';
import type {
  AnswerInput,
  ArtifactSummary,
  DashboardSnapshot,
  Question,
  SquadSummary,
  Submission,
  Task,
  TaskState,
  UserMessageInput,
  UserMessageReceipt,
} from '../shared/dashboard.js';
import { api, ApiError } from './api.js';
import { refreshQueue } from './refresh.js';

const labels: Record<TaskState, string> = {
  planned: '待派发',
  queued: '待接单',
  read: '已读待接单',
  working: '执行中',
  blocked: '阻塞',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};
const questionLabels = {
  pending: '等待你的答复',
  answered: '答复已接收 · 等待处理',
  handled: '指挥官已处理',
  withdrawn: '已撤回',
};
const listenerLabels: Record<string, string> = {
  starting: '正在启动',
  healthy: '监听健康',
  stopped: '监听已停止',
  manual: '手动继续',
  error: '监听异常',
  uncertain: '状态待确认',
  stalled: '等待响应',
};
const wakeLabels: Record<string, string> = {
  requested: '正在投递',
  accepted: '宿主已接收',
  observed: '已观察到响应',
  uncertain: '投递结果待确认',
  failed: '投递失败',
};
const eventLabels: Record<string, string> = {
  'dashboard.task': '任务更新',
  'dashboard.question': '问题更新',
  'dashboard.artifact': '展示块更新',
  'message.queued': '新消息',
  'message.read': '消息已读',
  'work.cancelled': '任务已取消',
  'work.cancel_requested': '请求取消任务',
  'work.reassigned': '任务重新分配',
  'work.progress': '任务进展',
  'work.released': '后续任务可开始',
  'channel.created': '小队已创建',
  'channel.closed': '小队已关闭',
  'commander.handover': '指挥官交接',
  'commander.claimed': '指挥官就位',
  'member.joined': '成员加入',
  'member.left': '成员离队',
  'member.rebound': '成员会话更新',
  'session.registered': '会话已连接',
  'session.disconnected': '会话已断开',
  'session.activity': '成员活动',
  'session.reset': '会话已重置',
};
const time = (n?: number | null) =>
  n
    ? new Date(n).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '暂无记录';
const errorText = (e: unknown) =>
  e instanceof ApiError && e.code === 'UNAUTHORIZED'
    ? '访问凭证已失效，请重新运行 cmdr dashboard 打开看板。'
    : e instanceof Error
      ? e.message
      : '连接失败，请稍后重试。';
const enc = encodeURIComponent;
const shortId = (id: string) => id.split(':').at(-1)!.slice(-6);
const clockTime = (n: number) =>
  new Date(n).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
interface Overview {
  home: string;
  version: string;
  squads: SquadSummary[];
}
export interface Draft {
  selected: string[];
  text: string;
  confirmed?: boolean;
  version: number;
  attempt?: AnswerInput;
  sending?: boolean;
  error?: string;
}
const emptyDraft = (q: Question): Draft => ({ selected: [], text: '', version: q.version });

export function ArtifactView({
  artifact,
  submission,
}: {
  artifact: ArtifactSummary;
  submission?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const src = `/artifacts/${enc(artifact.id)}/${artifact.version}${submission ? `?submission=${enc(submission)}` : ''}`;
  return (
    <section className={`artifact ${expanded ? 'artifact-expanded' : ''}`}>
      <div className="artifact-heading">
        <span>HTML 展示 · {artifact.title}</span>
        <button type="button" className="subtle" onClick={() => setExpanded(!expanded)}>
          {expanded ? '收起展示' : '扩大展示'}
        </button>
      </div>
      <iframe
        title={artifact.title}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        src={src}
        loading="lazy"
      />
    </section>
  );
}

export function QuestionCard({
  q,
  draft,
  change,
  artifacts,
  taskTitle,
  openTask,
}: {
  q: Question;
  draft: Draft;
  change: (update: (d: Draft) => Draft) => void;
  artifacts: ArtifactSummary[];
  taskTitle?: string;
  openTask?: () => void;
}) {
  const [expanded, setExpanded] = useState(q.status === 'pending');
  const [evidence, setEvidence] = useState<
    Omit<Submission, 'snapshot'> & {
      snapshot: { question: Question; artifacts: ArtifactSummary[] };
    }
  >();
  const [evidenceError, setEvidenceError] = useState('');
  const changed = draft.version !== q.version;
  const locked = !!draft.sending || !!draft.attempt;
  const selectedValid = draft.selected.every((id) => q.options.some((o) => o.id === id));
  const valid =
    selectedValid &&
    (q.kind === 'text'
      ? !!draft.text.trim()
      : q.kind === 'confirm'
        ? draft.confirmed !== undefined
        : q.kind === 'single'
          ? draft.selected.length === 1
          : draft.selected.length > 0);
  async function submit() {
    if (draft.sending || changed || (!draft.attempt && !valid)) return;
    const attempt = draft.attempt || {
      question_id: q.id,
      version: draft.version,
      submission_id: crypto.randomUUID(),
      selected: draft.selected,
      text: draft.text,
      ...(draft.confirmed === undefined ? {} : { confirmed: draft.confirmed }),
    };
    change((d) => ({ ...d, attempt, sending: true, error: undefined }));
    try {
      await api('/api/answers', attempt);
      change((d) => ({ ...d, sending: false, error: '答复已接收，正在同步处理状态。' }));
    } catch (e) {
      const definitive =
        e instanceof ApiError &&
        ['VERSION_CONFLICT', 'QUESTION_CLOSED', 'INVALID_ARGUMENT', 'SUBMISSION_CONFLICT'].includes(
          e.code,
        );
      change((d) => ({
        ...d,
        sending: false,
        attempt: definitive ? undefined : attempt,
        error:
          e instanceof ApiError && e.code === 'VERSION_CONFLICT'
            ? '问题已更新。输入已保留，请核对新内容后再提交。'
            : `${errorText(e)}${definitive ? '' : ' 可以重试同一次提交。'}`,
      }));
    }
  }
  return (
    <article className={`question-card ${q.status}`}>
      {q.status !== 'pending' && !expanded && (
        <button
          className="question-summary"
          type="button"
          onClick={() => setExpanded(true)}
          aria-expanded={false}
        >
          <span className={`question-dot ${q.status}`} />
          <span className="summary-copy">
            <strong>{q.question}</strong>
            <small>
              {questionLabels[q.status]}
              {q.result ? ` · ${q.result}` : ''}
            </small>
          </span>
          <time>{time(q.created_at)}</time>
        </button>
      )}
      <div className="question-content" hidden={q.status !== 'pending' && !expanded}>
        <div className="card-eyebrow">
          <span className="mono" title={q.id}>
            Q-{shortId(q.id)} · {time(q.created_at)}
          </span>
          <span className={`question-state ${q.status}`}>{questionLabels[q.status]}</span>
        </div>
        <h3>{q.question}</h3>
        {q.description && <p className="preserve description">{q.description}</p>}
        <div className="question-reference">
          {taskTitle && (
            <>
              关联任务{' '}
              <button type="button" className="subtle" onClick={openTask}>
                {taskTitle}
              </button>
              <span>·</span>
            </>
          )}
          <span>内容版本 v{q.version}</span>
          {q.status !== 'pending' && (
            <button
              className="subtle collapse-question"
              type="button"
              onClick={() => setExpanded(false)}
              aria-expanded={true}
            >
              收起
            </button>
          )}
        </div>
        {q.status === 'pending' && artifacts.map((a) => <ArtifactView key={a.id} artifact={a} />)}
        {q.status === 'pending' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            {changed && (
              <div className="notice">
                <p>问题或补充说明已更新。你的输入已保留，请核对新内容。</p>
                <button
                  type="button"
                  disabled={!!draft.sending}
                  onClick={() =>
                    change((d) => ({
                      ...d,
                      version: q.version,
                      attempt: undefined,
                      selected: d.selected.filter((id) => q.options.some((o) => o.id === id)),
                      confirmed: q.kind === 'confirm' ? d.confirmed : undefined,
                      error: undefined,
                    }))
                  }
                >
                  已核对新内容
                </button>
              </div>
            )}
            <fieldset disabled={locked}>
              <legend>
                {q.kind === 'multiple'
                  ? '选择所有适用项'
                  : q.kind === 'single'
                    ? '选择一项'
                    : q.kind === 'confirm'
                      ? '请确认'
                      : '你的答复'}
              </legend>
              {['single', 'multiple'].includes(q.kind) && (
                <div className="options">
                  {q.options.map((o) => (
                    <label
                      key={o.id}
                      className={draft.selected.includes(o.id) ? 'option chosen' : 'option'}
                    >
                      <input
                        type={q.kind === 'single' ? 'radio' : 'checkbox'}
                        name={q.id}
                        value={o.id}
                        checked={draft.selected.includes(o.id)}
                        onChange={() =>
                          change((d) => ({
                            ...d,
                            selected:
                              q.kind === 'single'
                                ? [o.id]
                                : d.selected.includes(o.id)
                                  ? d.selected.filter((x) => x !== o.id)
                                  : [...d.selected, o.id],
                          }))
                        }
                      />
                      {o.label}
                    </label>
                  ))}
                </div>
              )}
              {q.kind === 'confirm' && (
                <div className="options">
                  {[true, false].map((value) => (
                    <label
                      key={String(value)}
                      className={draft.confirmed === value ? 'option chosen' : 'option'}
                    >
                      <input
                        type="radio"
                        name={q.id}
                        checked={draft.confirmed === value}
                        onChange={() => change((d) => ({ ...d, confirmed: value }))}
                      />
                      {value ? '确认' : '拒绝'}
                    </label>
                  ))}
                </div>
              )}
              <label className="input-label" htmlFor={`${q.id}-text`}>
                {q.kind === 'text' ? '填写答复' : '补充说明（选填）'}
              </label>
              <textarea
                id={`${q.id}-text`}
                maxLength={8000}
                rows={3}
                value={draft.text}
                onChange={(e) => {
                  const text = e.target.value;
                  change((d) => ({ ...d, text }));
                }}
                placeholder="写下你的意见…"
              />
            </fieldset>
            <div className="form-footer">
              <span className="muted">草稿已保留，仅在点击提交后发送</span>
              <button
                className="primary"
                disabled={!!draft.sending || changed || (!draft.attempt && !valid)}
              >
                {draft.sending ? '正在提交…' : draft.attempt ? '重试提交' : '提交答复'}
              </button>
            </div>
            {draft.error && (
              <p role="status" className="notice">
                {draft.error}
              </p>
            )}
          </form>
        )}
        {q.answer && (
          <div className="answer-receipt">
            <b>你的答复</b>
            <p className="preserve">
              {q.options
                .filter((o) => q.answer!.selected.includes(o.id))
                .map((o) => o.label)
                .join('、')}
              {q.answer.confirmed === undefined ? '' : q.answer.confirmed ? '确认' : '拒绝'}
              {q.answer.text && `\n${q.answer.text}`}
            </p>
            <span className="muted">接收于 {time(q.answer.received_at)}</span>
            <details
              onToggle={(e) => {
                if (e.currentTarget.open && !evidence)
                  void api<typeof evidence>(`/api/submissions/${enc(q.answer!.submission_id)}`)
                    .then(setEvidence)
                    .catch((error) => setEvidenceError(errorText(error)));
              }}
            >
              <summary>查看提交时的说明</summary>
              {evidence ? (
                <>
                  <p className="preserve">
                    {evidence.snapshot.question.description || '没有补充文字说明。'}
                  </p>
                  {evidence.snapshot.artifacts.map((a) => (
                    <ArtifactView key={a.id} artifact={a} submission={q.answer!.submission_id} />
                  ))}
                </>
              ) : (
                <p>{evidenceError || '正在读取…'}</p>
              )}
            </details>
          </div>
        )}
        {q.result && (
          <div className="handled-result">
            <b>处理说明</b>
            <p className="preserve">{q.result}</p>
            <time>处理时间 {time(q.updated_at)}</time>
          </div>
        )}
      </div>
    </article>
  );
}

function TaskDetails({
  task,
  artifacts,
  close,
  needsReply,
}: {
  task: Task;
  artifacts: ArtifactSummary[];
  close: () => void;
  needsReply: boolean;
}) {
  const [history, setHistory] = useState<{ task: Task; next: number | null }>();
  const [historyError, setHistoryError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const request = ++generation.current;
    setLoadingMore(false);
    api<{ task: Task; next: number | null }>(`/api/tasks/${enc(task.id)}`)
      .then((data) => {
        if (generation.current === request) {
          setHistory(data);
          setHistoryError('');
        }
      })
      .catch((e) => {
        if (generation.current === request) setHistoryError(errorText(e));
      });
    return () => {
      generation.current++;
    };
  }, [task.id, task.updated_at]);
  const loaded = history?.task.id === task.id ? history : undefined;
  const latest = task.runs.at(-1);
  async function more() {
    if (loaded?.next == null || loadingMore) return;
    const request = generation.current;
    setLoadingMore(true);
    try {
      const data = await api<{ task: Task; next: number | null }>(
        `/api/tasks/${enc(task.id)}?offset=${loaded.next}`,
      );
      if (generation.current === request) {
        setHistory((old) =>
          old?.task.id === data.task.id
            ? {
                task: { ...data.task, runs: [...old.task.runs, ...data.task.runs] },
                next: data.next,
              }
            : old,
        );
        setHistoryError('');
      }
    } catch (e) {
      if (generation.current === request) setHistoryError(errorText(e));
    } finally {
      if (generation.current === request) setLoadingMore(false);
    }
  }
  return (
    <section className="task-details" aria-label="任务详情">
      <header className="detail-heading">
        <button type="button" className="back-button" onClick={close}>
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <path d="M15 6l-6 6 6 6" />
          </svg>
          返回看板
        </button>
        <span className={`status ${task.state}`}>{labels[task.state]}</span>
        <h1 title={task.title}>{task.title}</h1>
        {needsReply && <span className="needs-answer">待回复</span>}
        <span className="detail-owner mono" title={task.id}>
          T-{shortId(task.id)} · {latest?.name || latest?.sid || '未指派'}
        </span>
      </header>
      <div className="detail-body">
        <section className="detail-description">
          <div>
            <h2>任务说明</h2>
            <p className="preserve">{task.description || '暂无说明'}</p>
          </div>
          {task.acceptance && (
            <div>
              <h2>验收条件</h2>
              <p className="preserve">{task.acceptance}</p>
            </div>
          )}
          {artifacts.map((a) => (
            <ArtifactView key={a.id} artifact={a} />
          ))}
          {task.state === 'blocked' && latest?.report && (
            <div className="blocked-reason">
              <h2>阻塞原因</h2>
              <p className="preserve">{latest.report.message}</p>
            </div>
          )}
        </section>
        <aside className="execution-history">
          <div className="history-heading">
            <h2>
              执行记录 <span className="mono">{task.run_count || 0}</span>
            </h2>
            {loaded?.next != null && (
              <button
                type="button"
                className="subtle"
                disabled={loadingMore}
                onClick={() => void more()}
              >
                {loadingMore ? '正在读取…' : '加载更早记录'}
              </button>
            )}
          </div>
          {task.runs.length === 0 && <p className="muted">尚未派发给小队成员。</p>}
          {(loaded?.task.runs || task.runs).map((r) => (
            <section className="run" key={r.command_id}>
              <time title={time(r.created_at)}>{clockTime(r.created_at)}</time>
              <div>
                <b>{r.name || r.sid}</b>
                <span className="run-state">
                  {r.work.state === 'accepted' ? '已接单' : labels[r.work.state as TaskState]}
                </span>
                <p className="preserve">{r.message}</p>
                {r.work.cancel_requested_at && (
                  <p className="notice">已请求取消，执行终态以成员报告为准。</p>
                )}
                {r.report && <p className="preserve report">{r.report.message}</p>}
                <code title={r.command_id}>{r.command_id}</code>
              </div>
            </section>
          ))}
          {historyError && (
            <p className="notice" role="status">
              {historyError}
            </p>
          )}
          {latest?.report && (
            <section className="latest-report">
              <h2>最近报告</h2>
              <div>
                <time>
                  {time(latest.report.at)} · {latest.name || latest.sid}
                </time>
                <p className="preserve">{latest.report.message}</p>
              </div>
            </section>
          )}
          <p className="execution-note">
            派发、编辑与取消由指挥官工具完成，看板不提供拖动改状态的入口。
          </p>
        </aside>
      </div>
    </section>
  );
}

interface MessageDraft {
  text: string;
  attempt?: UserMessageInput;
  sending?: boolean;
  notice?: string;
}
export function CommanderMessage({
  squad,
  draft,
  change,
}: {
  squad: SquadSummary;
  draft: MessageDraft;
  change: (update: (d: MessageDraft) => MessageDraft) => void;
}) {
  async function submit() {
    if (draft.sending || !draft.text.trim() || squad.status === 'dissolved') return;
    const attempt = draft.attempt || {
      squad_id: squad.id,
      submission_id: crypto.randomUUID(),
      text: draft.text.trim(),
    };
    change((d) => ({ ...d, attempt, sending: true, notice: undefined }));
    try {
      const receipt = await api<UserMessageReceipt>('/api/messages', attempt);
      change(() => ({
        text: '',
        notice: `已发送 · ${time(receipt.received_at)}，等待指挥官读取。`,
      }));
    } catch (e) {
      const definitive =
        e instanceof ApiError &&
        ['INVALID_ARGUMENT', 'SQUAD_NOT_FOUND', 'SUBMISSION_CONFLICT', 'QUEUE_FULL'].includes(
          e.code,
        );
      change((d) => ({
        ...d,
        sending: false,
        attempt: definitive ? undefined : attempt,
        notice: errorText(e),
      }));
    }
  }
  return (
    <form
      className="commander-message"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor="commander-message">向指挥官留言（不直接修改任务）</label>
      <div className="message-input-row">
        <input
          id="commander-message"
          value={draft.text}
          maxLength={8000}
          placeholder="例如：把异常场景回归提到最高优先级"
          disabled={!!draft.attempt || squad.status === 'dissolved'}
          onChange={(e) => {
            const text = e.target.value;
            change((d) => ({ ...d, text, notice: undefined }));
          }}
        />
        <button disabled={!!draft.sending || !draft.text.trim() || squad.status === 'dissolved'}>
          {draft.sending ? '发送中…' : draft.attempt ? '重试发送' : '发送'}
        </button>
      </div>
      {draft.notice && <p role="status">{draft.notice}</p>}
      {squad.status === 'dissolved' && <p>小队已关闭，无法发送留言。</p>}
    </form>
  );
}

function SquadDock({ current }: { current: DashboardSnapshot }) {
  const [tab, setTab] = useState('members');
  return (
    <section className="squad-dock" aria-label="成员与活动">
      <div className="dock-heading">
        <div
          className="tabs"
          role="tablist"
          aria-label="成员与活动"
          onKeyDown={(e) => {
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
              e.preventDefault();
              const next =
                e.key === 'Home'
                  ? 'members'
                  : e.key === 'End'
                    ? 'activity'
                    : tab === 'members'
                      ? 'activity'
                      : 'members';
              setTab(next);
              document.getElementById(`tab-${next}`)?.focus();
            }
          }}
        >
          {[
            ['members', '小队成员', current.members.length],
            ['activity', '活动记录', current.activity.length],
          ].map(([id, label, count]) => (
            <button
              role="tab"
              type="button"
              key={id}
              id={`tab-${id}`}
              aria-controls={`panel-${id}`}
              aria-selected={tab === id}
              tabIndex={tab === id ? 0 : -1}
              onClick={() => setTab(String(id))}
            >
              {label}
              <span className="mono">{count}</span>
            </button>
          ))}
        </div>
        <span className="dock-hint">
          {tab === 'members'
            ? '连接与监听状态不代表任务已接单'
            : '最近 40 条活动 · 任务和答复独立保存'}
        </span>
      </div>
      <div
        className="dock-content"
        role="tabpanel"
        id={`panel-${tab}`}
        aria-labelledby={`tab-${tab}`}
        tabIndex={0}
      >
        {tab === 'members' ? (
          <table className="members-table">
            <thead>
              <tr>
                <th>成员</th>
                <th>连接</th>
                <th>自动响应</th>
                <th>未完成</th>
                <th>当前任务 · 接单</th>
                <th>最近报告</th>
              </tr>
            </thead>
            <tbody>
              {current.members.map((m) => {
                const commands = m.commands
                  .map((c) => {
                    const task = current.tasks.find((t) =>
                      t.runs.some((r) => r.command_id === c.id || r.blocked_by === c.id),
                    );
                    return `${task?.title || '协作任务'} · ${c.state === 'accepted' ? '已接单' : labels[c.state as TaskState] || '状态未知'}${c.cancel_requested_at ? ' · 等待取消确认' : ''}`;
                  })
                  .join('；');
                const listening = m.listener.can_auto_respond
                  ? '监听健康'
                  : m.listener.wake_mode === 'manual'
                    ? '手动继续'
                    : listenerLabels[m.listener.health] || '状态未知';
                return (
                  <tr key={m.member_id}>
                    <td title={`${m.name || m.agent} · ${m.agent}`}>
                      <div className="member-name">
                        <strong>{m.name || m.agent}</strong>
                        <small>
                          {m.role === 'commander'
                            ? '指挥官'
                            : m.role === 'executor'
                              ? '执行者'
                              : '已离队'}{' '}
                          · {m.agent}
                        </small>
                      </div>
                    </td>
                    <td>
                      <span className={`connection ${m.presence === 'online' ? 'online' : ''}`}>
                        {(
                          { online: '在线', offline: '离线', cli: '命令行连接' } as Record<
                            string,
                            string
                          >
                        )[m.presence] || m.presence}
                      </span>
                    </td>
                    <td>
                      <span
                        className={m.listener.error ? 'listener-error' : ''}
                        title={[
                          listening,
                          m.listener.error,
                          m.listener.request && wakeLabels[m.listener.request.state],
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      >
                        {listening}
                      </span>
                    </td>
                    <td className="mono">{m.commands.length}</td>
                    <td>
                      <span className="truncate" title={commands || '暂无任务'}>
                        {commands || '—'}
                      </span>
                    </td>
                    <td>
                      <div className="member-report" title={m.last_status?.message || '暂无记录'}>
                        <time>{m.last_progress_at ? time(m.last_progress_at) : '—'}</time>
                        <span>{m.last_status?.message || '暂无记录'}</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="activity-list">
            {current.activity.map((e) => (
              <article key={e.id}>
                <time title={time(e.at)}>{clockTime(e.at)}</time>
                <strong>
                  {eventLabels[e.kind] ||
                    (e.kind.startsWith('wake.')
                      ? '唤醒状态更新'
                      : e.kind.startsWith('standby.')
                        ? '监听状态更新'
                        : '小队更新')}
                </strong>
                <span title={e.message}>{e.message || '—'}</span>
              </article>
            ))}
          </div>
        )}
        {(tab === 'members' ? !current.members.length : !current.activity.length) && (
          <p className="dock-empty">{tab === 'members' ? '暂无小队成员' : '暂无活动记录'}</p>
        )}
      </div>
    </section>
  );
}

export function App() {
  const [ready, setReady] = useState(false);
  const [overview, setOverview] = useState<Overview>();
  const [selected, setSelected] = useState('');
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>();
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [taskId, setTaskId] = useState<string>();
  const [showArchived, setShowArchived] = useState(false);
  const [messages, setMessages] = useState<Record<string, MessageDraft>>({});
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const selection = useRef(selected);
  selection.current = selected;
  const refreshDetail = useRef<() => void>(() => {});
  useEffect(() => {
    let alive = true;
    const key = window.location.hash.slice(1);
    window.history.replaceState(null, '', window.location.pathname);
    (key ? api('/api/session', { token: key }) : Promise.resolve())
      .then(() => {
        if (alive) setReady(true);
      })
      .catch((e) => {
        if (alive) setError(errorText(e));
      });
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    const refresh = refreshQueue(
      async () => {
        const state = await api<Overview>('/api/state');
        if (!alive) return;
        setOverview(state);
        setSelected((current) =>
          state.squads.some((q) => q.id === current) ? current : state.squads[0]?.id || '',
        );
        setError('');
      },
      (e) => setError(errorText(e)),
    );
    const source = new EventSource('/api/events');
    source.onopen = () => {
      setConnected(true);
      refresh.invalidate();
      refreshDetail.current();
    };
    source.onmessage = (event) => {
      refresh.invalidate();
      try {
        const { squads } = JSON.parse(event.data);
        if (squads.includes(null) || squads.includes(selection.current)) refreshDetail.current();
      } catch {
        refreshDetail.current();
      }
    };
    source.onerror = () => {
      setConnected(false);
      refresh.invalidate();
    };
    return () => {
      alive = false;
      source.close();
      refresh.close();
    };
  }, [ready]);
  useEffect(() => {
    if (!ready || !selected) {
      setSnapshot(undefined);
      return;
    }
    let alive = true;
    const refresh = refreshQueue(
      async () => {
        const data = await api<DashboardSnapshot>(`/api/squads/${enc(selected)}`);
        if (alive) {
          setSnapshot(data);
          setError('');
        }
      },
      (e) => setError(errorText(e)),
    );
    refreshDetail.current = () => refresh.invalidate();
    refresh.invalidate();
    return () => {
      alive = false;
      refresh.close();
      refreshDetail.current = () => {};
    };
  }, [ready, selected]);
  const current = snapshot?.squad.id === selected ? snapshot : undefined;
  const squad = overview?.squads.find((q) => q.id === selected);
  const activeTask = current?.tasks.find((t) => t.id === taskId);
  const artifactList = (ids: string[]) =>
    current?.artifacts.filter((a) => ids.includes(a.id)) || [];
  const tasks =
    current?.tasks
      .filter((t) => t.archived === showArchived)
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)) || [];
  const pending = current?.questions.filter((q) => q.status === 'pending').length || 0;
  const columns: { title: string; hint: string; states: TaskState[] }[] = [
    { title: '计划', hint: '待派发', states: ['planned'] },
    { title: '待接单', hint: '含已读', states: ['queued', 'read'] },
    { title: '进行中', hint: '含阻塞', states: ['working', 'blocked'] },
    { title: '已结束', hint: '完成 / 失败 / 取消', states: ['completed', 'failed', 'cancelled'] },
  ];
  const questions = [...(current?.questions || [])].sort(
    (a, b) =>
      Number(b.status === 'pending') - Number(a.status === 'pending') ||
      b.created_at - a.created_at,
  );
  const firstOther = questions.find((q) => q.status !== 'pending')?.id;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand" aria-label="cmdr 看板">
          <span className="brand-mark">c</span>
          <span>
            cmdr<small>小队工作台</small>
          </span>
        </div>
        <div className="nav-label">
          我的小队 <span className="mono">{overview?.squads.length || 0}</span>
        </div>
        <nav aria-label="小队">
          {overview?.squads.map((q) => (
            <button
              key={q.id}
              className={`squad-link ${q.id === selected ? 'selected' : ''}`}
              aria-current={q.id === selected ? 'page' : undefined}
              onClick={() => {
                setSelected(q.id);
                setTaskId(undefined);
              }}
            >
              <span className="squad-name">
                {q.name || q.id}
                {q.pending_questions > 0 && (
                  <span className="count-alert" aria-label={`${q.pending_questions} 个待回复问题`}>
                    {q.pending_questions}
                  </span>
                )}
              </span>
              <small>
                {q.active_tasks} 项执行中 ·{' '}
                {q.status === 'dissolved'
                  ? '已关闭'
                  : q.status === 'orphaned'
                    ? '等待指挥官'
                    : '协作中'}
              </small>
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className={`connection ${connected ? 'online' : ''}`}>
            {connected ? '实时连接' : '连接中断 · 正在重连'}
          </span>
          <span className="mono">LOCAL · {overview?.version || 'cmdr'}</span>
          <details>
            <summary>当前数据目录</summary>
            <code>{overview?.home || '尚未连接'}</code>
          </details>
        </div>
      </aside>
      <main className="workspace">
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        {!connected && overview && (
          <p className="connection-notice" role="status">
            连接中断，正在重连。显示的是最近一次内容。
          </p>
        )}
        {activeTask ? (
          <TaskDetails
            key={activeTask.id}
            task={activeTask}
            artifacts={artifactList(activeTask.artifact_ids)}
            close={() => setTaskId(undefined)}
            needsReply={questions.some(
              (q) => q.task_id === activeTask.id && q.status === 'pending',
            )}
          />
        ) : (
          <>
            <header className="page-header">
              <h1 title={squad?.name || '小队看板'}>{squad?.name || '小队看板'}</h1>
              <span className="squad-code mono">{squad?.id}</span>
              <span className="private-badge">本机私有</span>
              <section className="metrics" aria-label="小队概览">
                {[
                  ['看板任务', squad?.task_count],
                  ['执行中', squad?.active_tasks],
                  ['待你回复', squad?.pending_questions],
                  ['成员', current?.members.length],
                ].map(([label, value]) => (
                  <div key={label}>
                    <b className={label === '待你回复' && Number(value) > 0 ? 'needs-answer' : ''}>
                      {value ?? '—'}
                    </b>
                    <span>{label}</span>
                  </div>
                ))}
              </section>
              <label className="archive-toggle">
                <input
                  type="checkbox"
                  checked={showArchived}
                  onChange={(e) => setShowArchived(e.target.checked)}
                />
                查看已归档
              </label>
            </header>
            {overview?.squads.length === 0 ? (
              <section className="empty-state">
                <h2>还没有小队</h2>
                <p>让指挥官加入小队并创建任务，进展和需要你回复的问题会出现在这里。</p>
              </section>
            ) : !current ? (
              <div className="loading" role="status">
                正在读取小队…
              </div>
            ) : (
              <div className="kanban" aria-label={showArchived ? '已归档任务' : '任务看板'}>
                {columns.map((column) => {
                  const items = tasks.filter((t) => column.states.includes(t.state));
                  return (
                    <section className="column" key={column.title}>
                      <h2>
                        <span>{column.title}</span>
                        <span className="column-hint">{column.hint}</span>
                        <small className="mono">{items.length}</small>
                      </h2>
                      <div className="column-items">
                        {!items.length && <p className="column-empty">暂无任务</p>}
                        {items.map((t) => {
                          const needsReply = questions.some(
                            (q) => q.task_id === t.id && q.status === 'pending',
                          );
                          return (
                            <button
                              className={`task-card ${needsReply ? 'awaiting' : ''}`}
                              key={t.id}
                              onClick={() => setTaskId(t.id)}
                            >
                              <span className="task-badges">
                                <span className={`status ${t.state}`}>{labels[t.state]}</span>
                                {needsReply && <span className="needs-answer">待回复</span>}
                              </span>
                              <h3>{t.title}</h3>
                              {t.description && <p title={t.description}>{t.description}</p>}
                              <span className="task-owner">
                                {t.runs.at(-1)?.name || t.runs.at(-1)?.sid || '未指派'}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  );
                })}
              </div>
            )}
          </>
        )}
        {current && <SquadDock current={current} />}
      </main>
      <aside className="confirmation-panel" aria-label="待确认事项">
        <header className="confirmation-heading">
          <h2>待确认事项</h2>
          <span>
            待你回复 {pending} · 待处理 {squad?.unanswered_decisions || 0}
          </span>
        </header>
        <div className="questions">
          {!pending && (
            <div className="questions-empty">
              <p>没有需要你决定的事情</p>
              <small>新的问题会出现在这里，并在侧栏计数</small>
            </div>
          )}
          {questions.map((q) => {
            const key = `${q.squad_id}/${q.id}`;
            return (
              <Fragment key={key}>
                {q.id === firstOther && <h3 className="other-questions">其他事项</h3>}
                <QuestionCard
                  q={q}
                  draft={drafts[key] || emptyDraft(q)}
                  change={(update) =>
                    setDrafts((all) => ({ ...all, [key]: update(all[key] || emptyDraft(q)) }))
                  }
                  artifacts={artifactList(q.artifact_ids)}
                  taskTitle={current?.tasks.find((t) => t.id === q.task_id)?.title}
                  openTask={() => setTaskId(q.task_id)}
                />
              </Fragment>
            );
          })}
        </div>
        {squad && (
          <CommanderMessage
            squad={squad}
            draft={messages[squad.id] || { text: '' }}
            change={(update) =>
              setMessages((all) => ({ ...all, [squad.id]: update(all[squad.id] || { text: '' }) }))
            }
          />
        )}
      </aside>
    </div>
  );
}
