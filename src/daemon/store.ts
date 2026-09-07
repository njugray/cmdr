import { DatabaseSync } from 'node:sqlite';
import type { Session, Squad, Message } from '../shared/protocol.js';

// All database access lives here. Payloads retain typed records; indexed columns
// enforce the invariants and keep queue scans bounded.
export class Store {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS sessions(sid TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS squads(id TEXT PRIMARY KEY, name_key TEXT, status TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS live_name ON squads(name_key) WHERE status IN ('active','orphaned') AND name_key IS NOT NULL;
      CREATE TABLE IF NOT EXISTS memberships(squad_id TEXT NOT NULL, sid TEXT NOT NULL, role TEXT NOT NULL, joined_at INTEGER NOT NULL, left_at INTEGER);
      CREATE UNIQUE INDEX IF NOT EXISTS live_membership ON memberships(sid) WHERE left_at IS NULL;
      CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, to_sid TEXT NOT NULL, status TEXT NOT NULL, priority INTEGER NOT NULL, reply_to TEXT, created_at INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS queue ON messages(to_sid,status,priority,seq);
      CREATE INDEX IF NOT EXISTS reply ON messages(reply_to);
      CREATE INDEX IF NOT EXISTS created ON messages(created_at);`);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private unpack<T>(rows: any[]): T[] {
    return rows.map((r) => JSON.parse(r.payload));
  }
  sessions(): Session[] {
    return this.unpack(this.db.prepare('SELECT payload FROM sessions').all());
  }
  session(sid: string): Session | undefined {
    const r = this.db.prepare('SELECT payload FROM sessions WHERE sid=?').get(sid);
    // Node 22.5 may return a row of nulls when no row matched.
    return typeof r?.payload === 'string' ? JSON.parse(r.payload) : undefined;
  }
  saveSession(s: Session) {
    this.db
      .prepare(
        'INSERT INTO sessions VALUES (?,?) ON CONFLICT(sid) DO UPDATE SET payload=excluded.payload',
      )
      .run(s.sid, JSON.stringify(s));
  }
  deleteSession(sid: string) {
    this.db.prepare('DELETE FROM sessions WHERE sid=?').run(sid);
  }
  squads(): Squad[] {
    return this.unpack(this.db.prepare('SELECT payload FROM squads').all());
  }
  squad(id: string): Squad | undefined {
    const r = this.db.prepare('SELECT payload FROM squads WHERE id=?').get(id);
    // Node 22.5 may return a row of nulls when no row matched.
    return typeof r?.payload === 'string' ? JSON.parse(r.payload) : undefined;
  }
  saveSquad(s: Squad) {
    this.db
      .prepare(
        'INSERT INTO squads VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name_key=excluded.name_key,status=excluded.status,payload=excluded.payload',
      )
      .run(s.id, s.name_key, s.status, JSON.stringify(s));
  }
  deleteSquad(id: string) {
    this.db.prepare('DELETE FROM squads WHERE id=?').run(id);
    this.db.prepare('DELETE FROM memberships WHERE squad_id=?').run(id);
  }
  join(s: Session) {
    this.db
      .prepare('INSERT INTO memberships VALUES (?,?,?,?,NULL)')
      .run(s.squad_id!, s.sid, s.role, Date.now());
  }
  leave(sid: string) {
    this.db
      .prepare('UPDATE memberships SET left_at=? WHERE sid=? AND left_at IS NULL')
      .run(Date.now(), sid);
  }
  migrateMembership(old: string, sid: string) {
    this.db.prepare('UPDATE memberships SET sid=? WHERE sid=?').run(sid, old);
  }
  deleteMemberships(sid: string) {
    this.db.prepare('DELETE FROM memberships WHERE sid=?').run(sid);
  }
  insert(m: Message) {
    const r = this.db
      .prepare(
        'INSERT INTO messages(id,to_sid,status,priority,reply_to,created_at,payload) VALUES (?,?,?,?,?,?,?)',
      )
      .run(m.id, m.to_sid, m.status, m.priority, m.reply_to, m.created_at, JSON.stringify(m));
    m.seq = Number(r.lastInsertRowid);
    this.saveMessage(m);
    return m;
  }
  saveMessage(m: Message) {
    this.db
      .prepare('UPDATE messages SET to_sid=?,status=?,payload=? WHERE id=?')
      .run(m.to_sid, m.status, JSON.stringify(m), m.id);
  }
  message(id: string): Message | undefined {
    const r = this.db.prepare('SELECT payload FROM messages WHERE id=?').get(id);
    // Node 22.5 may return a row of nulls when no row matched.
    return typeof r?.payload === 'string' ? JSON.parse(r.payload) : undefined;
  }
  messages(): Message[] {
    return this.unpack(this.db.prepare('SELECT payload FROM messages ORDER BY seq').all());
  }
  queue(sid: string, history = false): Message[] {
    return this.unpack(
      this.db
        .prepare('SELECT payload FROM messages WHERE to_sid=? AND status=? ORDER BY priority,seq')
        .all(sid, history ? 'delivered' : 'queued'),
    );
  }
  deleteMessage(id: string) {
    this.db.prepare('DELETE FROM messages WHERE id=?').run(id);
  }
  expireMessages(before: number) {
    this.db.prepare('DELETE FROM messages WHERE created_at<?').run(before);
  }
  close() {
    this.db.close();
  }
}
