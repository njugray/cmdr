import { Fragment, useEffect, useRef, useState } from 'react';
import type { DashboardSnapshot, SquadSummary, TaskState } from '../shared/dashboard.js';
import { t as text } from './i18n.js';
import { api } from './api.js';
import { refreshQueue } from './refresh.js';
import { enc, errorText, labels } from './display.js';
import { QuestionCard, emptyDraft, type Draft } from './question-card.js';
import { TaskDetails } from './task-details.js';
import { CommanderMessage, type MessageDraft } from './commander-message.js';
import { SquadDock } from './squad-dock.js';

interface Overview {
  home: string;
  version: string;
  squads: SquadSummary[];
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
    { title: text('计划'), hint: text('待派发'), states: ['planned'] },
    { title: text('待接单'), hint: text('含已读'), states: ['queued', 'read'] },
    { title: text('进行中'), hint: text('含阻塞'), states: ['working', 'blocked'] },
    {
      title: text('已结束'),
      hint: text('完成 / 失败 / 取消'),
      states: ['completed', 'failed', 'cancelled'],
    },
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
        <div className="brand" aria-label={text('cmdr 看板')}>
          <span className="brand-mark">c</span>
          <span>
            cmdr<small>{text('小队工作台')}</small>
          </span>
        </div>
        <div className="nav-label">
          {text('我的小队')} <span className="mono">{overview?.squads.length || 0}</span>
        </div>
        <nav aria-label={text('小队')}>
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
                  <span
                    className="count-alert"
                    aria-label={`${q.pending_questions} ${text('个待回复问题')}`}
                  >
                    {q.pending_questions}
                  </span>
                )}
              </span>
              <small>
                {q.active_tasks} {text('项执行中 ·')}{' '}
                {q.status === 'dissolved'
                  ? text('已关闭')
                  : q.status === 'orphaned'
                    ? text('等待指挥官')
                    : text('协作中')}
              </small>
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className={`connection ${connected ? 'online' : ''}`}>
            {connected ? text('实时连接') : text('连接中断 · 正在重连')}
          </span>
          <span className="mono">LOCAL · {overview?.version || 'cmdr'}</span>
          <details>
            <summary>{text('当前数据目录')}</summary>
            <code>{overview?.home || text('尚未连接')}</code>
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
            {text('连接中断，正在重连。显示的是最近一次内容。')}
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
              <h1 title={squad?.name || text('小队看板')}>{squad?.name || text('小队看板')}</h1>
              <span className="squad-code mono">{squad?.id}</span>
              <span className="private-badge">{text('自托管')}</span>
              <section className="metrics" aria-label={text('小队概览')}>
                {[
                  [text('看板任务'), squad?.task_count],
                  [text('执行中'), squad?.active_tasks],
                  [text('待你回复'), squad?.pending_questions],
                  [text('成员'), current?.members.length],
                ].map(([label, value]) => (
                  <div key={label}>
                    <b
                      className={
                        label === text('待你回复') && Number(value) > 0 ? 'needs-answer' : ''
                      }
                    >
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

                {text('查看已归档')}
              </label>
            </header>
            {overview?.squads.length === 0 ? (
              <section className="empty-state">
                <h2>{text('还没有小队')}</h2>
                <p>{text('让指挥官加入小队并创建任务，进展和需要你回复的问题会出现在这里。')}</p>
              </section>
            ) : !current ? (
              <div className="loading" role="status">
                {text('正在读取小队…')}
              </div>
            ) : (
              <div
                className="kanban"
                aria-label={showArchived ? text('已归档任务') : text('任务看板')}
              >
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
                        {!items.length && <p className="column-empty">{text('暂无任务')}</p>}
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
                                {needsReply && (
                                  <span className="needs-answer">{text('待回复')}</span>
                                )}
                              </span>
                              <h3>{t.title}</h3>
                              {t.description && <p title={t.description}>{t.description}</p>}
                              <span className="task-owner">
                                {t.runs.at(-1)?.name || t.runs.at(-1)?.sid || text('未指派')}
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
      <aside className="confirmation-panel" aria-label={text('待确认事项')}>
        <header className="confirmation-heading">
          <h2>{text('待确认事项')}</h2>
          <span>
            {text('待你回复')} {pending} {text('· 待处理')} {squad?.unanswered_decisions || 0}
          </span>
        </header>
        <div className="questions">
          {!pending && (
            <div className="questions-empty">
              <p>{text('没有需要你决定的事情')}</p>
              <small>{text('新的问题会出现在这里，并在侧栏计数')}</small>
            </div>
          )}
          {questions.map((q) => {
            const key = `${q.squad_id}/${q.id}`;
            return (
              <Fragment key={key}>
                {q.id === firstOther && <h3 className="other-questions">{text('其他事项')}</h3>}
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
