import { randomUUID } from 'node:crypto';
import { daemonConnection } from '../shared/client.js';

// Run inside Monitor (stream) or the host's background Bash (one-shot). The host,
// not a detached cmdr daemon, owns the task whose notification wakes the model.
export async function watch(sid: string, once = false) {
  const rpc = await daemonConnection({ start: true, upgrade: true });
  const token = randomUUID();
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let checking = false;
  let dirty = false;
  let error: unknown;
  const seen = new Set<string>();
  const stop = () => {
    stopped = true;
    rpc.close();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const closed = new Promise<void>((resolve) =>
    rpc.once('close', () => {
      if (!stopped) error ||= new Error('cmdr daemon disconnected; re-arm the host watcher');
      resolve();
    }),
  );
  const show = (result: any, initial = false) => {
    const current = new Set<string>();
    const fresh = result.messages.filter((m: any) => {
      const key = JSON.stringify([m.id, m.cancel_requested_at]);
      current.add(key);
      // Re-arming must not wake again just because an owned command is blocked.
      // Keep it recoverable, but seed it as seen; pending cancellation still wakes.
      const alreadyAccepted =
        initial && m.type === 'command' && m.work_state === 'accepted' && !m.cancel_requested_at;
      return !alreadyAccepted && !seen.has(key);
    });
    seen.clear();
    for (const key of current) seen.add(key);
    if (!fresh.length) return;
    process.stdout.write(
      JSON.stringify({
        kind: 'cmdr.wake',
        sid,
        messages: fresh,
        instruction:
          'Call read and read(recover=true); handle cancellation first and report with reply_to.',
      }) + '\n',
    );
    if (once || result.wake_mode === 'zcode') stop();
  };
  const check = async () => {
    if (stopped) return;
    if (checking) {
      dirty = true;
      return;
    }
    checking = true;
    try {
      do {
        dirty = false;
        show(await rpc.request('admin.watch', { sid, token, action: 'pulse' }));
      } while (dirty && !stopped);
    } catch (e) {
      if (!stopped) {
        error = e;
        stop();
      }
    } finally {
      checking = false;
    }
  };
  try {
    await rpc.request('session.register', { kind: 'cli' });
    // Subscribe before the snapshot: arrivals between these two calls are covered.
    rpc.on('notification', (method) => {
      if (method === 'lifecycle.event') {
        dirty = true;
        if (timer) void check();
      }
    });
    await rpc.request('admin.tail', { for: sid, after: 'now' });
    show(await rpc.request('admin.watch', { sid, token, action: 'attach' }), true);
    if (!stopped) {
      timer = setInterval(() => {
        void check();
      }, 30000);
      if (dirty) await check();
    }
    await closed;
    if (error) throw error;
  } finally {
    clearInterval(timer);
    stopped = true;
    rpc.close();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
