import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { CmdrError, LIMITS } from './protocol.js';
export class Rpc extends EventEmitter {
  private buffer = '';
  private next = 1;
  private pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
      cleanup: () => void;
    }
  >();
  private active = new Map<number, AbortController>();
  handler?: (method: string, params: any, signal: AbortSignal) => Promise<any>;
  constructor(public socket: Socket) {
    super();
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > LIMITS.maxFrame) {
        socket.destroy();
        return;
      }
      let at: number;
      while ((at = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, at);
        this.buffer = this.buffer.slice(at + 1);
        if (line.trim()) void this.receive(line);
      }
    });
    socket.on('error', () => {
      /* close rejects pending calls */
    });
    socket.on('close', () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.cleanup();
        p.reject(new CmdrError('DAEMON_UNAVAILABLE'));
      }
      this.pending.clear();
      for (const c of this.active.values()) c.abort();
      this.active.clear();
      this.emit('close');
    });
  }
  private async receive(line: string) {
    let m: any;
    try {
      m = JSON.parse(line);
      if (!m || m.jsonrpc !== '2.0' || Array.isArray(m)) throw new Error();
    } catch {
      this.send({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Invalid JSON-RPC frame' },
      });
      return;
    }
    if (typeof m.method === 'string') {
      if (m.id === undefined) {
        if (m.method === 'rpc.cancel') this.active.get(m.params?.id)?.abort();
        else this.emit('notification', m.method, m.params);
        return;
      }
      const controller = new AbortController();
      this.active.set(m.id, controller);
      try {
        const result = await this.handler?.(m.method, m.params || {}, controller.signal);
        this.send({ jsonrpc: '2.0', id: m.id, result: result ?? null });
      } catch (e: any) {
        this.send({
          jsonrpc: '2.0',
          id: m.id,
          error: {
            code: e instanceof CmdrError ? -32000 : -32603,
            message: e instanceof CmdrError ? e.message : 'Internal daemon error',
            data: { code: e instanceof CmdrError ? e.code : 'INTERNAL_ERROR' },
          },
        });
      } finally {
        this.active.delete(m.id);
      }
    } else if (this.pending.has(m.id)) {
      const p = this.pending.get(m.id)!;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      p.cleanup();
      if (m.error) p.reject(new CmdrError(m.error.data?.code || 'RPC_ERROR', m.error.message));
      else p.resolve(m.result);
    }
  }
  private send(value: unknown) {
    if (!this.socket.destroyed && this.socket.writable)
      this.socket.write(JSON.stringify(value) + '\n');
  }
  request(method: string, params: any = {}, timeout = 5000, signal?: AbortSignal): Promise<any> {
    if (this.socket.destroyed) return Promise.reject(new CmdrError('DAEMON_UNAVAILABLE'));
    if (signal?.aborted) return Promise.reject(new CmdrError('REQUEST_CANCELLED'));
    return new Promise((resolve, reject) => {
      const id = this.next++;
      const cancel = (code: string) => {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.cleanup();
        this.notify('rpc.cancel', { id });
        reject(new CmdrError(code));
      };
      const abort = () => cancel('REQUEST_CANCELLED');
      const timer = setTimeout(() => cancel('DAEMON_UNAVAILABLE'), timeout);
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        cleanup: () => signal?.removeEventListener('abort', abort),
      });
      signal?.addEventListener('abort', abort, { once: true });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }
  notify(method: string, params: any) {
    this.send({ jsonrpc: '2.0', method, params });
  }
  close() {
    this.socket.destroy();
  }
}
