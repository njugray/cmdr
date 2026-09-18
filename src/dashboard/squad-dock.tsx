import { useState } from 'react';
import type { DashboardSnapshot, TaskState } from '../shared/dashboard.js';
import { t as text, locale } from './i18n.js';
import { labels, listenerLabels, wakeLabels, eventLabels, time, clockTime } from './display.js';

export function SquadDock({ current }: { current: DashboardSnapshot }) {
  const [tab, setTab] = useState('members');
  return (
    <section className="squad-dock" aria-label={text('成员与活动')}>
      <div className="dock-heading">
        <div
          className="tabs"
          role="tablist"
          aria-label={text('成员与活动')}
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
            ['members', text('小队成员'), current.members.length],
            ['activity', text('活动记录'), current.activity.length],
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
            ? text('连接与监听状态不代表任务已接单')
            : text('最近 40 条活动 · 任务和答复独立保存')}
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
                <th>{text('成员')}</th>
                <th>{text('连接')}</th>
                <th>{text('自动响应')}</th>
                <th>{text('未完成')}</th>
                <th>{text('当前任务 · 接单')}</th>
                <th>{text('最近报告')}</th>
              </tr>
            </thead>
            <tbody>
              {current.members.map((m) => {
                const commands = m.commands
                  .map((c) => {
                    const task = current.tasks.find((t) =>
                      t.runs.some((r) => r.command_id === c.id || r.blocked_by === c.id),
                    );
                    return `${task?.title || text('协作任务')} · ${c.state === 'accepted' ? text('已接单') : labels[c.state as TaskState] || text('状态未知')}${c.cancel_requested_at ? ' ' + text('· 等待取消确认') : ''}`;
                  })
                  .join(locale === 'zh-CN' ? '；' : '; ');
                const listening = m.listener.can_auto_respond
                  ? text('监听健康')
                  : m.listener.wake_mode === 'manual'
                    ? text('手动继续')
                    : listenerLabels[m.listener.health] || text('状态未知');
                return (
                  <tr key={m.member_id}>
                    <td title={`${m.name || m.agent} · ${m.agent}`}>
                      <div className="member-name">
                        <strong>{m.name || m.agent}</strong>
                        <small>
                          {m.role === 'commander'
                            ? text('指挥官')
                            : m.role === 'executor'
                              ? text('执行者')
                              : text('已离队')}{' '}
                          · {m.agent}
                        </small>
                      </div>
                    </td>
                    <td>
                      <span className={`connection ${m.presence === 'online' ? 'online' : ''}`}>
                        {(
                          {
                            online: text('在线'),
                            offline: text('离线'),
                            cli: text('命令行连接'),
                          } as Record<string, string>
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
                      <span className="truncate" title={commands || text('暂无任务')}>
                        {commands || '—'}
                      </span>
                    </td>
                    <td>
                      <div
                        className="member-report"
                        title={m.last_status?.message || text('暂无记录')}
                      >
                        <time>{m.last_progress_at ? time(m.last_progress_at) : '—'}</time>
                        <span>{m.last_status?.message || text('暂无记录')}</span>
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
                      ? text('唤醒状态更新')
                      : e.kind.startsWith('standby.')
                        ? text('监听状态更新')
                        : text('小队更新'))}
                </strong>
                <span title={e.message}>{e.message || '—'}</span>
              </article>
            ))}
          </div>
        )}
        {(tab === 'members' ? !current.members.length : !current.activity.length) && (
          <p className="dock-empty">
            {tab === 'members' ? text('暂无小队成员') : text('暂无活动记录')}
          </p>
        )}
      </div>
    </section>
  );
}
