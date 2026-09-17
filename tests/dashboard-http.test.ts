import { afterEach, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fixture } from './helpers.js';
import { DashboardServer } from '../src/daemon/dashboard-http.js';
import { randomUUID } from 'node:crypto';
import { get as httpGet } from 'node:http';

const assets = {
  'index.html': '<!doctype html><html><body>Dashboard HTTP fixture</body></html>',
  'app.js': 'globalThis.dashboardFixture = true;',
  'app.css': 'body { color: black; }',
};
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function setup() {
  const f = fixture();
  // HTTP behavior uses disposable assets; production bundles are checked by verify:package.
  const assetRoot = join(f.home, 'dashboard');
  mkdirSync(assetRoot);
  for (const [name, body] of Object.entries(assets)) {
    writeFileSync(join(assetRoot, name), body);
  }
  const { c, id } = await f.squad();
  const server = new DashboardServer(f.core, () => {}, pathToFileURL(assetRoot + '/'));
  cleanup.push(async () => {
    await server.close();
    f.close();
  });
  const opened = await server.open();
  const url = new URL(opened.url),
    origin = url.origin;
  const login = await fetch(`${origin}/api/session`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: url.hash.slice(1) }),
  });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  expect(login.status).toBe(200);
  const get = (path: string) => fetch(origin + path, { headers: { Cookie: cookie } });
  const post = (path: string, body: unknown, from = origin) =>
    fetch(origin + path, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: from, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { f, c, id, server, origin, cookie, get, post, key: url.hash.slice(1) };
}

it('requires a one-use bootstrap and same-origin authenticated requests, without exposing arbitrary RPC', async () => {
  const x = await setup();
  expect((await fetch(`${x.origin}/api/state`)).status).toBe(401);
  expect((await x.post('/api/session', { token: x.key })).status).toBe(401);
  expect((await x.post('/api/answers', {}, 'https://elsewhere.invalid')).status).toBe(403);
  expect((await x.post('/api/answers', {}, 'null')).status).toBe(403);
  const reboundHost = await new Promise<number | undefined>((resolve, reject) => {
    httpGet(
      `${x.origin}/api/state`,
      { headers: { Cookie: x.cookie, Host: 'rebind.example' } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    ).on('error', reject);
  });
  expect(reboundHost).toBe(403);
  expect((await x.post('/api/rpc', { method: 'admin.purge', params: { all: true } })).status).toBe(
    404,
  );
  const state = await (await x.get('/api/state')).json();
  expect(state.home).toBe(x.f.home);
  expect(state.squads[0].id).toBe(x.id);
  for (const [name, type] of [
    ['index.html', 'text/html'],
    ['app.js', 'text/javascript'],
    ['app.css', 'text/css'],
  ] as const) {
    const response = await x.get(name === 'index.html' ? '/' : `/${name}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain(type);
    expect(await response.text()).toBe(assets[name]);
  }
  expect((await x.server.open()).url.startsWith(x.origin)).toBe(true);
});

it('streams committed invalidations without consuming messages and releases activity on close', async () => {
  const x = await setup();
  const abort = new AbortController();
  const stream = await fetch(`${x.origin}/api/events`, {
    headers: { Cookie: x.cookie },
    signal: abort.signal,
  });
  expect(stream.headers.get('content-type')).toBe('text/event-stream');
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  expect(decoder.decode((await reader.read()).value)).toContain('connected');
  expect(x.server.active).toBe(true);
  const { question } = await x.f.core.handle(x.c, 'msg.ask', {
    target: 'user',
    question: 'SSE answer',
  });
  expect(decoder.decode((await reader.read()).value)).toContain(x.id);
  const input = {
    question_id: question.id,
    version: question.version,
    submission_id: randomUUID(),
    text: 'Accepted',
  };
  const receipt = await (await x.post('/api/answers', input)).json();
  expect(decoder.decode((await reader.read()).value)).toContain(x.id);
  expect(x.f.store.message(receipt.message_id)?.status).toBe('queued');
  expect(await (await x.post('/api/answers', input)).json()).toEqual(receipt);
  const snapshot = await (await x.get(`/api/squads/${x.id}`)).json();
  expect(snapshot.questions[0].status).toBe('answered');
  abort.abort();
  await expect.poll(() => x.server.active).toBe(false);
});

it('serves HTML with an opaque sandbox and no network/form access, including immutable submission evidence', async () => {
  const x = await setup();
  const { artifact } = await x.f.core.handle(x.c, 'dashboard.artifact', {
    title: 'Explanation',
    html: '<h1>Original</h1><script>document.body.dataset.ran="yes"</script>',
  });
  const path = `/artifacts/${encodeURIComponent(artifact.id)}/1`;
  const html = await x.get(path);
  const policy = html.headers.get('content-security-policy')!;
  expect(policy).toContain('sandbox allow-scripts');
  expect(policy).not.toContain('allow-same-origin');
  expect(policy).toContain("connect-src 'none'");
  expect(policy).toContain("form-action 'none'");
  expect(html.headers.get('referrer-policy')).toBe('no-referrer');
  const { question } = await x.f.core.handle(x.c, 'msg.ask', {
    target: 'user',
    question: 'Review',
    artifact_ids: [artifact.id],
  });
  const input = { question_id: question.id, version: 1, submission_id: randomUUID(), text: 'Yes' };
  await x.post('/api/answers', input);
  await x.f.core.handle(x.c, 'dashboard.artifact', {
    id: artifact.id,
    version: 1,
    title: 'Explanation',
    html: '<h1>Updated</h1>',
  });
  expect((await x.get(path)).status).toBe(409);
  expect(await (await x.get(`${path}?submission=${input.submission_id}`)).text()).toContain(
    'Original',
  );
  const evidence = await (await x.get(`/api/submissions/${input.submission_id}`)).json();
  expect(evidence.snapshot.artifacts[0]).not.toHaveProperty('html');
  expect(evidence.snapshot.question.question).toBe('Review');
});

it('returns question version conflicts without accepting an old answer', async () => {
  const x = await setup();
  const { question } = await x.f.core.handle(x.c, 'msg.ask', {
    target: 'user',
    question: 'Before',
  });
  await x.f.core.handle(x.c, 'msg.ask', {
    target: 'user',
    action: 'update',
    id: question.id,
    version: 1,
    question: 'After',
  });
  expect(
    (
      await x.post('/api/answers', {
        question_id: question.id,
        version: 1,
        submission_id: randomUUID(),
        text: 'Stale',
      })
    ).status,
  ).toBe(409);
  expect(x.f.store.dashboardRecord('question', question.id)?.status).toBe('pending');
});

it('routes authenticated user notes to the commander inbox without allowing agent impersonation', async () => {
  const x = await setup();
  const input = { squad_id: x.id, submission_id: randomUUID(), text: '  Prioritize regression  ' };
  expect(
    (
      await fetch(`${x.origin}/api/messages`, {
        method: 'POST',
        headers: { Origin: x.origin, 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })
    ).status,
  ).toBe(401);
  expect((await x.post('/api/messages', input, 'https://elsewhere.invalid')).status).toBe(403);
  for (const extra of [
    { from_role: 'commander' },
    { to: 'executor' },
    { type: 'command' },
    { text: '  ' },
    { text: 'x'.repeat(8001) },
  ]) {
    expect((await x.post('/api/messages', { ...input, ...extra })).status).toBe(400);
  }
  const response = await x.post('/api/messages', input);
  expect(response.status).toBe(200);
  const receipt = await response.json();
  expect(x.f.store.message(receipt.message_id)).toMatchObject({
    from_sid: 'user',
    from_role: 'user',
    to_sid: `squad:${x.id}`,
    type: 'info',
    body: 'Prioritize regression',
    attn: true,
    status: 'queued',
  });
  expect(x.f.core.actionable(x.c.sid!).some((m) => m.id === receipt.message_id)).toBe(true);
  expect(await (await x.post('/api/messages', input)).json()).toEqual(receipt);
  expect((await x.post('/api/messages', { ...input, text: 'Changed' })).status).toBe(409);
  expect(x.f.core.dashboardSnapshot(x.id).tasks).toEqual([]);
  expect(
    (await x.f.core.handle(x.c, 'msg.read')).messages.some((m: any) => m.id === receipt.message_id),
  ).toBe(true);
  expect(await (await x.post('/api/messages', input)).json()).toEqual(receipt);
  await x.f.core.handle(x.c, 'session.leave', { dissolve: true });
  expect((await x.post('/api/messages', { ...input, submission_id: randomUUID() })).status).toBe(
    400,
  );
});
