import { StandbyManager } from './standby.js';
import { createServer } from 'node:net';
import { chmodSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { Core, type Context } from './core.js';
import { Store } from './store.js';
import { acquireLock, releaseLock } from './lock.js';
import { logger, logInternal } from './logger.js';
import { paths, prepare } from '../shared/paths.js';
import { config } from '../shared/config.js';
import { Rpc } from '../shared/rpc.js';
import { MIN_CLIENT_VERSION, PROTOCOL, VERSION, newer } from '../shared/version.js';
import { fail } from '../shared/protocol.js';
import { DashboardServer } from './dashboard-http.js';
export async function startDaemon(home?: string) {
  process.umask(0o077);
  const p = paths(home);
  prepare(p);
  if (!acquireLock(p.lock)) return null;
  const log = logger(p.log),
    store = new Store(p.db),
    core = new Core(store, p, config(p.config));
  const standby = new StandbyManager(core);
  core.configureStandby = (sid, mode) =>
    standby.configure({
      sid,
      action: 'start',
      ...(mode === 'manual' ? { adapter: 'manual' } : {}),
    });
  const wakeTimer = setInterval(() => {
    void standby.tick().catch((e) => log(`standby failed: ${String(e)}`));
  }, 2000);
  const peers = new Set<Rpc>();
  let idleSince = Date.now(),
    stopping = false;
  const dashboard = new DashboardServer(
    core,
    () => {
      idleSince = Date.now();
    },
    undefined,
    log,
  );
  rmSync(p.socket, { force: true });
  const server = createServer((socket) => {
    idleSince = Date.now();
    const rpc = new Rpc(socket);
    peers.add(rpc);
    const ctx: Context = { notify: (m, p) => rpc.notify(m, p) };
    core.connect(ctx);
    let greeted = false;
    let watcher: { sid: string; token: string } | undefined;
    const handle: NonNullable<Rpc['handler']> = async (method, params, signal) => {
      if (!greeted && method !== 'hello')
        fail(
          'PROTOCOL_MISMATCH',
          `First request must be hello {protocol:${PROTOCOL}, version:<client version>}; daemon ${VERSION}. Use cmdr session commands or restart the host MCP connection.`,
        );
      if (method === 'hello') {
        if (params.protocol !== PROTOCOL)
          fail(
            'PROTOCOL_MISMATCH',
            `Protocol mismatch: client ${String(params.protocol).slice(0, 20)}, daemon ${PROTOCOL} (${VERSION}). Update/reinstall the plugin cache, restart the daemon with the matching cmdr installation, then restart the host session.`,
          );
        const clientVersion =
          typeof params.version === 'string'
            ? params.version.match(/^(\d+\.\d+\.\d+)(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/)?.[1]
            : undefined;
        if (!clientVersion || newer(MIN_CLIENT_VERSION, clientVersion))
          fail(
            'PROTOCOL_MISMATCH',
            `Daemon ${VERSION} requires client ${MIN_CLIENT_VERSION} or newer for compatible tool semantics. Update/reinstall the plugin cache and restart the host MCP connection.`,
          );
        greeted = true;
        ctx.version = String(params.version || 'unknown').slice(0, 80);
        ctx.client = String(params.client || 'unknown').slice(0, 80);
        return { version: VERSION, protocol: PROTOCOL };
      }
      if (method === 'admin.watch') {
        if (ctx.kind !== 'cli') fail('ROLE_NOT_ALLOWED');
        if (
          !['attach', 'pulse'].includes(params.action) ||
          typeof params.token !== 'string' ||
          !params.token.length ||
          params.token.length > 100
        )
          fail('INVALID_ARGUMENT');
        if (watcher && (watcher.sid !== params.sid || watcher.token !== params.token))
          fail('WATCHER_ACTIVE');
        const result = standby.watch(params.sid, params.token, params.action);
        watcher = { sid: params.sid, token: params.token };
        return result;
      }
      if (method === 'admin.dashboard') {
        if (ctx.kind !== 'cli') fail('ROLE_NOT_ALLOWED');
        return dashboard.open();
      }
      if (method === 'admin.standby') {
        if (ctx.kind !== 'cli') fail('ROLE_NOT_ALLOWED');
        const result = standby.configure(params);
        void standby.tick();
        return result;
      }
      if (method === 'admin.shutdown') {
        if (params.reason === 'upgrade')
          fail(
            'UPGRADE_REQUIRES_RESTART',
            'Automatic replacement is disabled. Run cmdr daemon restart from the new installation after preflight.',
          );
        if (ctx.kind !== 'cli' && params.reason !== 'upgrade') fail('ROLE_NOT_ALLOWED');
        log(
          `shutdown requested: ${String(params.reason || 'operator')
            .replace(/[^a-z_-]/gi, '')
            .slice(0, 40)}; from=${VERSION}; to=${String(params.version || 'unknown')
            .replace(/[^a-z0-9.:-]/gi, '')
            .slice(0, 80)}`,
        );
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
    rpc.handler = async (method, params, signal) => {
      try {
        return await handle(method, params, signal);
      } catch (e) {
        logInternal(log, method, e);
        throw e;
      }
    };
    rpc.on('close', () => {
      peers.delete(rpc);
      if (!stopping && watcher) {
        try {
          standby.watch(watcher.sid, watcher.token, 'detach');
        } catch {
          /* stopped or replaced */
        }
      }
      if (!stopping) core.disconnect(ctx);
      if (!peers.size) idleSince = Date.now();
    });
  });
  let timer: NodeJS.Timeout;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    clearInterval(wakeTimer);
    standby.close();
    await dashboard.close();
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    for (const ctx of [...core.contexts]) core.disconnect(ctx);
    core.close();
    for (const peer of peers) peer.close();
    await closed;
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
          if (
            !peers.size &&
            !standby.active &&
            !dashboard.active &&
            Date.now() - idleSince >= core.config.idleExitMinutes * 60_000
          )
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
