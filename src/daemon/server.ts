import { createServer } from 'node:net';
import { chmodSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { Core, type Context } from './core.js';
import { Store } from './store.js';
import { acquireLock, releaseLock } from './lock.js';
import { logger } from './logger.js';
import { paths, prepare } from '../shared/paths.js';
import { config } from '../shared/config.js';
import { Rpc } from '../shared/rpc.js';
import { PROTOCOL, VERSION } from '../shared/version.js';
import { fail } from '../shared/protocol.js';
export async function startDaemon(home?: string) {
  process.umask(0o077);
  const p = paths(home);
  prepare(p);
  if (!acquireLock(p.lock)) return null;
  const log = logger(p.log),
    store = new Store(p.db),
    core = new Core(store, p, config(p.config));
  const peers = new Set<Rpc>();
  let idleSince = Date.now(),
    stopping = false;
  rmSync(p.socket, { force: true });
  const server = createServer((socket) => {
    idleSince = Date.now();
    const rpc = new Rpc(socket);
    peers.add(rpc);
    const ctx: Context = { notify: (m, p) => rpc.notify(m, p) };
    core.connect(ctx);
    let greeted = false;
    rpc.handler = async (method, params, signal) => {
      if (!greeted && method !== 'hello') fail('PROTOCOL_MISMATCH', 'First request must be hello');
      if (method === 'hello') {
        if (params.protocol !== PROTOCOL)
          fail('PROTOCOL_MISMATCH', 'cmdr upgraded; restart the host session.');
        greeted = true;
        return { version: VERSION, protocol: PROTOCOL };
      }
      if (method === 'admin.shutdown') {
        if (ctx.kind !== 'cli' && params.reason !== 'upgrade') fail('ROLE_NOT_ALLOWED');
        log(`shutdown requested: ${params.reason || 'operator'}`);
        setTimeout(() => {
          void stop();
        }, 30);
        return { stopping: true };
      }
      const result = await core.handle(ctx, method, params, signal);
      return method === 'admin.status'
        ? { ...result, version: VERSION, protocol: PROTOCOL, pid: process.pid }
        : result;
    };
    rpc.on('close', () => {
      peers.delete(rpc);
      if (!stopping) core.disconnect(ctx);
      if (!peers.size) idleSince = Date.now();
    });
  });
  let timer: NodeJS.Timeout;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    server.close();
    for (const ctx of [...core.contexts]) core.disconnect(ctx);
    core.close();
    for (const peer of peers) peer.close();
    store.close();
    rmSync(p.socket, { force: true });
    rmSync(p.info, { force: true });
    releaseLock(p.lock);
    process.off('SIGTERM', signalStop);
    process.off('SIGINT', signalStop);
    log('daemon stopped');
  };
  const signalStop = () => {
    void stop();
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(p.socket, resolve);
    });
    chmodSync(p.socket, 0o600);
    writeFileSync(
      p.info,
      JSON.stringify({
        pid: process.pid,
        version: VERSION,
        protocol: PROTOCOL,
        started_at: Date.now(),
      }),
      { mode: 0o600 },
    );
    timer = setInterval(
      () => {
        try {
          core.housekeep();
          if (existsSync(p.spawn) && Date.now() - statSync(p.spawn).mtimeMs > 10_000)
            rmSync(p.spawn, { recursive: true, force: true });
          if (!peers.size && Date.now() - idleSince >= core.config.idleExitMinutes * 60_000)
            void stop();
        } catch (e) {
          log(`housekeeping failed: ${String(e)}`);
        }
      },
      Math.min(60_000, core.config.idleExitMinutes * 60_000),
    );
    process.on('SIGTERM', signalStop);
    process.on('SIGINT', signalStop);
    log(`cmdr daemon ${VERSION} listening`);
    return { core, stop, server };
  } catch (e) {
    await stop();
    throw e;
  }
}
