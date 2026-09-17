import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Core } from './core.js';
import { CmdrError, fail } from '../shared/protocol.js';
import { VERSION } from '../shared/version.js';

const token = () => randomBytes(32).toString('base64url');
const same = (a: string, b: string) =>
  Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const artifactPolicy =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

export class DashboardServer {
  private server = createServer((req, res) => {
    void this.handle(req, res);
  });
  private streams = new Set<ServerResponse>();
  private openings = new Map<string, number>();
  private session = token();
  private cookie = '';
  private origin = '';
  private heartbeat?: NodeJS.Timeout;
  private starting?: Promise<void>;
  private assets = new Map<string, { body: Buffer; type: string }>();
  private notify = (squads: (string | null)[]) => {
    for (const stream of this.streams) {
      if (stream.writableLength > 1024 * 1024) stream.end();
      else stream.write(`data: ${JSON.stringify({ squads })}\n\n`);
    }
  };
  constructor(
    private core: Core,
    private touch: () => void,
    private assetRoot = new URL('./dashboard/', import.meta.url),
  ) {}
  get active() {
    return this.streams.size > 0;
  }
  async open() {
    if (!this.starting)
      this.starting = this.start().catch((e) => {
        this.starting = undefined;
        throw e;
      });
    await this.starting;
    const now = Date.now();
    for (const [key, expires] of this.openings) if (expires < now) this.openings.delete(key);
    if (this.openings.size >= 50) this.openings.delete(this.openings.keys().next().value!);
    const key = token();
    this.openings.set(key, now + 60_000);
    this.touch();
    return { url: `${this.origin}/#${key}`, home: this.core.paths.home, version: VERSION };
  }
  private async start() {
    for (const [name, type] of [
      ['index.html', 'text/html; charset=utf-8'],
      ['app.js', 'text/javascript; charset=utf-8'],
      ['app.css', 'text/css; charset=utf-8'],
    ])
      this.assets.set(name, { body: readFileSync(new URL(name, this.assetRoot)), type });
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Dashboard failed to bind');
    this.origin = `http://127.0.0.1:${address.port}`;
    this.cookie = `cmdr_dashboard_${address.port}`;
    this.core.dashboardObservers.add(this.notify);
    this.heartbeat = setInterval(() => {
      for (const stream of this.streams) stream.write(': heartbeat\n\n');
    }, 20_000);
    this.heartbeat.unref();
  }
  async close() {
    if (this.starting) await this.starting.catch(() => {});
    clearInterval(this.heartbeat);
    this.core.dashboardObservers.delete(this.notify);
    for (const stream of this.streams) stream.end();
    this.streams.clear();
    if (this.server.listening)
      await new Promise<void>((resolve) => {
        this.server.close(() => resolve());
        this.server.closeAllConnections();
      });
  }
  private async body(req: IncomingMessage) {
    if (req.headers['content-type']?.split(';')[0] !== 'application/json')
      fail('INVALID_ARGUMENT', 'Expected application/json');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 64 * 1024) fail('MESSAGE_TOO_LARGE');
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      fail('INVALID_ARGUMENT', 'Invalid JSON');
    }
  }
  private json(res: ServerResponse, data: unknown, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  }
  private async handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    try {
      if (req.headers.host !== this.origin.slice('http://'.length)) fail('FORBIDDEN');
      if (
        (req.headers.origin && req.headers.origin !== this.origin) ||
        req.headers['sec-fetch-site'] === 'cross-site'
      )
        fail('FORBIDDEN');
      const url = new URL(req.url || '/', this.origin);
      if (req.method === 'GET' && ['/', '/app.js', '/app.css'].includes(url.pathname)) {
        const asset = this.assets.get(url.pathname === '/' ? 'index.html' : url.pathname.slice(1))!;
        res.writeHead(200, { 'Content-Type': asset.type });
        res.end(asset.body);
        return;
      }
      if (req.method === 'POST' && req.headers.origin !== this.origin) fail('FORBIDDEN');
      if (req.method === 'POST' && url.pathname === '/api/session') {
        const body = await this.body(req);
        const expires = typeof body?.token === 'string' ? this.openings.get(body.token) : undefined;
        if (!expires || expires < Date.now())
          fail('UNAUTHORIZED', 'Open the dashboard again with cmdr dashboard');
        this.openings.delete(body.token);
        res.setHeader(
          'Set-Cookie',
          `${this.cookie}=${this.session}; HttpOnly; SameSite=Strict; Path=/`,
        );
        this.json(res, { ok: true });
        return;
      }
      const credential =
        (req.headers.cookie || '')
          .split(';')
          .map((s) => s.trim())
          .find((s) => s.startsWith(`${this.cookie}=`))
          ?.slice(this.cookie.length + 1) || '';
      if (!same(credential, this.session))
        fail('UNAUTHORIZED', 'Open the dashboard with cmdr dashboard');
      this.touch();
      if (req.method === 'GET' && url.pathname === '/api/events') {
        this.streams.add(res); // Subscribe before confirming connection; onopen reads the snapshot.
        res.on('close', () => {
          this.streams.delete(res);
          this.touch();
        });
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.flushHeaders();
        res.write(': connected\n\n');
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        this.json(res, {
          home: this.core.paths.home,
          version: VERSION,
          squads: this.core.dashboard.summaries(),
        });
        return;
      }
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (
        req.method === 'GET' &&
        parts[0] === 'api' &&
        parts[1] === 'tasks' &&
        parts.length === 3
      ) {
        const task = this.core.store.dashboardRecord('task', parts[2]) || fail('NOT_FOUND');
        const offset = Number(url.searchParams.get('offset') || 0);
        if (!Number.isSafeInteger(offset) || offset < 0) fail('INVALID_ARGUMENT');
        this.json(res, this.core.dashboard.taskDetail(task.id, task.squad_id, offset));
        return;
      }
      if (
        req.method === 'GET' &&
        parts[0] === 'api' &&
        parts[1] === 'squads' &&
        parts.length === 3
      ) {
        this.json(res, this.core.dashboardSnapshot(parts[2]));
        return;
      }
      if (
        req.method === 'GET' &&
        parts[0] === 'api' &&
        parts[1] === 'submissions' &&
        parts.length === 3
      ) {
        const submission = this.core.store.submission(parts[2]) || fail('NOT_FOUND');
        this.json(res, {
          ...submission,
          snapshot: {
            ...submission.snapshot,
            artifacts: submission.snapshot.artifacts.map(({ html: _html, ...a }) => a),
          },
        });
        return;
      }
      if (req.method === 'GET' && parts[0] === 'artifacts' && parts.length === 3) {
        const submission = url.searchParams.get('submission');
        const artifact = submission
          ? this.core.store
              .submission(submission)
              ?.snapshot.artifacts.find((a) => a.id === parts[1])
          : this.core.store.dashboardRecord('artifact', parts[1]);
        if (!artifact) fail('NOT_FOUND');
        if (artifact.version !== Number(parts[2])) fail('VERSION_CONFLICT');
        res.setHeader('Content-Security-Policy', artifactPolicy);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(artifact.html);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/answers') {
        this.json(res, this.core.submitUserAnswer(await this.body(req)));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/messages') {
        this.json(res, this.core.submitUserMessage(await this.body(req)));
        return;
      }
      fail('NOT_FOUND');
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const e =
        error instanceof CmdrError
          ? error
          : new CmdrError('INTERNAL_ERROR', 'Dashboard request failed');
      const status =
        e.code === 'UNAUTHORIZED'
          ? 401
          : e.code === 'FORBIDDEN'
            ? 403
            : ['NOT_FOUND', 'SQUAD_NOT_FOUND'].includes(e.code)
              ? 404
              : ['VERSION_CONFLICT', 'QUESTION_CLOSED', 'SUBMISSION_CONFLICT'].includes(e.code)
                ? 409
                : e.code === 'QUEUE_FULL'
                  ? 503
                  : e.code === 'MESSAGE_TOO_LARGE'
                    ? 413
                    : e.code === 'INTERNAL_ERROR'
                      ? 500
                      : 400;
      this.json(res, { code: e.code, message: e.message }, status);
    }
  }
}
