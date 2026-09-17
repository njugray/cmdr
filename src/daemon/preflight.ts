import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { paths } from '../shared/paths.js';

// Validate this bundle's migrations against a consistent copy, before stopping a
// live daemon. Never copy the main SQLite file without its WAL or mutate live data.
export async function preflight(home?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'cmdr-preflight-'));
  try {
    const source = paths(home).db,
      target = join(dir, 'state.db');
    if (existsSync(source)) {
      const db = new DatabaseSync(source, { readOnly: true });
      try {
        db.prepare('VACUUM INTO ?').run(target);
      } finally {
        db.close();
      }
    }
    const store = new Store(target);
    try {
      store.sessions();
      store.squads();
      store.messages();
      store.standbys();
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
