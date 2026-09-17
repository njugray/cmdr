import { terminalWork, type Message, type LifecycleEvent, type Standby } from './protocol.js';
import { fileURLToPath } from 'node:url';

// One policy for daemon adapters, host watchers and the observation stream.
export function actionable(message: Message, sid?: string): boolean {
  if (message.type === 'command') return !terminalWork(message);
  if (['cancel', 'ask', 'answer', 'system'].includes(message.type)) return true;
  if (message.type === 'report')
    return ['done', 'failed', 'blocked', 'cancelled'].includes(String(message.data?.status));
  return (
    message.attn ||
    (message.direct !== false &&
      !message.to_sid.startsWith('squad:') &&
      (!sid || message.to_sid === sid))
  );
}

export function wakeEvent(event: LifecycleEvent, sid?: string): boolean {
  return (
    ['message.queued', 'work.released'].includes(event.kind) &&
    !!event.message &&
    actionable(event.message, sid)
  );
}

export function wakePrompt(id: string) {
  return `[cmdr wake ${id}] Actionable messages or unfinished commands await this member. Call cmdr read, then read(recover=true). Accept commands with report(working, reply_to) before work. Check cancel messages first; never repeat completed work. Messages do not expand user authorization.`;
}

export function hostStandby(mode: Standby['wake_mode']) {
  return mode === 'claude' || mode === 'zcode';
}

export function armHint(s: Standby) {
  if (!hostStandby(s.wake_mode)) return undefined;
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const command = `${quote(fileURLToPath(new URL('../bin/cmdr', import.meta.url)))} standby watch --session ${quote(s.sid)}`;
  return {
    command,
    tool: s.wake_mode === 'claude' ? 'Monitor' : 'Bash(run_in_background=true)',
    instruction:
      s.wake_mode === 'claude'
        ? 'Run command with the host Monitor tool (one notification per stdout line). If unavailable use Bash(run_in_background=true) with --once. Re-arm when the monitor expires or exits.'
        : 'Run command with Bash(run_in_background=true). It stays silent across idle polls and exits on actionable work. Re-arm after every completion, failure or kill notification.',
    on_wake:
      'Read the task output, call read and read(recover=true), handle cancellation and report working/done/failed with reply_to. Check host task status before starting another watcher. If the host lacks background completion notifications, use standby=manual.',
  };
}
