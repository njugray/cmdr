import { daemonConnection } from '../shared/client.js';
import type { LifecycleEvent } from '../shared/protocol.js';

export async function tail(options: {
  after?: number;
  for?: string;
  squad?: string;
  full?: boolean;
  json?: boolean;
  follow?: boolean;
}) {
  let after = options.after,
    stopped = false;
  let connection: Awaited<ReturnType<typeof daemonConnection>> | undefined;
  const stop = () => {
    stopped = true;
    connection?.close();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const show = (event: LifecycleEvent) => {
    if (after !== undefined && event.event_seq <= after) return;
    process.stdout.write(
      options.json
        ? JSON.stringify(event) + '\n'
        : `${event.event_seq} ${new Date(event.at).toISOString()} ${event.channel || '-'} ${event.kind} ${event.from_sid || '-'} → ${event.to_sid || '-'} ${event.message_id || ''}${event.reply_to ? ` reply_to=${event.reply_to}` : ''}${event.reason ? ` ${event.reason}` : ''}${event.message ? ` ${event.message.body.replace(/\s+/g, ' ')}` : ''}\n`,
    );
    after = event.event_seq;
  };
  try {
    do {
      try {
        const rpc = (connection = await daemonConnection());
        const closed = new Promise<void>((resolve) => rpc.once('close', resolve));
        await rpc.request('session.register', { kind: 'cli' });
        let replaying = true;
        const buffer: LifecycleEvent[] = [];
        rpc.on('notification', (method, value) => {
          if (method === 'lifecycle.event') replaying ? buffer.push(value) : show(value);
        });
        let result = await rpc.request(options.follow ? 'admin.tail' : 'admin.events', {
          ...options,
          after,
        });
        if (result.gap) {
          const gap = { kind: 'retention.gap', after, retained_after: result.retained_after };
          if (options.json) process.stdout.write(JSON.stringify(gap) + '\n');
          else
            process.stderr.write(
              `cmdr: event retention gap; events through ${result.retained_after} expired\n`,
            );
        }
        for (;;) {
          for (const event of result.events) show(event);
          after = Math.max(after || 0, result.next);
          if (result.next >= result.high) break;
          result = await rpc.request('admin.events', { ...options, after });
        }
        replaying = false;
        for (const event of buffer.sort((a, b) => a.event_seq - b.event_seq)) show(event);
        if (!options.follow) rpc.close();
        else await closed;
      } catch (e) {
        if (!options.follow || stopped) {
          if (!stopped) throw e;
        } else
          process.stderr.write(
            `cmdr tail: ${String(e)}; reconnecting after ${after ?? 'latest'}\n`,
          );
      } finally {
        connection?.close();
        connection = undefined;
      }
      if (options.follow && !stopped) await new Promise((r) => setTimeout(r, 1000));
    } while (options.follow && !stopped);
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
