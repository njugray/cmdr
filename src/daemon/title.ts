import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { Session } from '../shared/protocol.js';
const cache = new Map<string, { at: number; title: string; key: string }>();
function firstText(value: any): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value))
    return value
      .filter((v) => v?.type === 'text')
      .map((v) => v.text)
      .join(' ');
  return '';
}
export function titleFor(s: Session): string {
  const key = `${s.cwd}:${s.transcript_path}:${s.title}`,
    found = cache.get(s.sid);
  if (found && found.key === key && Date.now() - found.at < 60_000) return found.title;
  let title = '';
  if (s.agent === 'codex' && s.native_id) {
    const home = process.env.CODEX_HOME || join(homedir(), '.codex');
    let row: any;
    for (const dir of [home, join(home, 'sqlite')]) {
      let files: string[] = [];
      try {
        files = readdirSync(dir)
          .filter((f) => /^state_\d+\.sqlite$/.test(f))
          .sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
      } catch {
        /* optional */
      }
      for (const f of files) {
        let db: DatabaseSync | undefined;
        try {
          db = new DatabaseSync(join(dir, f), { readOnly: true });
          row = db.prepare('SELECT * FROM threads WHERE id=?').get(s.native_id);
          if (!row?.id) row = undefined;
        } catch {
          /* host schema may change */
        } finally {
          db?.close();
        }
        if (row) break;
      }
      if (row) break;
    }
    let sidebar = '';
    try {
      for (const line of readFileSync(join(home, 'session_index.jsonl'), 'utf8').split('\n')) {
        try {
          const r = JSON.parse(line);
          if (r.id === s.native_id || r.thread_id === s.native_id)
            sidebar = r.thread_name || sidebar;
        } catch {
          /* partial last line */
        }
      }
    } catch {
      /* optional */
    }
    title = row?.name || sidebar || row?.title || row?.first_user_message || '';
  } else if (s.agent === 'claude' && s.transcript_path) {
    try {
      for (const line of readFileSync(s.transcript_path, 'utf8').split('\n')) {
        try {
          const r = JSON.parse(line);
          if (r.type === 'user') {
            title = firstText(r.message?.content || r.content);
            if (title) break;
          }
        } catch {
          /* partial line */
        }
      }
    } catch {
      /* optional */
    }
  }
  title = String(title || s.title || (s.cwd ? basename(s.cwd) : s.sid))
    .replace(/\s+/g, ' ')
    .slice(0, 60);
  if (cache.size > 2000) cache.clear();
  cache.set(s.sid, { at: Date.now(), title, key });
  return title;
}
