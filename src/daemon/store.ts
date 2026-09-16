import { DatabaseSync } from 'node:sqlite';
import {
  terminalWork,
  type LifecycleEvent,
  type Standby,
  type Session,
  type Squad,
  type Message,
} from '../shared/protocol.js';

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
      CREATE INDEX IF NOT EXISTS created ON messages(created_at);
      CREATE TABLE IF NOT EXISTS events(event_seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS standby(sid TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revoked(sid TEXT PRIMARY KEY, replacement TEXT NOT NULL);`);
    this.migrateWork();
  }
  private migrateWork() {
    const legacy = this.unpack<Message>(
      this.db
        .prepare(
          "SELECT payload FROM messages WHERE json_extract(payload,'$.type')='command' AND json_extract(payload,'$.work') IS NULL",
        )
        .all(),
    );
    if (!legacy.length) return;
    this.transaction(() => {
      for (const m of legacy) {
        m.work = {
          state: m.status === 'queued' ? 'queued' : 'read',
          updated_at: m.delivered_at || m.created_at,
        };
        const reports = this.unpack<Message>(
          this.db.prepare('SELECT payload FROM messages WHERE reply_to=? ORDER BY seq').all(m.id),
        );
        for (const report of reports) {
          if (
            report.type !== 'report' ||
            report.from_sid !== m.to_sid ||
            report.squad_id !== m.squad_id ||
            terminalWork(m)
          )
            continue;
          const state = (
            {
              working: 'accepted',
              blocked: 'accepted',
              done: 'completed',
              failed: 'failed',
              cancelled: 'cancelled',
            } as const
          )[String(report.data?.status) as 'working'];
          if (!state) continue;
          m.work.state = state;
          m.work.updated_at = report.created_at;
          if (state === 'accepted') m.work.accepted_at ||= report.created_at;
          m.status = 'delivered';
          m.delivered_at ||= report.created_at;
        }
        this.saveMessage(m);
        this.appendEvent({
          at: Date.now(),
          kind: 'work.migrated',
          channel: m.squad_id,
          message_id: m.id,
          to_sid: m.to_sid,
          from_sid: m.from_sid,
          message: m,
        });
      }
    });
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
    // Unfinished commands survive retention: expiry must never release task ownership.
    const active = this.commands();
    const unfinished = new Set(active.map((m) => m.id));
    const dependencies = new Set(active.map((m) => m.blocked_by));
    for (const m of this.messages())
      if (
        m.created_at < before &&
        !dependencies.has(m.id) &&
        !(m.type === 'cancel' && m.reply_to && unfinished.has(m.reply_to)) &&
        (m.type !== 'command' || terminalWork(m))
      )
        this.deleteMessage(m.id);
  }
  commands(sid?: string): Message[] {
    return this.messages().filter(
      (m) => m.type === 'command' && (!sid || m.to_sid === sid) && !terminalWork(m),
    );
  }
  appendEvent(event: Omit<LifecycleEvent, 'event_seq'>): LifecycleEvent {
    const r = this.db
      .prepare('INSERT INTO events(at,payload) VALUES (?,?)')
      .run(event.at, JSON.stringify(event));
    const value = { ...event, event_seq: Number(r.lastInsertRowid) };
    this.db
      .prepare('UPDATE events SET payload=? WHERE event_seq=?')
      .run(JSON.stringify(value), value.event_seq);
    return value;
  }
  eventCursor(): number {
    return Number(
      this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='events'").get()?.seq || 0,
    );
  }
  events(after = 0): LifecycleEvent[] {
    return this.unpack(
      this.db.prepare('SELECT payload FROM events WHERE event_seq>? ORDER BY event_seq').all(after),
    );
  }
  eventPage(
    after: number,
    filter: { squad?: string; to?: string; roleInbox?: string },
  ): LifecycleEvent[] {
    return this.unpack(
      this.db
        .prepare(
          `SELECT payload FROM events WHERE event_seq>?
      AND (? IS NULL OR json_extract(payload,'$.channel')=?)
      AND (? IS NULL OR json_extract(payload,'$.to_sid')=? OR json_extract(payload,'$.to_sid')=?)
      ORDER BY event_seq LIMIT 101`,
        )
        .all(
          after,
          filter.squad || null,
          filter.squad || null,
          filter.to || null,
          filter.to || null,
          filter.roleInbox || null,
        ),
    );
  }
  eventFloor(): number {
    return Number(
      this.db.prepare("SELECT value FROM metadata WHERE key='event_floor'").get()?.value || 0,
    );
  }
  expireEvents(before: number) {
    const last = Number(
      this.db.prepare('SELECT MAX(event_seq) AS seq FROM events WHERE at<?').get(before)?.seq || 0,
    );
    if (last) {
      this.db
        .prepare(
          "INSERT INTO metadata VALUES ('event_floor',?) ON CONFLICT(key) DO UPDATE SET value=MAX(value,excluded.value)",
        )
        .run(last);
      this.db.prepare('DELETE FROM events WHERE event_seq<=?').run(last);
    }
  }
  standbys(): Standby[] {
    return this.unpack(this.db.prepare('SELECT payload FROM standby').all());
  }
  standby(sid: string): Standby | undefined {
    return this.standbys().find((s) => s.sid === sid);
  }
  saveStandby(s: Standby) {
    this.db
      .prepare(
        'INSERT INTO standby VALUES (?,?) ON CONFLICT(sid) DO UPDATE SET payload=excluded.payload',
      )
      .run(s.sid, JSON.stringify(s));
  }
  deleteStandby(sid: string) {
    this.db.prepare('DELETE FROM standby WHERE sid=?').run(sid);
  }
  revoke(sid: string, replacement: string) {
    this.db.prepare('INSERT OR REPLACE INTO revoked VALUES (?,?)').run(sid, replacement);
  }
  revoked(sid: string): boolean {
    return !!this.db.prepare('SELECT sid FROM revoked WHERE sid=?').get(sid)?.sid;
  }
  purge() {
    this.db.exec('DELETE FROM messages; DELETE FROM standby; DELETE FROM revoked;');
  }
  close() {
    this.db.close();
  }
}
