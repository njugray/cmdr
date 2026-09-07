import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Core, type Context } from '../src/daemon/core.js';
import { Store } from '../src/daemon/store.js';
import { paths, prepare } from '../src/shared/paths.js';
import { defaults } from '../src/shared/config.js';
export function fixture(overrides = {}) {
  const home = mkdtempSync(join(tmpdir(), 'cmdr-test-')),
    p = paths(home);
  prepare(p);
  const store = new Store(p.db),
    core = new Core(store, p, { ...defaults, ...overrides });
  async function session(agent = 'claude', native_id: string | null = 'commander', extra = {}) {
    const ctx: Context = { notify: () => {} };
    core.connect(ctx);
    await core.handle(ctx, 'session.register', {
      kind: 'mcp',
      agent,
      ...(native_id ? { native_id } : {}),
      ...extra,
    });
    return ctx;
  }
  async function squad() {
    const c = await session();
    const q = await core.handle(c, 'session.join', { squad_name: 'Alpha' });
    const e = await session('codex', 'executor');
    await core.handle(e, 'session.join', { role: 'executor', squad: q.squad.id, name: 'tests' });
    await core.handle(c, 'msg.read');
    return { c, e, id: q.squad.id };
  }
  const hook = (ctx: Context, event: string, extra = {}) =>
    core.handle({ notify: () => {} }, 'hook.event', {
      agent: ctx.agent,
      session_id: ctx.sid!.split(':').slice(1).join(':'),
      event,
      ...extra,
    });
  return {
    home,
    p,
    store,
    core,
    session,
    squad,
    hook,
    close: () => {
      core.close();
      store.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
