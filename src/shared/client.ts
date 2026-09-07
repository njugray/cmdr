import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { paths, prepare, type Paths } from './paths.js';
import { Rpc } from './rpc.js';
import { CmdrError } from './protocol.js';
import { PROTOCOL, VERSION, newer } from './version.js';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function dial(p: Paths, timeout = 1000) {
  return new Promise<Rpc>((resolve, reject) => {
    const socket = connect(p.socket);
    const timer = setTimeout(() => socket.destroy(new Error('connect timeout')), timeout);
    socket.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(new Rpc(socket));
    });
  });
}
export async function daemonConnection(
  options: { home?: string; start?: boolean; upgrade?: boolean; timeout?: number } = {},
) {
  const p = paths(options.home),
    timeout = options.timeout || 1000;
  if (options.start) prepare(p);
  let owner = false,
    spawned = false;
  try {
    for (let attempt = 0; attempt < (options.start ? 65 : 1); attempt++) {
      let rpc: Rpc | undefined;
      try {
        rpc = await dial(p, timeout);
        const hello = await rpc.request(
          'hello',
          { client: 'cmdr', version: VERSION, protocol: PROTOCOL },
          timeout,
        );
        if (options.upgrade && newer(VERSION, hello.version)) {
          await rpc.request('admin.shutdown', { reason: 'upgrade' }, timeout);
          rpc.close();
          await sleep(100);
          continue;
        }
        return rpc;
      } catch (e: any) {
        rpc?.close();
        if (e.code === 'PROTOCOL_MISMATCH' || !options.start) throw e;
      }
      if (!owner) {
        try {
          mkdirSync(p.spawn, { mode: 0o700 });
          owner = true;
        } catch {
          try {
            if (Date.now() - statSync(p.spawn).mtimeMs > 10_000)
              rmSync(p.spawn, { recursive: true, force: true });
          } catch {
            /* another starter */
          }
        }
      }
      if (owner) {
        // Only one spawn per lock acquisition. A later caller may retry after failure.
        if (attempt === 0 || !spawned) {
          const child = spawn(
            process.execPath,
            ['--experimental-sqlite', join(dirname(fileURLToPath(import.meta.url)), 'daemon.mjs')],
            { detached: true, stdio: 'ignore', env: { ...process.env, CMDR_HOME: p.home } },
          );
          child.on('error', () => {});
          child.unref();
          spawned = true;
        }
      }
      await sleep(50);
    }
  } finally {
    if (owner) rmSync(p.spawn, { recursive: true, force: true });
    spawned = false;
  }
  throw new CmdrError('DAEMON_UNAVAILABLE', 'Cannot start cmdr daemon. Run cmdr doctor.');
}
export async function quickCall(
  method: string,
  params: any = {},
  options: { home?: string; start?: boolean; timeout?: number; kind?: 'cli' | 'hook' } = {},
) {
  const rpc = await daemonConnection({ ...options, upgrade: !!options.start });
  try {
    if (options.kind !== 'hook')
      await rpc.request('session.register', { kind: 'cli' }, options.timeout || 5000);
    return await rpc.request(method, params, options.timeout || 5000);
  } finally {
    rpc.close();
  }
}
export class DaemonClient {
  rpc?: Rpc;
  private connecting?: Promise<Rpc>;
  private stopped = false;
  private retry?: NodeJS.Timeout;
  private backoff = 100;
  constructor(
    private registration: any,
    private home?: string,
  ) {}
  async connect(): Promise<Rpc> {
    if (this.stopped) throw new CmdrError('DAEMON_UNAVAILABLE');
    if (this.rpc && !this.rpc.socket.destroyed) return this.rpc;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const rpc = await daemonConnection({ home: this.home, start: true, upgrade: true });
      try {
        const result = await rpc.request('session.register', this.registration);
        this.registration.sid = result.me.sid;
        this.rpc = rpc;
        this.backoff = 100;
        rpc.on('notification', (method, params) => {
          if (method === 'session.reset') rpc.close();
          if (method === 'session.bound') {
            this.registration.sid = params.sid;
            this.registration.native_id = params.native_id;
          }
        });
        rpc.on('close', () => {
          if (this.rpc === rpc) this.rpc = undefined;
          this.schedule();
        });
        return rpc;
      } catch (e) {
        rpc.close();
        throw e;
      }
    })();
    try {
      return await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }
  private schedule() {
    if (this.stopped || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      this.connect().catch(() => {
        this.backoff = Math.min(5000, this.backoff * 2);
        this.schedule();
      });
    }, this.backoff);
    this.retry.unref();
  }
  get nativeId(): string | undefined {
    return this.registration.native_id;
  }
  async identify(native: string) {
    const rpc = await this.connect();
    const result = await rpc.request('session.identify', { native_id: native });
    this.registration.sid = result.me.sid;
    this.registration.native_id = result.session.native_id;
  }
  async call(method: string, params: any, signal?: AbortSignal) {
    const rpc = await this.connect();
    return rpc.request(method, params, (Number(params.wait) || 0) * 1000 + 5000, signal);
  }
  close() {
    this.stopped = true;
    clearTimeout(this.retry);
    this.rpc?.close();
  }
}
