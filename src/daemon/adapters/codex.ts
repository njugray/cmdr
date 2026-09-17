import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Standby, WakeRequest } from '../../shared/protocol.js';
import { wakePrompt } from '../../shared/wake.js';
import { CodexQueueAdapter } from './codex-queue.js';

export interface HostAdapter {
  readonly transport?: 'proxy' | 'queue';
  state(native: string): Promise<'idle' | 'busy' | 'unknown'>;
  lookup(native: string, request: WakeRequest): Promise<{ found: boolean; submission?: string }>;
  enqueue(native: string, request: WakeRequest): Promise<string | undefined>;
  start(native: string, submission?: string): Promise<void>;
  close(): void;
}

// Attach only to an existing host. Never launch a competing app-server.
export class CodexProxyAdapter implements HostAdapter {
  readonly transport = 'proxy' as const;
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private next = 1;
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  constructor(private options: Pick<Standby, 'executable' | 'socket'>) {}
  private connect() {
    if (this.ready) return this.ready;
    const child = spawn(
      this.options.executable || 'codex',
      ['app-server', 'proxy', ...(this.options.socket ? ['--sock', this.options.socket] : [])],
      { stdio: 'pipe' },
    );
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-1000);
    });
    const failed = (error?: Error) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.ready = undefined;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(
          new Error(
            stderr.trim() ||
              error?.message ||
              'Codex proxy disconnected; wake outcome may be uncertain',
          ),
        );
      }
      this.pending.clear();
      lines.close();
      child.kill();
    };
    child.on('error', failed);
    child.on('exit', () => failed());
    child.stdin.on('error', failed);
    lines.on('line', (line) => {
      if (Buffer.byteLength(line) > 4 * 1024 * 1024) {
        this.close();
        return;
      }
      try {
        const m = JSON.parse(line),
          p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.error)
          p.reject(new Error(`Codex ${m.error.code}: ${String(m.error.message).slice(0, 300)}`));
        else p.resolve(m.result);
      } catch {
        this.close();
      }
    });
    this.ready = this.request('initialize', {
      clientInfo: { name: 'cmdr', version: '1' },
      capabilities: { experimentalApi: true },
    })
      .then(() => {
        child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
      })
      .catch((error) => {
        this.close();
        throw error;
      });
    return this.ready;
  }
  private request(method: string, params: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.next++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out; reconcile before retrying`));
        this.close();
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  private async call(method: string, params: unknown) {
    await this.connect();
    return this.request(method, params);
  }
  async state(native: string) {
    let result = await this.call('thread/read', { threadId: native, includeTurns: false });
    if (result.thread?.status?.type === 'notLoaded') {
      result = await this.call('thread/resume', { threadId: native, excludeTurns: true });
    }
    await this.call('thread/queue/list', { threadId: native, limit: 1 });
    const type = result.thread?.status?.type;
    return type === 'idle'
      ? ('idle' as const)
      : type === 'active'
        ? ('busy' as const)
        : ('unknown' as const);
  }
  async lookup(native: string, request: WakeRequest) {
    let cursor: string | null = null;
    do {
      const page = await this.call('thread/queue/list', { threadId: native, cursor, limit: 100 });
      const match = page.data?.find((q: any) => q.clientUserMessageId === request.id);
      if (match) return { found: true, submission: String(match.id) };
      cursor = page.nextCursor;
    } while (cursor);
    do {
      const page = await this.call('thread/turns/list', {
        threadId: native,
        cursor,
        limit: 50,
        itemsView: 'full',
      });
      if (
        page.data?.some((t: any) =>
          t.items?.some((i: any) => i.type === 'userMessage' && i.clientId === request.id),
        )
      )
        return { found: true };
      const oldest = page.data?.at(-1)?.startedAt;
      if (oldest && oldest * 1000 < request.created_at - 60000) break;
      cursor = page.nextCursor;
    } while (cursor);
    return { found: false };
  }
  async enqueue(native: string, request: WakeRequest) {
    const text = wakePrompt(request.id);
    const result = await this.call('thread/queue/add', {
      threadId: native,
      clientUserMessageId: request.id,
      input: [{ type: 'text', text, text_elements: [] }],
    });
    if (!result.queuedSubmission?.id)
      throw new Error('Codex queue response did not confirm acceptance');
    return String(result.queuedSubmission.id);
  }
  async start(native: string, submission?: string) {
    if (!submission) throw new Error('Missing Codex proxy submission ID');
    if ((await this.state(native)) !== 'idle') return;
    // Starting one specific queued item lets the host arbitrate races with a user turn.
    await this.call('thread/queue/start', { threadId: native, queuedSubmissionId: submission });
  }
  close() {
    const child = this.child;
    this.child = undefined;
    this.ready = undefined;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('Codex adapter closed'));
    }
    this.pending.clear();
    child?.kill();
  }
}

// Select a fallback only before delivery. A persisted unresolved request pins its
// transport across daemon restarts, so a lost proxy response cannot be replayed via CLI.
export class CodexAdapter implements HostAdapter {
  private adapter?: HostAdapter;
  private closed = false;
  constructor(private options: Standby) {}
  get transport() {
    return this.adapter?.transport;
  }
  async state(native: string) {
    if (this.adapter) return this.adapter.state(native);
    const pinned =
      this.options.request && this.options.request.state !== 'observed'
        ? this.options.request.transport || 'proxy'
        : undefined;
    const selected = pinned || this.options.codex_transport || 'auto';
    let proxyError: unknown;
    if (selected !== 'queue') {
      this.adapter = new CodexProxyAdapter(this.options);
      try {
        return await this.adapter.state(native);
      } catch (e) {
        this.adapter.close();
        this.adapter = undefined;
        if (selected === 'proxy' || this.closed) throw e;
        proxyError = e;
      }
    }
    if (this.closed) throw new Error('Codex adapter closed');
    this.adapter = new CodexQueueAdapter(this.options);
    try {
      return await this.adapter.state(native);
    } catch (e) {
      this.adapter.close();
      this.adapter = undefined;
      throw new Error(
        `${proxyError ? `proxy unavailable: ${String(proxyError).slice(0, 200)}; ` : ''}queue unavailable: ${String(e).slice(0, 250)}`,
      );
    }
  }
  lookup(native: string, request: WakeRequest) {
    return this.adapter!.lookup(native, request);
  }
  enqueue(native: string, request: WakeRequest) {
    return this.adapter!.enqueue(native, request);
  }
  start(native: string, submission?: string) {
    return this.adapter!.start(native, submission);
  }
  close() {
    this.closed = true;
    this.adapter?.close();
  }
}
