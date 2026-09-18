import { actionable, wakeEvent, hostStandby, armHint } from '../shared/wake.js';
import { randomUUID } from 'node:crypto';
import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from './store.js';
import { titleFor } from './title.js';
import { parse, type Tool } from '../shared/schemas.js';
import {
  fail,
  LIMITS,
  terminalWork,
  type LifecycleEvent,
  type Agent,
  type Message,
  type MessageType,
  type Session,
  type Squad,
} from '../shared/protocol.js';
import { messageId, provisionalId, squadId } from '../shared/ids.js';
import { recommendedWait } from '../shared/env.js';
import type { Config } from '../shared/config.js';
import type { Paths } from '../shared/paths.js';
import { Dashboard } from './dashboard.js';
import { answerSchema, userMessageSchema } from '../shared/dashboard-schemas.js';

// Leave room for envelope fields and UTF-8 escaping in a single RPC frame.
function bounded<T>(values: T[], limit: number): T[] {
  const result: T[] = [];
  let bytes = 0;
  for (const value of values) {
    const size = Buffer.byteLength(JSON.stringify(value));
    if (result.length >= limit || (result.length > 0 && bytes + size > LIMITS.maxFrame / 2)) break;
    result.push(value);
    bytes += size;
  }
  return result;
}
export interface Context {
  sid?: string;
  kind?: 'mcp' | 'hook' | 'cli';
  agent?: Agent;
  transport?: 'cli' | 'mcp';
  waitHint?: number;
  closed?: boolean;
  version?: string;
  client?: string;
  tail?: { squad?: string; for?: string; full?: boolean; actionable?: boolean; after: number };
  notify: (method: string, params: unknown) => void;
}
interface Waiter {
  ctx: Context;
  sid: string;
  answer?: string;
  finish: () => void;
  timer: NodeJS.Timeout;
}
export class Core {
  readonly dashboard: Dashboard;
  readonly dashboardObservers = new Set<(squads: (string | null)[]) => void>();
  configureStandby?: (sid: string, mode: string) => unknown;
  contexts = new Set<Context>();
  private waiters = new Set<Waiter>();
  private effects: Message[] = [];
  private rates = new Map<string, number[]>();
  constructor(
    public store: Store,
    public paths: Paths,
    public config: Config,
  ) {
    this.dashboard = new Dashboard(store, (kind, squad, id) =>
      this.record(kind, squad, { data: { id } }),
    );
    for (const s of store.sessions()) {
      s.presence = s.transport === 'cli' ? 'cli' : 'offline';
      store.saveSession(s);
    }
    this.refreshFlags();
  }
  connect(ctx: Context) {
    this.contexts.add(ctx);
  }
  disconnect(ctx: Context) {
    ctx.closed = true;
    this.contexts.delete(ctx);
    for (const w of this.waiters) if (w.ctx === ctx) w.finish();
    if (
      ctx.sid &&
      ![...this.contexts].some(
        (c) => c.kind === 'mcp' && c.transport !== 'cli' && c.sid === ctx.sid,
      )
    ) {
      const s = this.store.session(ctx.sid);
      if (s) {
        s.presence = s.transport === 'cli' ? 'cli' : 'offline';
        this.atomic(() => {
          this.store.saveSession(s);
          this.record('session.disconnected', s.squad_id, {
            to_sid: s.sid,
            data: { presence: s.presence },
          });
        });
      }
    }
  }
  close() {
    for (const ctx of this.contexts) ctx.closed = true;
    for (const w of this.waiters) w.finish();
  }
  private me(ctx: Context) {
    return ctx.sid ? this.store.session(ctx.sid) : undefined;
  }
  private required(ctx: Context): Session {
    if (ctx.sid && this.store.revoked(ctx.sid))
      fail('ENDPOINT_REPLACED', 'This endpoint was replaced; use the new member session.');
    return this.me(ctx) || fail('NOT_JOINED', 'Register a session first.');
  }
  private member(ctx: Context, role?: string): Session {
    const s = this.required(ctx);
    if (!s.squad_id || s.role === 'none') fail('NOT_JOINED');
    if (role && s.role !== role) fail('ROLE_NOT_ALLOWED');
    return s;
  }
  private members(id: string) {
    return this.store.sessions().filter((s) => s.squad_id === id);
  }
  private waitHint(s: Session) {
    const hints = [...this.contexts]
      .filter((c) => c.sid === s.sid && c.kind === 'mcp' && c.waitHint !== undefined)
      .map((c) => c.waitHint!);
    return hints.length ? Math.min(...hints) : recommendedWait(s.agent, {});
  }
  private envelope(ctx: Context, value: any) {
    const s = this.me(ctx);
    return {
      ...value,
      me: s
        ? {
            sid: s.sid,
            role: s.role,
            squad: s.squad_id,
            name: s.name,
            member_id: s.member_id || s.sid,
            wake_mode: this.store.standby(s.sid)?.wake_mode || 'manual',
            listener: this.standbyView(s.sid),
            identity: s.native_id ? 'confirmed' : 'provisional',
            recommended_wait: this.waitHint(s),
          }
        : null,
      unread: s ? this.inbox(s).length : 0,
    };
  }
  private board(q: Squad) {
    return {
      ...q,
      commander: q.commander_sid ? this.view(this.store.session(q.commander_sid)!) : null,
      members: this.members(q.id).map((s) => this.view(s)),
    };
  }
  standbyView(sid: string) {
    const standby = this.store.standby(sid);
    return standby
      ? {
          sid: standby.sid,
          wake_mode: standby.wake_mode,
          enabled: standby.enabled,
          health:
            hostStandby(standby.wake_mode) &&
            standby.health === 'healthy' &&
            (!standby.lease || standby.lease.expires_at <= Date.now())
              ? 'stalled'
              : standby.health,
          transport: standby.transport,
          arm: armHint(standby, this.paths.home),
          host_state: standby.host_state,
          checked_at: standby.checked_at,
          error: standby.error,
          request: standby.request
            ? {
                id: standby.request.id,
                state: standby.request.state,
                created_at: standby.request.created_at,
              }
            : undefined,
          can_auto_respond:
            standby.enabled &&
            standby.wake_mode !== 'manual' &&
            standby.health === 'healthy' &&
            (!hostStandby(standby.wake_mode) || (standby.lease?.expires_at || 0) > Date.now()),
        }
      : { wake_mode: 'manual', health: 'manual', can_auto_respond: false };
  }
  inbox(s: Session, history = false) {
    return [
      ...this.store.queue(s.sid, history),
      ...(s.role === 'commander' && s.squad_id
        ? this.store.queue(`squad:${s.squad_id}`, history)
        : []),
    ]
      .filter((m) => history || !m.blocked_by || terminalWork(this.store.message(m.blocked_by)!))
      .sort((a, b) => a.priority - b.priority || a.seq - b.seq);
  }
  actionable(sid: string): Message[] {
    const session = this.store.session(sid) || fail('NOT_JOINED');
    return [
      ...new Map(
        [
          ...this.inbox(session).filter((m) => actionable(m, sid)),
          ...this.store
            .commands(sid)
            .filter((m) => !m.blocked_by || terminalWork(this.store.message(m.blocked_by))),
        ].map((m) => [m.id, m]),
      ).values(),
    ];
  }
  private view(s: Session, full = false, commandSquad?: string) {
    const commands = this.store
      .commands(s.sid)
      .filter((m) => !commandSquad || m.squad_id === commandSquad)
      .map((m) => ({
        id: m.id,
        task_key: m.task_key,
        state: m.work?.state || (m.status === 'queued' ? 'queued' : 'read'),
        created_at: m.created_at,
        updated_at: m.work?.updated_at || m.created_at,
        unacked_for: m.work?.accepted_at ? null : Math.floor((Date.now() - m.created_at) / 1000),
        cancel_requested_at: m.work?.cancel_requested_at,
        blocked_by: m.blocked_by,
      }));
    return {
      ...(full
        ? s
        : {
            sid: s.sid,
            agent: s.agent,
            name: s.name,
            role: s.role,
            cwd: s.cwd,
            native_id: s.native_id,
            presence: s.presence,
            activity: s.activity,
            last_status: s.last_status,
          }),
      member_id: s.member_id || s.sid,
      title: titleFor(s),
      short: s.sid.slice(0, s.sid.indexOf(':') + 9),
      squad: s.squad_id,
      last_seen: s.last_seen_at,
      activity_at: s.activity_at || null,
      last_progress_at: s.last_progress_at || null,
      hook_seen_at: s.hook_seen_at || null,
      pending: commands.filter((m) => m.state === 'queued').length,
      unacked: commands.filter((m) => !['accepted'].includes(m.state)).length,
      in_progress: commands.filter((m) => m.state === 'accepted').length,
      commands,
      listener: this.standbyView(s.sid),
    };
  }
  record(
    kind: string,
    channel: string | null,
    detail: Omit<LifecycleEvent, 'event_seq' | 'at' | 'kind' | 'channel'> = {},
  ) {
    return this.store.appendEvent({ at: Date.now(), kind, channel, ...detail });
  }
  private messageEvent(kind: string, m: Message, reason?: string) {
    this.dashboard.syncCommand(m);
    this.record(kind, m.squad_id, {
      from_sid: m.from_sid,
      to_sid: m.to_sid,
      message_id: m.id,
      reply_to: m.reply_to,
      message: m,
      reason,
    });
  }
  publishEvents(after: number) {
    const events = this.store.events(after);
    for (const event of events)
      for (const c of this.contexts) {
        const t = c.tail;
        if (!t || event.event_seq <= t.after) continue;
        t.after = event.event_seq;
        if (t.squad && t.squad !== event.channel) continue;
        if (
          t.for &&
          t.for !== event.to_sid &&
          !(
            event.to_sid === `squad:${event.channel}` &&
            this.store.squad(event.channel!)?.commander_sid === t.for
          )
        )
          continue;
        if (t.actionable && !this.isWakeEvent(event, t.for)) continue;
        c.notify(
          'lifecycle.event',
          t.full
            ? event
            : {
                ...event,
                message: event.message
                  ? { ...event.message, body: event.message.body.slice(0, 160), data: null }
                  : undefined,
              },
        );
      }
    if (events.length) {
      const squads = [...new Set(events.map((e) => e.channel))];
      for (const notify of this.dashboardObservers) notify(squads);
    }
  }
  dashboardSnapshot(squad: string) {
    return {
      ...this.dashboard.snapshot(squad),
      members: this.store
        .sessions()
        .filter(
          (s) =>
            s.squad_id === squad || this.store.commands(s.sid).some((m) => m.squad_id === squad),
        )
        .map((s) => this.view(s, false, squad)),
    };
  }
  submitUserAnswer(input: unknown) {
    const parsed = answerSchema.safeParse(input);
    if (!parsed.success) fail('INVALID_ARGUMENT', parsed.error.message);
    return this.atomic(() =>
      this.dashboard.answer(parsed.data, (q, body, data) =>
        this.enqueue(null, q.squad_id, `squad:${q.squad_id}`, 'answer', body, {
          data,
          reply_to: q.id,
          attn: true,
          user: true,
        }),
      ),
    );
  }
  submitUserMessage(input: unknown) {
    const parsed = userMessageSchema.safeParse(input);
    if (!parsed.success) fail('INVALID_ARGUMENT', parsed.error.message);
    const p = parsed.data;
    return this.atomic(() => {
      // Reuse the queue's persistence and deduplicate retries while the message is retained.
      const id = `m_user_${p.submission_id}`;
      const prior = this.store.message(id);
      if (prior && (prior.squad_id !== p.squad_id || prior.body !== p.text))
        fail('SUBMISSION_CONFLICT', 'Submission ID was already used with different content');
      if (prior) return { message_id: prior.id, received_at: prior.created_at };
      const squad = this.store.squad(p.squad_id) || fail('SQUAD_NOT_FOUND');
      if (squad.status === 'dissolved') fail('INVALID_ARGUMENT', 'Squad is closed');
      const message = this.enqueue(null, squad.id, `squad:${squad.id}`, 'info', p.text, {
        id,
        user: true,
        attn: true,
        data: { source: 'dashboard', submission_id: p.submission_id },
      });
      return { message_id: message.id, received_at: message.created_at };
    });
  }
  private isWakeEvent(event: LifecycleEvent, sid?: string) {
    return (
      wakeEvent(event, sid) &&
      (!event.message?.blocked_by || terminalWork(this.store.message(event.message.blocked_by)))
    );
  }
  private atomic<T>(fn: () => T): T {
    const cursor = this.store.eventCursor();
    this.effects = [];
    let result: T;
    try {
      result = this.store.transaction(fn);
    } catch (e) {
      this.effects = [];
      throw e;
    }
    const effects = this.effects;
    this.effects = [];
    for (const m of effects) {
      const recipient = m.to_sid.startsWith('squad:')
        ? this.store.squad(m.squad_id!)?.commander_sid
        : m.to_sid;
      if (recipient) this.flag(recipient);
      for (const c of this.contexts) {
        if (c.sid === recipient)
          c.notify('msg.new', {
            sid: recipient,
            count: this.inbox(this.store.session(recipient!)!).length,
            top_priority: m.priority,
          });
        if (c.tail && (!c.tail.squad || c.tail.squad === m.squad_id))
          c.notify('msg.event', {
            message: c.tail.full ? m : { ...m, body: m.body.slice(0, 160), data: null },
            to_name: this.store.session(m.to_sid)?.name,
          });
      }
    }
    this.publishEvents(cursor);
    for (const w of [...this.waiters]) {
      if (!this.store.session(w.sid)) {
        w.finish();
        continue;
      }
      if (
        this.inbox(this.store.session(w.sid)!).some(
          (m) => !w.answer || (m.type === 'answer' && m.reply_to === w.answer),
        )
      )
        w.finish();
    }
    return result;
  }
  private flag(sid: string) {
    try {
      writeFileSync(this.paths.flag(sid), '', { mode: 0o600 });
    } catch {
      /* a reminder must not affect delivery */
    }
  }
  private clearFlag(sid: string) {
    rmSync(this.paths.flag(sid), { force: true });
  }
  private refreshFlags() {
    const queued = new Set<string>();
    for (const s of this.store.sessions()) {
      const queue = this.inbox(s);
      if (!queue.length) continue;
      queued.add(s.sid);
      if (
        queue.some((m) => m.seq > s.last_notified_seq) ||
        (queue.some((m) => m.priority <= 0) &&
          Date.now() - s.last_notified_at >= this.config.remindIntervalSec * 1000)
      )
        this.flag(s.sid);
    }
    for (const f of readdirSync(this.paths.flags))
      if (!queued.has(Buffer.from(f, 'base64url').toString()))
        rmSync(join(this.paths.flags, f), { force: true });
  }
  register(ctx: Context, p: any): Session {
    if (!['mcp', 'hook', 'cli'].includes(p.kind))
      fail('INVALID_ARGUMENT', 'Invalid registration kind');
    if (ctx.kind && ctx.kind !== p.kind) fail('ROLE_NOT_ALLOWED', 'Connection kind cannot change');
    if (ctx.agent && p.agent && ctx.agent !== p.agent)
      fail('ROLE_NOT_ALLOWED', 'Agent type cannot change on an existing connection');
    ctx.kind = p.kind;
    if (p.kind === 'cli') return undefined as any;
    const agent: Agent = /^[a-z][a-z0-9_-]{0,63}$/.test(p.agent || '') ? p.agent : 'generic';
    const sid = p.native_id
      ? `${agent}:${String(p.native_id)}`
      : p.sid || ctx.sid || provisionalId(agent);
    if (
      typeof sid !== 'string' ||
      !sid.startsWith(agent + ':') ||
      sid.length > 300 ||
      (p.native_id !== undefined &&
        (typeof p.native_id !== 'string' || !p.native_id || p.native_id.length > 256))
    )
      fail('INVALID_ARGUMENT');
    if (this.store.revoked(sid)) fail('ENDPOINT_REPLACED');
    let s = this.store.session(sid);
    if (!s)
      s = {
        sid,
        agent,
        native_id: p.native_id || null,
        name: null,
        title: null,
        cwd: null,
        pid: null,
        terminal: {},
        transcript_path: null,
        role: 'none',
        squad_id: null,
        presence: 'offline',
        activity: 'unknown',
        member_id: `member:${randomUUID()}`,
        last_status: null,
        last_notified_seq: 0,
        last_notified_at: 0,
        last_stop_block_seq: 0,
        created_at: Date.now(),
        last_seen_at: Date.now(),
        ended_at: null,
      };
    if (p.cwd) s.cwd = p.cwd;
    if (p.title) s.title = String(p.title).slice(0, 300);
    if (p.host_pid) s.pid = p.host_pid;
    if (p.terminal) s.terminal = p.terminal;
    if (p.transcript_path) s.transcript_path = p.transcript_path;
    s.last_seen_at = Date.now();
    s.ended_at = null;
    if (p.kind === 'mcp') {
      if (ctx.sid && ctx.sid !== sid)
        fail('ROLE_NOT_ALLOWED', 'Use session.identify to bind identity');
      ctx.transport = p.transport === 'cli' ? 'cli' : 'mcp';
      s.transport = ctx.transport;
      s.presence =
        ctx.transport === 'mcp' ||
        [...this.contexts].some((c) => c.sid === sid && c.kind === 'mcp' && c.transport !== 'cli')
          ? 'online'
          : 'cli';
      ctx.sid = sid;
      ctx.agent = agent;
      ctx.waitHint = Number.isFinite(p.wait_hint)
        ? Math.min(300, Math.max(0, p.wait_hint))
        : recommendedWait(agent, {});
    }
    this.store.saveSession(s);
    this.record('session.registered', s.squad_id, {
      to_sid: s.sid,
      data: { presence: s.presence, transport: s.transport },
    });
    return s;
  }
  private identify(ctx: Context, native: string, force = false) {
    if (typeof native !== 'string' || !native || native.length > 256) fail('INVALID_ARGUMENT');
    const old = this.required(ctx),
      sid = `${old.agent}:${native}`;
    if (this.store.revoked(sid)) fail('ENDPOINT_REPLACED');
    if (old.sid === sid) return old;
    if (old.native_id && !force) return old;
    const target = this.store.session(sid);
    if (target?.role !== undefined && target.role !== 'none' && old.role !== 'none')
      fail('ALREADY_JOINED', 'Both identities already belong to squads. Leave before merging.');
    const merged: Session = {
      ...old,
      ...target,
      member_id:
        old.role !== 'none'
          ? old.member_id || old.sid
          : target?.member_id || old.member_id || old.sid,
      sid,
      native_id: native,
      presence: 'online',
      ended_at: null,
      last_seen_at: Date.now(),
      cwd: target?.cwd || old.cwd,
      pid: old.pid,
      terminal: old.terminal,
    };
    if (old.role !== 'none') {
      merged.role = old.role;
      merged.squad_id = old.squad_id;
      merged.name = old.name;
    }
    this.store.saveSession(merged);
    for (const q of this.store.squads())
      if (q.commander_sid === old.sid) {
        q.commander_sid = sid;
        this.store.saveSquad(q);
      }
    for (const m of this.store.messages()) {
      // Keep sender name/role snapshots, but canonicalize IDs for reply routing.
      if (m.to_sid === old.sid || m.from_sid === old.sid) {
        if (m.to_sid === old.sid) m.to_sid = sid;
        if (m.from_sid === old.sid) m.from_sid = sid;
        this.store.saveMessage(m);
      }
    }
    this.store.migrateMembership(old.sid, sid);
    // The listener follows the member and is dropped without one. Its lease and wake
    // request belong to the old session, so the host must re-arm for the new one.
    const standby = this.store.standby(old.sid);
    if (standby) {
      this.store.deleteStandby(old.sid);
      if (old.role !== 'none')
        this.store.saveStandby({
          ...standby,
          sid,
          lease: undefined,
          request: undefined,
          health: standby.enabled && standby.wake_mode !== 'manual' ? 'starting' : standby.health,
        });
    }
    this.store.deleteSession(old.sid);
    for (const c of this.contexts)
      if (c.sid === old.sid) {
        c.sid = sid;
        c.notify('session.bound', { sid, native_id: native });
      }
    for (const w of this.waiters) if (w.sid === old.sid) w.sid = sid;
    this.clearFlag(old.sid);
    if (this.store.queue(sid).length) this.flag(sid);
    return merged;
  }
  private enqueue(
    from: Session | null,
    q: string,
    to: string,
    type: MessageType,
    body: string,
    opts: {
      id?: string;
      priority?: number;
      data?: any;
      reply_to?: string;
      attn?: boolean;
      operator?: boolean;
      direct?: boolean;
      terminalAck?: boolean;
      task_id?: string;
      user?: boolean;
    } = {},
  ) {
    if (
      !opts.terminalAck &&
      this.store.queue(to).filter((m) => (m.type === 'cancel') === (type === 'cancel')).length >=
        (type === 'cancel' ? 100 : this.config.maxQueue)
    )
      fail('QUEUE_FULL', `Queue for ${to} is full`);
    const m: Message = {
      id: opts.id || messageId(),
      seq: 0,
      squad_id: q,
      type,
      priority:
        opts.priority ??
        (['command', 'cancel', 'ask', 'answer'].includes(type) ? 0 : type === 'report' ? 2 : 1),
      from_sid: from?.sid || (opts.user ? 'user' : opts.operator ? 'operator' : 'system'),
      from_role: from?.role || (opts.user ? 'user' : opts.operator ? 'operator' : 'system'),
      from_name: from?.name || null,
      to_sid: to,
      body,
      data: opts.data || null,
      reply_to: opts.reply_to || null,
      status: 'queued',
      attn: opts.attn ?? ['command', 'cancel', 'ask', 'answer'].includes(type),
      direct: opts.direct,
      created_at: Date.now(),
      delivered_at: null,
      ...(opts.task_id ? { task_id: opts.task_id } : {}),
    };
    if (type === 'command') m.work = { state: 'queued', updated_at: m.created_at };
    this.store.insert(m);
    this.messageEvent('message.queued', m);
    this.effects.push(m);
    return m;
  }
  private system(q: Squad, to: Session[], body: string, high = false) {
    for (const s of to)
      this.enqueue(null, q.id, s.sid, 'system', body, { priority: high ? 0 : 1, attn: high });
  }
  private roleInbox(q: Squad, old: string) {
    for (const m of this.store.messages())
      if (
        m.squad_id === q.id &&
        m.to_sid === old &&
        !['command', 'cancel', 'answer'].includes(m.type)
      ) {
        m.to_sid = `squad:${q.id}`;
        this.store.saveMessage(m);
      }
  }
  private rebind(ctx: Context, member: string) {
    const target = this.required(ctx);
    if (!target.native_id) fail('IDENTITY_REQUIRED');
    const old =
      this.store.sessions().find((s) => (s.member_id || s.sid) === member) ||
      fail('MEMBER_NOT_FOUND');
    if (old.sid === target.sid) return;
    if (!old.squad_id) fail('NOT_JOINED', 'The member must belong to a channel before rebinding');
    if (target.squad_id) fail('ALREADY_JOINED');
    const merged = {
      ...old,
      sid: target.sid,
      agent: target.agent,
      native_id: target.native_id,
      member_id: old.member_id || old.sid,
      pid: target.pid,
      cwd: target.cwd,
      terminal: target.terminal,
      transcript_path: target.transcript_path,
      presence: target.presence,
      transport: target.transport,
      activity: 'unknown' as const,
      last_seen_at: Date.now(),
      ended_at: null,
    };
    this.store.saveSession(merged);
    for (const q of this.store.squads())
      if (q.commander_sid === old.sid) {
        q.commander_sid = target.sid;
        this.store.saveSquad(q);
      }
    for (const m of this.store.messages()) {
      if (m.to_sid === old.sid) m.to_sid = target.sid;
      if (m.from_sid === old.sid) m.from_sid = target.sid;
      this.store.saveMessage(m);
    }
    this.store.migrateMembership(old.sid, target.sid);
    this.store.revoke(old.sid, target.sid);
    this.store.deleteSession(old.sid);
    this.store.deleteStandby(old.sid);
    for (const w of this.waiters) if (w.sid === old.sid) w.finish();
    this.clearFlag(old.sid);
    if (this.inbox(merged).length) this.flag(target.sid);
    this.record('member.rebound', merged.squad_id, {
      from_sid: old.sid,
      to_sid: target.sid,
      data: { member_id: merged.member_id, wake_mode: 'manual' },
    });
  }
  private joinSquad(ctx: Context, p: any) {
    if (p.rebind && (p.role || p.squad || p.squad_name || p.takeover))
      fail('INVALID_ARGUMENT', 'rebind cannot be combined with a role or channel change');
    if (p.rebind) this.rebind(ctx, p.rebind);
    const s = this.required(ctx);
    let q: Squad | undefined,
      role = p.role;
    if (p.squad_name) {
      if (p.squad) fail('INVALID_ARGUMENT', 'Use squad or squad_name, not both');
      q = this.store
        .squads()
        .find((q) => q.name_key === p.squad_name.toLowerCase() && q.status !== 'dissolved');
      if (s.squad_id === q?.id && !role) return this.joinResult(ctx, q!);
      role ||= 'executor';
    } else if (p.squad) q = this.store.squad(p.squad) || fail('SQUAD_NOT_FOUND');
    else if (p.rebind && s.squad_id) return this.joinResult(ctx, this.store.squad(s.squad_id)!);
    if (!role) fail('INVALID_ARGUMENT', 'Provide role or squad_name');
    if (q?.status === 'dissolved') fail('SQUAD_NOT_FOUND', 'Channel is closed');
    if (s.squad_id) {
      if (
        (q?.id === s.squad_id || (!q && !p.squad_name && role === 'commander')) &&
        s.role === role
      )
        return this.joinResult(ctx, this.store.squad(s.squad_id)!);
      if (q?.id === s.squad_id && role === 'commander') this.store.leave(s.sid);
      else fail('ALREADY_JOINED');
    }
    if (!q) {
      if (role !== 'commander' && !p.squad_name) fail('SQUAD_NOT_FOUND');
      const name = p.squad_name || p.name || null,
        key = name?.toLowerCase() || null;
      if (key && this.store.squads().some((x) => x.name_key === key && x.status !== 'dissolved'))
        fail('SQUAD_NAME_EXISTS');
      let id: string;
      do {
        id = squadId();
      } while (this.store.squad(id));
      q = {
        id,
        name,
        name_key: key,
        commander_sid: role === 'commander' ? s.sid : null,
        status: role === 'commander' ? 'active' : 'orphaned',
        created_at: Date.now(),
        updated_at: Date.now(),
      };
      this.record('channel.created', q.id);
    } else if (role === 'commander') {
      if (q.commander_sid && q.commander_sid !== s.sid) {
        if (!p.takeover)
          fail(
            'SQUAD_HAS_COMMANDER',
            'Use takeover=true for an explicit handover; offline does not mean stopped.',
          );
        const old = this.store.session(q.commander_sid)!;
        this.roleInbox(q, old.sid);
        this.store.leave(old.sid);
        old.role = 'executor';
        this.store.saveSession(old);
        this.store.join(old);
        this.record('commander.handover', q.id, { from_sid: old.sid, to_sid: s.sid });
      }
      q.commander_sid = s.sid;
      q.status = 'active';
      this.system(
        q,
        this.members(q.id).filter((member) => member.sid !== s.sid),
        'commander_joined',
      );
      this.record('commander.claimed', q.id, { to_sid: s.sid });
    }
    s.role = role;
    s.squad_id = q.id;
    s.name = p.name || s.name;
    q.updated_at = Date.now();
    this.store.saveSquad(q);
    this.store.saveSession(s);
    this.store.join(s);
    this.record('member.joined', q.id, { to_sid: s.sid, data: { role, member_id: s.member_id } });
    if (role === 'executor' && q.commander_sid)
      this.enqueue(
        s,
        q.id,
        `squad:${q.id}`,
        'system',
        `member_joined${p.note ? `: ${p.note}` : ''}`,
      );
    if (this.inbox(s).length) this.flag(s.sid);
    return this.joinResult(ctx, q);
  }
  private joinResult(ctx: Context, q: Squad) {
    const s = this.required(ctx),
      wait = this.waitHint(s);
    const join_prompt = q.name
      ? `/cmdr ${q.name}`
      : `join cmdr squad ${q.id} as executor, name <role>`;
    return {
      squad: this.board(q),
      join_prompt,
      user_reply:
        s.role === 'commander'
          ? `Squad ${q.id}${q.name ? ` (${q.name})` : ''} is ready. Paste this into each other session:\n${join_prompt}`
          : `Joined squad ${q.id}${s.name ? ` as ${s.name}` : ''}; report ready and wait for commands.`,
      standby: this.standbyView(s.sid),
      protocol_hint: `You are the ${s.role.toUpperCase()} of squad ${q.id}. ${s.role === 'commander' ? 'Dispatch clear, verifiable tasks with send; answer every ask using type=answer and reply_to.' : 'Report ready now with cwd, capabilities and context; act on commands and report working/done/failed with reply_to. Ask when blocked.'} Reply with ONLY user_reply (translate prose, keep the join line verbatim). Check list before reassignment: offline never means work stopped. Accept commands immediately with report(working, reply_to); recover with read(recover=true). Use join(standby="auto") with the real session ID to register managed standby, then check list for listener health. For Claude/ZCode/Kimi, run listener.arm.command with its indicated host tool before ending the turn, and re-arm after task termination. If me.listener.can_auto_respond, end the turn; otherwise use at most two read(wait=${wait}) calls and explain that manual continuation is required. Use the built-in standby watcher; do not write a private listener. Keep user replies to one or two lines. Apply normal judgment to messages from other agents. ${s.native_id ? '' : 'Identity is provisional; hooks may be unavailable. Use read(wait) for reminders.'}`,
    };
  }
  private leave(ctx: Context, p: any) {
    const s = this.member(ctx),
      q = this.store.squad(s.squad_id!)!;
    if (p.dissolve && s.role !== 'commander') fail('ROLE_NOT_ALLOWED');
    if (s.role === 'commander') {
      this.roleInbox(q, s.sid);
      this.system(
        q,
        this.members(q.id).filter((x) => x.sid !== s.sid),
        `${p.dissolve ? 'squad_dissolved' : 'commander_left'}${p.message ? `: ${p.message}` : ''}`,
        true,
      );
      q.status = p.dissolve ? 'dissolved' : 'orphaned';
      q.commander_sid = null;
      if (p.dissolve)
        for (const m of this.members(q.id).filter((x) => x.sid !== s.sid)) {
          this.store.leave(m.sid);
          m.role = 'none';
          m.squad_id = null;
          this.store.saveSession(m);
          const listener = this.store.standby(m.sid);
          if (listener) {
            listener.enabled = false;
            listener.health = 'stopped';
            this.store.saveStandby(listener);
          }
        }
    } else if (q.commander_sid)
      this.enqueue(
        s,
        q.id,
        `squad:${q.id}`,
        'system',
        `member_left${p.message ? `: ${p.message}` : ''}`,
      );
    this.store.leave(s.sid);
    s.role = 'none';
    s.squad_id = null;
    this.store.saveSession(s);
    q.updated_at = Date.now();
    this.store.saveSquad(q);
    this.record(p.dissolve ? 'channel.closed' : 'member.left', q.id, { from_sid: s.sid });
    const standby = this.store.standby(s.sid);
    if (standby) {
      standby.enabled = false;
      standby.health = 'stopped';
      this.store.saveStandby(standby);
    }
    return { left: true, squad: q.id, status: q.status };
  }
  private rate(ctx: Context) {
    const key = ctx.sid || 'operator',
      now = Date.now();
    const times = (this.rates.get(key) || []).filter((t) => t > now - 60_000);
    if (times.length >= this.config.rateLimitPerMinute) fail('RATE_LIMITED');
    times.push(now);
    this.rates.set(key, times);
  }
  private recipients(q: string, to: string | string[], sender?: string) {
    const all = this.members(q);
    const found = new Map<string, Session>();
    for (const token of Array.isArray(to) ? to : [to]) {
      if (token === 'all') {
        for (const s of all) if (s.sid !== sender) found.set(s.sid, s);
        continue;
      }
      const exact = all.filter((s) => s.sid === token || s.member_id === token);
      const matches = exact.length
        ? exact
        : all.filter((s) => s.name === token || s.sid.startsWith(token));
      if (matches.length !== 1)
        fail(
          'RECIPIENT_NOT_FOUND',
          matches.length ? `Ambiguous recipient: ${token}` : `No recipient: ${token}`,
        );
      found.set(matches[0].sid, matches[0]);
    }
    return [...found.values()];
  }
  private send(ctx: Context, p: any, squad?: string) {
    const from = ctx.kind === 'cli' ? null : this.member(ctx, 'commander');
    const qid = from?.squad_id || squad || fail('SQUAD_NOT_FOUND');
    const q = this.store.squad(qid) || fail('SQUAD_NOT_FOUND');
    if (q.status === 'dissolved') fail('SQUAD_NOT_FOUND');
    const recipients = this.recipients(qid, p.to, from?.sid);
    if (p.type === 'answer') {
      const ask = p.reply_to && this.store.message(p.reply_to);
      if (
        !ask ||
        ask.type !== 'ask' ||
        ask.squad_id !== qid ||
        recipients.length !== 1 ||
        recipients[0].sid !== ask.from_sid
      )
        fail(
          'INVALID_ARGUMENT',
          'Answers require reply_to for an ask from the recipient in this squad.',
        );
    }
    if (p.type === 'cancel' && (!p.reply_to || p.reassign))
      fail('INVALID_ARGUMENT', 'cancel requires reply_to=<command id>');
    const previous = p.reassign ? this.store.message(p.reassign) : undefined;
    const taskId = previous?.task_id || p.task_id;
    if (p.task_id && previous?.task_id && p.task_id !== previous.task_id)
      fail('INVALID_ARGUMENT', 'Reassignment must preserve task_id');
    if (taskId && (p.type !== 'command' || recipients.length !== 1))
      fail('INVALID_ARGUMENT', 'task_id requires one command recipient');
    const task = taskId ? this.dashboard.beforeDispatch(taskId, qid, previous) : undefined;
    if (
      p.reassign &&
      (p.type !== 'command' ||
        !previous ||
        previous.type !== 'command' ||
        previous.squad_id !== qid ||
        terminalWork(previous) ||
        recipients.length !== 1)
    )
      fail('INVALID_ARGUMENT', 'reassign must reference one unfinished command in this channel');
    if (previous?.work?.replacement_id) fail('ALREADY_REASSIGNED');
    if (previous?.task_key && p.task_key && p.task_key !== previous.task_key)
      fail('INVALID_ARGUMENT', 'Reassignment must preserve the original task_key');
    const taskKey = previous?.task_key || p.task_key || taskId;
    if (p.task_key && (p.type !== 'command' || recipients.length !== 1))
      fail(
        'INVALID_ARGUMENT',
        'task_key identifies one command owner; do not broadcast the same ticket',
      );
    if (
      taskKey &&
      this.store
        .commands()
        .some((m) => m.squad_id === qid && m.task_key === taskKey && m.id !== previous?.id)
    )
      fail('TASK_OWNED', 'This task_key already has unfinished work. Use reassign=<command id>.');
    const warnings = recipients.flatMap((s) => {
      const active = this.store.commands(s.sid);
      return active.length
        ? [
            {
              code: 'UNFINISHED_WORK',
              sid: s.sid,
              command_ids: active.map((m) => m.id),
              message: 'Verify ownership before dispatch. Offline does not mean stopped.',
            },
          ]
        : [];
    });
    this.rate(ctx);
    const cancel = (command: Message, body: string) => {
      command.work ||= {
        state: command.status === 'queued' ? 'queued' : 'read',
        updated_at: command.created_at,
      };
      command.work.cancel_requested_at = Date.now();
      // Unread work cannot have been accepted under the protocol. Read work needs the owner's acknowledgement.
      if (command.work.state === 'queued') {
        command.work.state = 'cancelled';
        command.status = 'delivered';
        command.delivered_at = Date.now();
      }
      command.work.updated_at = Date.now();
      this.store.saveMessage(command);
      this.messageEvent(
        command.work.state === 'cancelled' ? 'work.cancelled' : 'work.cancel_requested',
        command,
      );
      return this.enqueue(from, qid, command.to_sid, 'cancel', body, {
        priority: -1,
        reply_to: command.id,
        attn: true,
        operator: ctx.kind === 'cli',
        task_id: taskId,
      });
    };
    if (previous)
      cancel(
        previous,
        `Cancel command ${previous.id} at the next safe checkpoint and report cancelled with reply_to. Reassignment waits for your terminal report.`,
      );
    const messages = recipients.map((s) => {
      if (p.type === 'cancel') {
        const command = this.store.message(p.reply_to);
        if (
          !command ||
          command.type !== 'command' ||
          command.to_sid !== s.sid ||
          command.squad_id !== qid ||
          terminalWork(command)
        )
          fail('INVALID_ARGUMENT', 'Cancel target must own an unfinished command');
        return cancel(command, p.message);
      }
      const m = this.enqueue(from, qid, s.sid, p.type, p.message, {
        priority: p.priority ? { high: 0, normal: 1, low: 2 }[p.priority as 'high'] : undefined,
        reply_to: p.reply_to,
        data: p.data,
        attn: p.attention,
        direct: !(Array.isArray(p.to) ? p.to : [p.to]).includes('all'),
        operator: ctx.kind === 'cli',
        task_id: taskId,
      });
      if (p.type === 'command') {
        m.task_key = taskKey;
        if (previous && !terminalWork(previous)) m.blocked_by = previous.id;
        this.store.saveMessage(m);
        if (task) this.dashboard.attach(this.store.dashboardRecord('task', task.id)!, m, s);
        if (previous) {
          previous.work!.replacement_id = m.id;
          this.store.saveMessage(previous);
          this.messageEvent(
            'work.reassigned',
            m,
            `Replaces ${previous.id}; ${m.blocked_by ? 'waiting for original owner to stop' : 'original was unread'}`,
          );
        }
      }
      return m;
    });
    return {
      ids: messages.map((m) => m.id),
      queued_to: recipients.map((s) => s.sid),
      delivered_to: recipients.map((s) => s.sid),
      delivery_hint: 'queued_to / delivered_to mean enqueued, not read or accepted',
      warnings: p.type === 'command' ? warnings : [],
      blocked_by: messages.find((m) => m.blocked_by)?.blocked_by,
      offline: recipients.filter((s) => s.presence === 'offline').map((s) => s.sid),
      idle: recipients.filter((s) => s.activity === 'idle').map((s) => s.sid),
    };
  }
  private reportOrAsk(ctx: Context, p: any, ask: boolean) {
    const s = !ask && p.reply_to ? this.required(ctx) : this.member(ctx, 'executor');
    let command = !ask && p.reply_to ? this.store.message(p.reply_to) : undefined;
    let terminalAck = false;
    const q = this.store.squad(command?.squad_id || s.squad_id!) || fail('NOT_JOINED');
    if (!ask && p.reply_to) {
      command = this.store.message(p.reply_to);
      if (
        !command ||
        command.type !== 'command' ||
        command.to_sid !== s.sid ||
        command.squad_id !== q.id
      )
        fail('INVALID_ARGUMENT', 'reply_to must identify a command owned by this member');
      if (command.blocked_by && !terminalWork(this.store.message(command.blocked_by)))
        fail('REASSIGNMENT_PENDING', 'Original owner has not stopped');
      const state = (
        {
          working: 'accepted',
          blocked: 'accepted',
          done: 'completed',
          failed: 'failed',
          cancelled: 'cancelled',
        } as const
      )[p.status as 'working'];
      if (!state) fail('INVALID_ARGUMENT', 'ready is not a command acknowledgement');
      if (terminalWork(command) && state !== command.work!.state) fail('WORK_TERMINAL');
      if (!terminalWork(command)) {
        const now = Date.now();
        command.work ||= { state: 'read', updated_at: now };
        if (command.work.cancel_requested_at && state === 'accepted')
          fail('CANCEL_REQUESTED', 'Stop at a safe checkpoint and report cancelled');
        const changed = command.work.state !== state;
        command.work.state = state;
        command.work.updated_at = now;
        if (state === 'accepted') command.work.accepted_at ||= now;
        command.status = 'delivered';
        command.delivered_at ||= now;
        this.store.saveMessage(command);
        terminalAck = terminalWork(command);
        this.messageEvent(changed ? `work.${state}` : 'work.progress', command);
        if (terminalWork(command) && command.work.replacement_id) {
          const replacement = this.store.message(command.work.replacement_id)!;
          this.effects.push(replacement);
          this.messageEvent('work.released', replacement);
        }
      }
    }
    this.rate(ctx);
    const to = `squad:${q.id}`;
    const m = this.enqueue(s, q.id, to, ask ? 'ask' : 'report', ask ? p.question : p.message, {
      reply_to: p.reply_to,
      data: ask ? p.data : { ...p.data, status: p.status },
      priority: ask ? 0 : ['blocked', 'failed'].includes(p.status) ? 1 : 2,
      attn: ask || ['done', 'failed', 'blocked', 'cancelled'].includes(p.status),
      // Each issued command reserves admission for its first terminal report.
      // Keep work and report atomic even under backpressure; repeats use the ordinary cap.
      terminalAck,
    });
    if (!ask) {
      if (command)
        this.dashboard.syncCommand(command, {
          status: p.status,
          message: p.message,
          at: m.created_at,
        });
      s.last_status = { status: p.status, message: p.message.slice(0, 300) };
      s.last_progress_at = Date.now();
      s.activity_at = Date.now();
      s.activity = this.store.commands(s.sid).some((m) => m.work?.state === 'accepted')
        ? 'busy'
        : 'idle';
      this.store.saveSession(s);
    }
    return {
      id: m.id,
      delivered_to: to,
      queued_to: to,
      work: command?.work,
      ...(!ask && !p.reply_to && this.store.commands(s.sid).length
        ? { warning: 'Uncorrelated report does not accept or finish a command; provide reply_to.' }
        : {}),
      commander_presence: q.commander_sid
        ? this.store.session(q.commander_sid)?.presence
        : 'orphaned',
      answered: false,
    };
  }
  private readNow(ctx: Context, p: any, answer?: string) {
    const s = this.required(ctx);
    let queue = p.recover
      ? this.store
          .commands(s.sid)
          .filter((m) => !m.blocked_by || terminalWork(this.store.message(m.blocked_by)))
      : this.inbox(s, p.history);
    if (p.id) {
      const m = this.store.message(p.id);
      if (
        !m ||
        (m.to_sid !== s.sid && !(s.role === 'commander' && m.to_sid === `squad:${s.squad_id}`))
      )
        fail('MESSAGE_NOT_FOUND');
      // Gate queued work; keep delivered history readable after its predecessor expires.
      if (m.status === 'queued' && m.blocked_by && !terminalWork(this.store.message(m.blocked_by)))
        fail('REASSIGNMENT_PENDING', 'Original owner has not stopped');
      queue = [m];
    }
    if (p.since) {
      const since = this.store.message(p.since);
      if (
        !since ||
        (since.to_sid !== s.sid &&
          !(s.role === 'commander' && since.to_sid === `squad:${s.squad_id}`))
      )
        fail('INVALID_ARGUMENT', 'Unknown since message');
      queue = queue.filter((m) => m.seq > since.seq);
    }
    if (answer) queue = queue.filter((m) => m.type === 'answer' && m.reply_to === answer);
    const messages = bounded(queue, p.limit || 20);
    if (!p.peek && !p.history && !p.recover && !p.id && !ctx.closed)
      for (const m of messages) {
        m.status = 'delivered';
        m.delivered_at = Date.now();
        if (m.type === 'command' && (!m.work || m.work.state === 'queued'))
          m.work = { ...m.work, state: 'read', updated_at: Date.now() };
        this.store.saveMessage(m);
        this.messageEvent('message.read', m);
      }
    const remaining = this.inbox(s).length;
    if (!remaining) this.clearFlag(s.sid);
    return {
      messages: ctx.closed ? [] : messages,
      remaining,
      ...(p.full
        ? { squad_summary: s.squad_id ? this.board(this.store.squad(s.squad_id)!) : null }
        : {}),
    };
  }
  private wait(
    ctx: Context,
    seconds: number,
    answer?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!seconds || ctx.closed || signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const w: Waiter = {
        ctx,
        sid: ctx.sid!,
        answer,
        timer: undefined as any,
        finish: () => {
          clearTimeout(w.timer);
          signal?.removeEventListener('abort', w.finish);
          this.waiters.delete(w);
          resolve();
        },
      };
      w.timer = setTimeout(w.finish, seconds * 1000);
      this.waiters.add(w);
      signal?.addEventListener('abort', w.finish, { once: true });
      if (
        this.inbox(this.store.session(w.sid)!).some(
          (m) => !answer || (m.type === 'answer' && m.reply_to === answer),
        )
      )
        w.finish();
    });
  }
  private list(ctx: Context, p: any) {
    const me = this.me(ctx),
      squad = p.squad || (p.scope !== 'all' ? me?.squad_id : null);
    if (squad && !this.store.squad(squad)) fail('SQUAD_NOT_FOUND');
    return {
      sessions: this.store
        .sessions()
        .filter((s) =>
          squad
            ? s.squad_id === squad || this.store.commands(s.sid).some((m) => m.squad_id === squad)
            : s.presence === 'online' || s.role !== 'none' || this.store.commands(s.sid).length > 0,
        )
        .map((s) => ({
          ...this.view(s, p.full, squad || undefined),
          ...(s.sid === me?.sid ? { unread: this.inbox(s).length } : {}),
        })),
      squads: this.store
        .squads()
        .filter((q) => (squad ? q.id === squad : q.status !== 'dissolved'))
        .map((q) => (p.full ? this.board(q) : q)),
    };
  }
  private hook(ctx: Context, p: any) {
    if (
      !p.session_id ||
      !['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'Stop'].includes(p.event)
    )
      return {};
    const agent: Agent = /^[a-z][a-z0-9_-]{0,63}$/.test(p.agent || '') ? p.agent : 'generic',
      sid = `${agent}:${p.session_id}`;
    if (this.store.revoked(sid)) return {};
    let s = this.store.session(sid);
    if (p.event === 'SessionEnd' && !s) return {};
    if (p.event === 'SessionStart' && agent !== 'kimi') {
      // Kimi Code pools one MCP process per workspace and restores sessions at
      // startup, so ancestor/cwd matching misidentifies the shared connection;
      // kimi identity arrives per call via _cmdr_session stamps instead.
      const candidates = [...this.contexts]
        .filter((c) => c.kind === 'mcp' && c.agent === agent && c.sid !== sid)
        .filter((c) => {
          const old = this.me(c)!;
          return (
            (p.ancestors || []).includes(old.pid) &&
            (p.source === 'clear' || (!old.native_id && old.cwd && old.cwd === p.cwd))
          );
        });
      if (candidates.length === 1)
        s = this.identify(candidates[0], p.session_id, p.source === 'clear');
    }
    if (p.event !== 'SessionEnd')
      s = this.register(ctx, {
        kind: 'hook',
        agent,
        native_id: p.session_id,
        // Kimi desktop agent-level hooks report the bootstrap cwd "/" rather
        // than the session's, so only its SessionStart cwd may update it;
        // other hosts keep updating cwd from any hook event.
        ...(agent !== 'kimi' || p.event === 'SessionStart' ? { cwd: p.cwd } : {}),
        host_pid: p.host_pid,
        transcript_path: p.transcript_path,
      });
    if (!s) return {};
    const now = Date.now();
    s.last_seen_at = now;
    s.hook_seen_at = now;
    s.activity_at = now;
    this.record('session.activity', s.squad_id, {
      to_sid: s.sid,
      reason: p.event,
      data: {
        activity: p.event === 'Stop' ? 'idle' : p.event === 'SessionEnd' ? s.activity : 'busy',
        presence: p.event === 'SessionEnd' ? 'offline' : s.presence,
      },
    });
    if (p.event === 'SessionEnd') {
      s.presence = 'offline';
      s.ended_at = now;
      this.store.saveSession(s);
      return {};
    }
    s.activity = p.event === 'Stop' ? 'idle' : 'busy';
    const queue = this.inbox(s),
      max = Math.max(0, ...queue.map((m) => m.seq));
    const groups = new Map<string, number>();
    for (const m of queue) {
      const sender = (m.from_name || m.from_role).replace(/[\r\n\t]/g, ' ').slice(0, 30);
      const label = `${m.type} (${m.priority < 0 ? 'urgent' : ['high', 'normal', 'low'][m.priority]}) from ${sender}`;
      groups.set(label, (groups.get(label) || 0) + 1);
    }
    const details = [...groups]
      .slice(0, 3)
      .map(([label, n]) => `${n} ${label}`)
      .join(', ')
      .slice(0, 175);
    const summary = `[cmdr] ${queue.length} unread in squad ${s.squad_id || 'previous'}: ${details}. Call cmdr read now.`;
    const result: { inject?: string; block?: boolean; reason?: string } = {};
    if (p.event === 'Stop') {
      const attn = Math.max(0, ...queue.filter((m) => m.attn).map((m) => m.seq));
      if (!p.stop_hook_active && attn > s.last_stop_block_seq) {
        result.block = true;
        result.reason = summary;
        s.last_stop_block_seq = attn;
      }
    } else if (p.event === 'SessionStart' && s.role !== 'none') {
      const listener = this.store.standby(s.sid);
      const rearm =
        listener?.enabled && hostStandby(listener.wake_mode)
          ? 'Check list.listener.arm; re-arm the host watcher if its task stopped. '
          : '';
      result.inject =
        `[cmdr] ${rearm}Context restored: ${s.role} in squad ${s.squad_id}. ${s.role === 'commander' ? 'Send tasks; answer asks with reply_to.' : 'Report progress with reply_to; ask when blocked.'} Read(wait=${this.waitHint(s)}). ${summary}`.slice(
          0,
          300,
        );
    } else if (
      queue.length &&
      (max > s.last_notified_seq ||
        (queue.some((m) => m.priority <= 0) &&
          now - s.last_notified_at >= this.config.remindIntervalSec * 1000))
    )
      result.inject = summary.slice(0, 300);
    if (result.inject) {
      s.last_notified_seq = max;
      s.last_notified_at = now;
      this.clearFlag(sid);
    }
    this.store.saveSession(s);
    return result;
  }
  housekeep(all = false) {
    this.atomic(() => {
      const cutoff = Date.now() - this.config.ttlDays * 86400000;
      this.store.expireMessages(all ? Number.MAX_SAFE_INTEGER : cutoff);
      this.store.expireEvents(all ? Number.MAX_SAFE_INTEGER : cutoff);
      if (all) this.store.purge();
      for (const s of this.store.sessions())
        if (
          all ||
          (!s.squad_id &&
            s.presence !== 'online' &&
            s.last_seen_at < cutoff &&
            !this.store.commands(s.sid).length)
        ) {
          if (s.squad_id && s.role === 'commander') {
            const q = this.store.squad(s.squad_id)!;
            q.commander_sid = null;
            q.status = 'orphaned';
            q.updated_at = Date.now();
            this.store.saveSquad(q);
            if (!all)
              this.system(
                q,
                this.members(q.id).filter((m) => m.sid !== s.sid),
                'commander_expired',
                true,
              );
          }
          for (const m of this.store.messages())
            if (m.to_sid === s.sid) this.store.deleteMessage(m.id);
          this.store.deleteMemberships(s.sid);
          this.store.deleteSession(s.sid);
        }
      for (const q of this.store.squads())
        if (
          all ||
          (q.status === 'dissolved' &&
            !this.store.hasDashboard(q.id) &&
            q.updated_at < cutoff &&
            !this.members(q.id).length &&
            !this.store.commands().some((m) => m.squad_id === q.id))
        )
          this.store.deleteSquad(q.id);
    });
    if (all)
      for (const ctx of this.contexts) {
        ctx.sid = undefined;
        if (ctx.kind === 'mcp') ctx.notify('session.reset', {});
      }
    if (all) for (const notify of this.dashboardObservers) notify([null]);
    for (const [sid, times] of this.rates)
      if (!times.some((t) => t > Date.now() - 60000)) this.rates.delete(sid);
    this.refreshFlags();
    return { purged: true };
  }
  async handle(ctx: Context, method: string, params: any = {}, signal?: AbortSignal): Promise<any> {
    if (ctx.closed) fail('DAEMON_UNAVAILABLE');
    if (method === 'session.register')
      return this.envelope(
        ctx,
        this.atomic(() => ({ session: this.register(ctx, params) })),
      );
    if (method === 'session.identify')
      return this.envelope(
        ctx,
        this.atomic(() => ({ session: this.identify(ctx, params.native_id) })),
      );
    if (method === 'hook.event') return this.atomic(() => this.hook(ctx, params));
    if (method.startsWith('admin.')) {
      if (ctx.kind !== 'cli') fail('ROLE_NOT_ALLOWED');
      if (method === 'admin.status')
        return {
          sessions: this.store.sessions().length,
          provisional: this.store
            .sessions()
            .filter((s) => !s.native_id)
            .map((s) => ({
              sid: s.sid,
              age_ms: Date.now() - s.created_at,
              presence: s.presence,
              role: s.role,
              identity: 'provisional',
            })),
          squads: this.store.squads().length,
          connections: [...this.contexts].filter((c) => c.kind === 'mcp').length,
          clients: [...this.contexts].map((c) => ({
            sid: c.sid,
            kind: c.kind,
            version: c.version,
            client: c.client,
            observing: c.tail ? { for: c.tail.for, squad: c.tail.squad } : undefined,
          })),
          listeners: this.store.standbys().map((s) => this.standbyView(s.sid)),
        };
      if (method === 'admin.housekeep' || method === 'admin.purge')
        return this.housekeep(method === 'admin.purge' && params.all === true);
      if (method === 'admin.peek')
        return { messages: this.inbox(this.store.session(params.sid) || fail('NOT_JOINED')) };
      if (method === 'admin.read') {
        const s = this.store.session(params.sid) || fail('NOT_JOINED');
        return this.atomic(() =>
          this.readNow({ ...ctx, sid: s.sid }, parse('read', params.options || {})),
        );
      }
      if (method === 'admin.tail' || method === 'admin.events') {
        const after =
          params.after === 'now' || (params.after === undefined && method === 'admin.tail')
            ? this.store.eventCursor()
            : params.after === undefined
              ? Math.max(0, this.store.eventCursor() - 20)
              : params.after;
        if (!Number.isSafeInteger(after) || after < 0)
          fail('INVALID_ARGUMENT', 'after must be a nonnegative event_seq');
        const high = this.store.eventCursor();
        if (after > high)
          fail(
            'CURSOR_AHEAD',
            'Cursor is ahead of this database; verify CMDR_HOME or restart from --after 0',
          );
        const recipient = params.for ? this.store.session(params.for) : undefined;
        const candidates = this.store.eventPage(after, {
          squad: params.squad,
          to: params.for,
          roleInbox: recipient?.role === 'commander' ? `squad:${recipient.squad_id}` : undefined,
        });
        const events = bounded(
          params.full
            ? candidates
            : candidates.map((e) => ({
                ...e,
                message: e.message
                  ? {
                      ...e.message,
                      body: e.message.body.slice(0, 160),
                      data: null,
                    }
                  : undefined,
              })),
          100,
        );
        const next = events.length < candidates.length ? events[events.length - 1].event_seq : high;
        if (method === 'admin.tail')
          ctx.tail = {
            squad: params.squad,
            for: params.for,
            full: params.full,
            actionable: params.actionable,
            after: high,
          };
        return {
          events: params.actionable
            ? events.filter((e) => this.isWakeEvent(e, params.for))
            : events,
          next,
          high,
          gap: after < this.store.eventFloor(),
          retained_after: this.store.eventFloor(),
        };
      }
      if (method === 'admin.recent')
        return {
          messages: this.store
            .messages()
            .filter((m) => !params.squad || m.squad_id === params.squad)
            .slice(-20),
        };
      fail('INVALID_ARGUMENT', `Unknown method ${method}`);
    }
    const map: Record<string, Tool> = {
      'session.join': 'join',
      'session.leave': 'leave',
      'session.list': 'list',
      'msg.send': 'send',
      'msg.report': 'report',
      'msg.ask': 'ask',
      'msg.read': 'read',
      'msg.peek': 'read',
      'msg.history': 'read',
      'dashboard.task': 'task',
      'dashboard.artifact': 'artifact',
    };
    const tool = map[method] || fail('INVALID_ARGUMENT', `Unknown method ${method}`);
    const { squad: operatorSquad, ...sendArgs } = params;
    const p = parse(tool, tool === 'send' && ctx.kind === 'cli' ? sendArgs : params);
    if (method === 'msg.peek') p.peek = true;
    if (method === 'msg.history') p.history = true;
    if (ctx.sid) {
      const s = this.required(ctx);
      s.last_seen_at = Date.now();
      this.store.saveSession(s);
    }
    if (tool === 'read') {
      this.required(ctx);
      if (!p.history && !p.since && !p.recover && !p.id && !this.inbox(this.required(ctx)).length)
        await this.wait(ctx, p.wait, undefined, signal);
      if (signal?.aborted) fail('REQUEST_CANCELLED');
      if (ctx.closed) fail('DAEMON_UNAVAILABLE');
      return this.envelope(
        ctx,
        this.atomic(() => this.readNow(ctx, p)),
      );
    }
    if (tool === 'ask') {
      if (p.target === 'user')
        return this.envelope(
          ctx,
          this.atomic(() => this.dashboard.question(this.member(ctx, 'commander'), p)),
        );
      if (
        !p.question ||
        p.action !== 'create' ||
        p.id ||
        p.task_id ||
        p.version ||
        p.kind ||
        p.options ||
        p.artifact_ids ||
        p.result ||
        p.status ||
        p.description
      )
        fail(
          'INVALID_ARGUMENT',
          'Executor asks require question; use target=user for dashboard questions',
        );
      const sent = this.atomic(() => this.reportOrAsk(ctx, p, true));
      if (p.wait) await this.wait(ctx, p.wait, sent.id, signal);
      if (signal?.aborted) fail('REQUEST_CANCELLED');
      if (ctx.closed) fail('DAEMON_UNAVAILABLE');
      const answer = p.wait
        ? this.atomic(() => this.readNow(ctx, { limit: 1 }, sent.id)).messages[0]
        : undefined;
      return this.envelope(ctx, { ...sent, answered: !!answer, ...(answer ? { answer } : {}) });
    }
    const result = this.atomic(() => {
      switch (tool) {
        case 'join':
          return this.joinSquad(ctx, p);
        case 'leave':
          return this.leave(ctx, p);
        case 'list':
          return this.list(ctx, p);
        case 'send':
          return this.send(ctx, p, operatorSquad);
        case 'report':
          return this.reportOrAsk(ctx, p, false);
        case 'task':
          return this.dashboard.task(this.member(ctx), p);
        case 'artifact':
          return this.dashboard.artifact(this.member(ctx), p);
      }
    });
    if (tool === 'join' && p.standby && this.configureStandby) {
      return this.envelope(ctx, {
        ...result,
        standby: this.required(ctx).native_id
          ? (this.configureStandby(ctx.sid!, p.standby), this.standbyView(ctx.sid!))
          : {
              wake_mode: 'manual',
              health: 'manual',
              can_auto_respond: false,
              reason:
                'A confirmed native session ID is required for managed standby; membership is retained.',
            },
      });
    }
    return this.envelope(ctx, result);
  }
}
