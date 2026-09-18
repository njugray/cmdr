import type { Server } from 'node:http';
import { createAdaptorServer, type HttpBindings } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
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
  private app = new Hono<{ Bindings: HttpBindings }>();
  private server: Server;
  private streams = new Set<{ send: (data: string) => void; close: () => void }>();
  private openings = new Map<string, number>();
  private session = token();
  private cookie = '';
  private origin = '';
  private heartbeat?: NodeJS.Timeout;
  private starting?: Promise<void>;
  private assets = new Map<string, { body: Buffer; type: string }>();
  private notify = (squads: (string | null)[]) => {
    const data = `data: ${JSON.stringify({ squads })}\n\n`;
    for (const stream of this.streams) stream.send(data);
  };
  constructor(
    private core: Core,
    private touch: () => void,
    private assetRoot = new URL('./dashboard/', import.meta.url),
  ) {
    this.routes();
    this.server = createAdaptorServer({
      fetch: this.app.fetch,
      overrideGlobalObjects: false,
    }) as Server;
  }
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
      for (const stream of this.streams) stream.send(': heartbeat\n\n');
    }, 20_000);
    this.heartbeat.unref();
  }
  async close() {
    if (this.starting) await this.starting.catch(() => {});
    clearInterval(this.heartbeat);
    this.core.dashboardObservers.delete(this.notify);
    for (const stream of this.streams) stream.close();
    this.streams.clear();
    if (this.server.listening)
      await new Promise<void>((resolve) => {
        this.server.close(() => resolve());
        this.server.closeAllConnections();
      });
  }
  private async body(c: Context) {
    try {
      return await c.req.json();
    } catch {
      fail('INVALID_ARGUMENT', 'Invalid JSON');
    }
  }
  private events(c: Context<{ Bindings: HttpBindings }>) {
    const response = streamSSE(c, async (stream) => {
      let pendingBytes = 0;
      let closed = false;
      let finish!: () => void;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const client = {
        send: (data: string) => {
          if (closed) return;
          const bytes = Buffer.byteLength(data);
          // Bound queued writes as well as the Node socket buffer for slow readers.
          if (pendingBytes + bytes + c.env.outgoing.writableLength > 1024 * 1024) {
            client.close();
            return;
          }
          pendingBytes += bytes;
          void stream.write(data).finally(() => {
            pendingBytes -= bytes;
          });
        },
        close: () => {
          if (closed) return;
          closed = true;
          this.streams.delete(client);
          this.touch();
          stream.abort();
          finish();
        },
      };
      stream.onAbort(client.close);
      // Subscribe before confirming connection; onopen reads the snapshot.
      this.streams.add(client);
      client.send(': connected\n\n');
      await done;
    });
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('X-Accel-Buffering', 'no');
    return response;
  }
  private routes() {
    const app = this.app;
    app.use('*', async (c, next) => {
      c.header('Cache-Control', 'no-store');
      c.header('X-Content-Type-Options', 'nosniff');
      c.header('Referrer-Policy', 'no-referrer');
      c.header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      );
      if (c.req.header('host') !== this.origin.slice('http://'.length)) fail('FORBIDDEN');
      const origin = c.req.header('origin');
      if ((origin && origin !== this.origin) || c.req.header('sec-fetch-site') === 'cross-site')
        fail('FORBIDDEN');
      if (c.req.method === 'POST' && origin !== this.origin) fail('FORBIDDEN');
      // Hono implicitly maps HEAD to GET; never create an SSE subscription for HEAD.
      if (!['GET', 'POST'].includes(c.req.method)) fail('NOT_FOUND');
      await next();
    });
    for (const [path, name] of [
      ['/', 'index.html'],
      ['/app.js', 'app.js'],
      ['/app.css', 'app.css'],
    ]) {
      app.get(path, (c) => {
        const asset = this.assets.get(name)!;
        return c.body(new Uint8Array(asset.body), 200, { 'Content-Type': asset.type });
      });
    }
    const jsonBody = [
      async (c: Context, next: () => Promise<void>) => {
        if (c.req.header('content-type')?.split(';')[0] !== 'application/json')
          fail('INVALID_ARGUMENT', 'Expected application/json');
        await next();
      },
      bodyLimit({ maxSize: 64 * 1024, onError: () => fail('MESSAGE_TOO_LARGE') }),
    ] as const;
    app.post('/api/session', ...jsonBody, async (c) => {
      const body = await this.body(c);
      const expires = typeof body?.token === 'string' ? this.openings.get(body.token) : undefined;
      if (!expires || expires < Date.now())
        fail('UNAUTHORIZED', 'Open the dashboard again with cmdr dashboard');
      this.openings.delete(body.token);
      setCookie(c, this.cookie, this.session, { httpOnly: true, sameSite: 'Strict', path: '/' });
      return c.json({ ok: true });
    });
    app.use('*', async (c, next) => {
      if (!same(getCookie(c, this.cookie) || '', this.session))
        fail('UNAUTHORIZED', 'Open the dashboard with cmdr dashboard');
      this.touch();
      await next();
    });
    app.get('/api/events', (c) => this.events(c));
    app.get('/api/state', (c) =>
      c.json({
        home: this.core.paths.home,
        version: VERSION,
        squads: this.core.dashboard.summaries(),
      }),
    );
    app.get('/api/tasks/:id', (c) => {
      const task = this.core.store.dashboardRecord('task', c.req.param('id')) || fail('NOT_FOUND');
      const offset = Number(c.req.query('offset') || 0);
      if (!Number.isSafeInteger(offset) || offset < 0) fail('INVALID_ARGUMENT');
      return c.json(this.core.dashboard.taskDetail(task.id, task.squad_id, offset));
    });
    app.get('/api/squads/:id', (c) => c.json(this.core.dashboardSnapshot(c.req.param('id'))));
    app.get('/api/submissions/:id', (c) => {
      const submission = this.core.store.submission(c.req.param('id')) || fail('NOT_FOUND');
      return c.json({
        ...submission,
        snapshot: {
          ...submission.snapshot,
          artifacts: submission.snapshot.artifacts.map(({ html: _html, ...a }) => a),
        },
      });
    });
    app.get('/artifacts/:id/:version', (c) => {
      const submission = c.req.query('submission');
      const id = c.req.param('id');
      const artifact = submission
        ? this.core.store.submission(submission)?.snapshot.artifacts.find((a) => a.id === id)
        : this.core.store.dashboardRecord('artifact', id);
      if (!artifact) fail('NOT_FOUND');
      if (artifact.version !== Number(c.req.param('version'))) fail('VERSION_CONFLICT');
      c.header('Content-Security-Policy', artifactPolicy);
      return c.html(artifact.html);
    });
    app.post('/api/answers', ...jsonBody, async (c) =>
      c.json(this.core.submitUserAnswer(await this.body(c))),
    );
    app.post('/api/messages', ...jsonBody, async (c) =>
      c.json(this.core.submitUserMessage(await this.body(c))),
    );
    app.notFound(() => fail('NOT_FOUND'));
    app.onError((error, c) => {
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
      return c.json({ code: e.code, message: e.message }, status);
    });
  }
}
