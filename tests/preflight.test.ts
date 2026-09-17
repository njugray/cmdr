import { afterEach, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './helpers.js';
import { preflight } from '../src/daemon/preflight.js';
let f: ReturnType<typeof fixture>;
afterEach(() => f?.close());
it('validates a WAL snapshot without consuming or changing the source database', async () => {
  f = fixture();
  const { c, e } = await f.squad();
  const id = (await f.core.handle(c, 'msg.send', { to: e.sid, message: 'WAL retained' })).ids[0];
  const before = f.store.eventCursor();
  await preflight(f.home);
  expect(f.store.message(id)?.status).toBe('queued');
  expect(f.store.eventCursor()).toBe(before);
});
it('rejects incompatible schema in the copy without altering source tables', async () => {
  f = fixture();
  const db = new DatabaseSync(f.p.db);
  try {
    db.exec('ALTER TABLE squads RENAME COLUMN payload TO legacy_payload');
    await expect(preflight(f.home)).rejects.toThrow();
    expect(
      db
        .prepare('PRAGMA table_info(squads)')
        .all()
        .map((r) => r.name),
    ).toContain('legacy_payload');
  } finally {
    db.close();
  }
});
