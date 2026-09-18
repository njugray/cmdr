import { useEffect, useRef, useState } from 'react';
import type { ArtifactSummary, Task, TaskState } from '../shared/dashboard.js';
import { t as text } from './i18n.js';
import { api } from './api.js';
import { enc, time, clockTime, shortId, errorText, labels } from './display.js';
import { ArtifactView } from './artifact-view.js';

export function TaskDetails({
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
    <section className="task-details" aria-label={text('任务详情')}>
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

          {text('返回看板')}
        </button>
        <span className={`status ${task.state}`}>{labels[task.state]}</span>
        <h1 title={task.title}>{task.title}</h1>
        {needsReply && <span className="needs-answer">{text('待回复')}</span>}
        <span className="detail-owner mono" title={task.id}>
          T-{shortId(task.id)} · {latest?.name || latest?.sid || text('未指派')}
        </span>
      </header>
      <div className="detail-body">
        <section className="detail-description">
          <div>
            <h2>{text('任务说明')}</h2>
            <p className="preserve">{task.description || text('暂无说明')}</p>
          </div>
          {task.acceptance && (
            <div>
              <h2>{text('验收条件')}</h2>
              <p className="preserve">{task.acceptance}</p>
            </div>
          )}
          {artifacts.map((a) => (
            <ArtifactView key={a.id} artifact={a} />
          ))}
          {task.state === 'blocked' && latest?.report && (
            <div className="blocked-reason">
              <h2>{text('阻塞原因')}</h2>
              <p className="preserve">{latest.report.message}</p>
            </div>
          )}
        </section>
        <aside className="execution-history">
          <div className="history-heading">
            <h2>
              {text('执行记录')} <span className="mono">{task.run_count || 0}</span>
            </h2>
            {loaded?.next != null && (
              <button
                type="button"
                className="subtle"
                disabled={loadingMore}
                onClick={() => void more()}
              >
                {loadingMore ? text('正在读取…') : text('加载更早记录')}
              </button>
            )}
          </div>
          {task.runs.length === 0 && <p className="muted">{text('尚未派发给小队成员。')}</p>}
          {(loaded?.task.runs || task.runs).map((r) => (
            <section className="run" key={r.command_id}>
              <time title={time(r.created_at)}>{clockTime(r.created_at)}</time>
              <div>
                <b>{r.name || r.sid}</b>
                <span className="run-state">
                  {r.work.state === 'accepted' ? text('已接单') : labels[r.work.state as TaskState]}
                </span>
                <p className="preserve">{r.message}</p>
                {r.work.cancel_requested_at && (
                  <p className="notice">{text('已请求取消，执行终态以成员报告为准。')}</p>
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
              <h2>{text('最近报告')}</h2>
              <div>
                <time>
                  {time(latest.report.at)} · {latest.name || latest.sid}
                </time>
                <p className="preserve">{latest.report.message}</p>
              </div>
            </section>
          )}
          <p className="execution-note">
            {text('派发、编辑与取消由指挥官工具完成，看板不提供拖动改状态的入口。')}
          </p>
        </aside>
      </div>
    </section>
  );
}
