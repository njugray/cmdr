import type { TaskState } from '../shared/dashboard.js';
import { t as text, locale } from './i18n.js';
import { ApiError } from './api.js';

export const labels: Record<TaskState, string> = {
  planned: text('待派发'),
  queued: text('待接单'),
  read: text('已读待接单'),
  working: text('执行中'),
  blocked: text('阻塞'),
  completed: text('已完成'),
  failed: text('失败'),
  cancelled: text('已取消'),
};
export const questionLabels = {
  pending: text('等待你的答复'),
  answered: text('答复已接收 · 等待处理'),
  handled: text('指挥官已处理'),
  withdrawn: text('已撤回'),
};
export const listenerLabels: Record<string, string> = {
  starting: text('正在启动'),
  healthy: text('监听健康'),
  stopped: text('监听已停止'),
  manual: text('手动继续'),
  error: text('监听异常'),
  uncertain: text('状态待确认'),
  stalled: text('等待响应'),
};
export const wakeLabels: Record<string, string> = {
  requested: text('正在投递'),
  accepted: text('宿主已接收'),
  observed: text('已观察到响应'),
  uncertain: text('投递结果待确认'),
  failed: text('投递失败'),
};
export const eventLabels: Record<string, string> = {
  'dashboard.task': text('任务更新'),
  'dashboard.question': text('问题更新'),
  'dashboard.artifact': text('展示块更新'),
  'message.queued': text('新消息'),
  'message.read': text('消息已读'),
  'work.cancelled': text('任务已取消'),
  'work.cancel_requested': text('请求取消任务'),
  'work.reassigned': text('任务重新分配'),
  'work.progress': text('任务进展'),
  'work.released': text('后续任务可开始'),
  'channel.created': text('小队已创建'),
  'channel.closed': text('小队已关闭'),
  'commander.handover': text('指挥官交接'),
  'commander.claimed': text('指挥官就位'),
  'member.joined': text('成员加入'),
  'member.left': text('成员离队'),
  'member.rebound': text('成员会话更新'),
  'session.registered': text('会话已连接'),
  'session.disconnected': text('会话已断开'),
  'session.activity': text('成员活动'),
  'session.reset': text('会话已重置'),
};
export const time = (n?: number | null) =>
  n
    ? new Date(n).toLocaleString(locale, {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : text('暂无记录');
export const errorText = (e: unknown) =>
  e instanceof ApiError && e.code === 'UNAUTHORIZED'
    ? text('访问凭证已失效，请重新运行 cmdr dashboard 打开看板。')
    : e instanceof Error
      ? e.message
      : text('连接失败，请稍后重试。');
export const enc = encodeURIComponent;
export const shortId = (id: string) => id.split(':').at(-1)!.slice(-6);
export const clockTime = (n: number) =>
  new Date(n).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
