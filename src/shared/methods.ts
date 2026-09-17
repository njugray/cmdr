import type { Tool } from './schemas.js';
export const methods: Record<Tool, string> = {
  join: 'session.join',
  list: 'session.list',
  send: 'msg.send',
  report: 'msg.report',
  ask: 'msg.ask',
  read: 'msg.read',
  leave: 'session.leave',
  task: 'dashboard.task',
  artifact: 'dashboard.artifact',
};
