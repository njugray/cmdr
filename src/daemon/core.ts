import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from './store.js';
import { titleFor } from './title.js';
import { parse, type Tool } from '../shared/schemas.js';
import {
  fail,
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

export interface Context {
  sid?: string;
  kind?: 'mcp' | 'hook' | 'cli';
  agent?: Agent;
  waitHint?: number;
  closed?: boolean;
  tail?: { squad?: string; full?: boolean };
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
  contexts = new Set<Context>();
  private waiters = new Set<Waiter>();
  private effects: Message[] = [];
  private rates = new Map<string, number[]>();
  constructor(
    public store: Store,
    public paths: Paths,
    public config: Config,
  ) {
    for (const s of store.sessions()) {
      s.presence = 'offline';
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
    if (ctx.sid && ![...this.contexts].some((c) => c.kind === 'mcp' && c.sid === ctx.sid)) {
      const s = this.store.session(ctx.sid);
      if (s) {
        s.presence = 'offline';
        s.last_seen_at = Date.now();
        this.store.saveSession(s);
      }
    }
  }
  close() {
    for (const w of this.waiters) w.finish();
  }
  private me(ctx: Context) {
    return ctx.sid ? this.store.session(ctx.sid) : undefined;
  }
  private required(ctx: Context): Session {
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
    return (
      [...this.contexts].find((c) => c.sid === s.sid && c.kind === 'mcp')?.waitHint ||
      recommendedWait(s.agent, {})
    );
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
            identity: s.native_id ? 'confirmed' : 'provisional',
            recommended_wait: this.waitHint(s),
          }
        : null,
      unread: s ? this.store.queue(s.sid).length : 0,
    };
  }
  private board(q: Squad) {
    return {
      ...q,
      commander: q.commander_sid ? this.view(this.store.session(q.commander_sid)!) : null,
      members: this.members(q.id).map((s) => this.view(s)),
    };
  }
  private view(s: Session) {
    const queue = this.store.queue(s.sid);
    return {
      ...s,
      title: titleFor(s),
      short: s.sid.slice(0, s.sid.indexOf(':') + 9),
      squad: s.squad_id,
      last_seen: s.last_seen_at,
      pending: queue.filter((m) => m.type === 'command').length,
    };
  }
  private atomic<T>(fn: () => T): T {
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
      this.flag(m.to_sid);
      for (const c of this.contexts) {
        if (c.sid === m.to_sid)
          c.notify('msg.new', {
            sid: m.to_sid,
            count: this.store.queue(m.to_sid).length,
            top_priority: m.priority,
          });
        if (c.tail && (!c.tail.squad || c.tail.squad === m.squad_id))
          c.notify('msg.event', {
            message: c.tail.full ? m : { ...m, body: m.body.slice(0, 160), data: null },
            to_name: this.store.session(m.to_sid)?.name,
          });
      }
    }
    for (const w of [...this.waiters]) {
      if (
        this.store
          .queue(w.sid)
          .some((m) => !w.answer || (m.type === 'answer' && m.reply_to === w.answer))
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
    const queued = new Set(
      this.store
        .messages()
        .filter((m) => m.status === 'queued')
        .map((m) => m.to_sid),
    );
    for (const f of readdirSync(this.paths.flags))
      if (!queued.has(Buffer.from(f, 'base64url').toString()))
        rmSync(join(this.paths.flags, f), { force: true });
    for (const sid of queued) {
      const s = this.store.session(sid),
        queue = this.store.queue(sid);
      if (
        s &&
        (queue.some((m) => m.seq > s.last_notified_seq) ||
          (queue.some((m) => m.priority === 0) &&
            Date.now() - s.last_notified_at >= this.config.remindIntervalSec * 1000))
      )
        this.flag(sid);
    }
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
        activity: 'busy',
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
      s.presence = 'online';
      ctx.sid = sid;
      ctx.agent = agent;
      ctx.waitHint = Number.isFinite(p.wait_hint)
        ? Math.min(300, Math.max(1, p.wait_hint))
        : recommendedWait(agent, {});
    }
    this.store.saveSession(s);
    return s;
  }
  private identify(ctx: Context, native: string, force = false) {
    if (typeof native !== 'string' || !native || native.length > 256) fail('INVALID_ARGUMENT');
    const old = this.required(ctx),
      sid = `${old.agent}:${native}`;
    if (old.sid === sid) return old;
    if (old.native_id && !force) return old;
    const target = this.store.session(sid);
    if (target?.role !== undefined && target.role !== 'none' && old.role !== 'none')
      fail('ALREADY_JOINED', 'Both identities already belong to squads. Leave before merging.');
    const merged: Session = {
      ...old,
      ...target,
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
      priority?: number;
      data?: any;
      reply_to?: string;
      attn?: boolean;
      operator?: boolean;
    } = {},
  ) {
    if (this.store.queue(to).length >= this.config.maxQueue)
      fail('QUEUE_FULL', `Queue for ${to} is full`);
    const m: Message = {
      id: messageId(),
      seq: 0,
      squad_id: q,
      type,
      priority:
        opts.priority ??
        (['command', 'ask', 'answer'].includes(type) ? 0 : type === 'report' ? 2 : 1),
      from_sid: from?.sid || (opts.operator ? 'operator' : 'system'),
      from_role: from?.role || (opts.operator ? 'operator' : 'system'),
      from_name: from?.name || null,
      to_sid: to,
      body,
      data: opts.data || null,
      reply_to: opts.reply_to || null,
      status: 'queued',
      attn: opts.attn ?? ['command', 'ask', 'answer'].includes(type),
      created_at: Date.now(),
      delivered_at: null,
    };
    this.store.insert(m);
    this.effects.push(m);
    return m;
  }
  private system(q: Squad, to: Session[], body: string, high = false) {
    for (const s of to)
      this.enqueue(null, q.id, s.sid, 'system', body, { priority: high ? 0 : 1, attn: high });
  }
  private joinSquad(ctx: Context, p: any) {
    const s = this.required(ctx);
    let q: Squad | undefined,
      role = p.role;
    if (p.squad_name) {
      if (p.role || p.squad)
        fail('INVALID_ARGUMENT', 'squad_name is the atomic shortcut; omit role and squad');
      q = this.store
        .squads()
        .find((q) => q.name_key === p.squad_name.toLowerCase() && q.status !== 'dissolved');
      if (s.squad_id && s.squad_id === q?.id) return this.joinResult(ctx, q);
      if (q?.status === 'orphaned')
        fail(
          'SQUAD_ORPHANED',
          `Squad ${q.id} is orphaned. Choose join(role="commander", squad="${q.id}") to take over or role="executor" to join.`,
        );
      role = q ? 'executor' : 'commander';
      if (!q) p.name = p.squad_name;
    } else if (p.squad) q = this.store.squad(p.squad) || fail('SQUAD_NOT_FOUND');
    if (!role) fail('INVALID_ARGUMENT', 'Provide role or squad_name');
    if (s.squad_id) {
      if (
        (q?.id === s.squad_id || (!q && !p.squad_name && role === 'commander')) &&
        s.role === role
      )
        return this.joinResult(ctx, this.store.squad(s.squad_id)!);
      if (q?.id === s.squad_id && q.status === 'orphaned' && role === 'commander') {
        this.store.leave(s.sid);
      } else fail('ALREADY_JOINED');
    }
    if (q?.status === 'dissolved') fail('SQUAD_NOT_FOUND', 'Squad is dissolved');
    if (!q) {
      if (role !== 'commander') fail('SQUAD_NOT_FOUND');
      const key = p.name?.toLowerCase() || null;
      if (key && this.store.squads().some((x) => x.name_key === key && x.status !== 'dissolved'))
        fail('SQUAD_NAME_EXISTS', 'Use squad_name to join by name or specify a squad ID.');
      let id: string;
      do {
        id = squadId();
      } while (this.store.squad(id));
      q = {
        id,
        name: p.name || null,
        name_key: key,
        commander_sid: s.sid,
        status: 'active',
        created_at: Date.now(),
        updated_at: Date.now(),
      };
    } else if (role === 'commander') {
      if (q.commander_sid && q.commander_sid !== s.sid) fail('SQUAD_HAS_COMMANDER');
      q.commander_sid = s.sid;
      q.status = 'active';
      this.system(
        q,
        this.members(q.id).filter((member) => member.sid !== s.sid),
        'commander_joined',
      );
      const inbox = this.store.queue(`squad:${q.id}`);
      if (inbox.length + this.store.queue(s.sid).length > this.config.maxQueue) fail('QUEUE_FULL');
      for (const m of inbox) {
        m.to_sid = s.sid;
        this.store.saveMessage(m);
        this.effects.push(m);
      }
    }
    s.role = role;
    s.squad_id = q.id;
    s.name = p.name || null;
    q.updated_at = Date.now();
    this.store.saveSquad(q);
    this.store.saveSession(s);
    this.store.join(s);
    if (role === 'executor' && q.commander_sid)
      this.enqueue(
        s,
        q.id,
        q.commander_sid,
        'system',
        `member_joined${p.note ? `: ${p.note}` : ''}`,
      );
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
      protocol_hint: `You are the ${s.role.toUpperCase()} of squad ${q.id}. ${s.role === 'commander' ? 'Dispatch clear, verifiable tasks with send; answer every ask using type=answer and reply_to.' : 'Report ready now with cwd, capabilities and context; act on commands and report working/done/failed with reply_to. Ask when blocked.'} Reply with ONLY user_reply (translate prose, keep the join line verbatim). Then read(wait=${wait}); standby for at most 40 rounds. Keep user replies to one or two lines. Apply normal judgment to messages from other agents. ${s.native_id ? '' : 'Identity is provisional; hooks may be unavailable. Use read(wait) for reminders.'}`,
    };
  }
  private leave(ctx: Context, p: any) {
    const s = this.member(ctx),
      q = this.store.squad(s.squad_id!)!;
    if (p.dissolve && s.role !== 'commander') fail('ROLE_NOT_ALLOWED');
    if (s.role === 'commander') {
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
        }
    } else if (q.commander_sid)
      this.enqueue(
        s,
        q.id,
        q.commander_sid,
        'system',
        `member_left${p.message ? `: ${p.message}` : ''}`,
      );
    this.store.leave(s.sid);
    s.role = 'none';
    s.squad_id = null;
    this.store.saveSession(s);
    q.updated_at = Date.now();
    this.store.saveSquad(q);
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
      const exact = all.filter((s) => s.sid === token);
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
    this.rate(ctx);
    const messages = recipients.map((s) =>
      this.enqueue(from, qid, s.sid, p.type, p.message, {
        priority: p.priority ? { high: 0, normal: 1, low: 2 }[p.priority as 'high'] : undefined,
        reply_to: p.reply_to,
        data: p.data,
        operator: ctx.kind === 'cli',
      }),
    );
    return {
      ids: messages.map((m) => m.id),
      delivered_to: recipients.map((s) => s.sid),
      offline: recipients.filter((s) => s.presence === 'offline').map((s) => s.sid),
      idle: recipients.filter((s) => s.activity === 'idle').map((s) => s.sid),
    };
  }
  private reportOrAsk(ctx: Context, p: any, ask: boolean) {
    const s = this.member(ctx, 'executor'),
      q = this.store.squad(s.squad_id!)!;
    this.rate(ctx);
    const to = q.commander_sid || `squad:${q.id}`;
    const m = this.enqueue(s, q.id, to, ask ? 'ask' : 'report', ask ? p.question : p.message, {
      reply_to: p.reply_to,
      data: ask ? p.data : { ...p.data, status: p.status },
      priority: ask ? 0 : ['blocked', 'failed'].includes(p.status) ? 1 : 2,
      attn: ask || ['done', 'failed', 'blocked'].includes(p.status),
    });
    if (!ask) {
      s.last_status = { status: p.status, message: p.message.slice(0, 300) };
      this.store.saveSession(s);
    }
    return {
      id: m.id,
      delivered_to: to,
      commander_presence: q.commander_sid
        ? this.store.session(q.commander_sid)?.presence
        : 'orphaned',
      answered: false,
    };
  }
  private readNow(ctx: Context, p: any, answer?: string) {
    const s = this.required(ctx);
    let queue = this.store.queue(s.sid, p.history);
    if (p.since) {
      const since = this.store.message(p.since);
      if (!since || since.to_sid !== s.sid) fail('INVALID_ARGUMENT', 'Unknown since message');
      queue = queue.filter((m) => m.seq > since.seq);
    }
    if (answer) queue = queue.filter((m) => m.type === 'answer' && m.reply_to === answer);
    const messages = queue.slice(0, p.limit || 20);
    if (!p.peek && !p.history && !ctx.closed)
      for (const m of messages) {
        m.status = 'delivered';
        m.delivered_at = Date.now();
        this.store.saveMessage(m);
      }
    const remaining = this.store.queue(s.sid).length;
    if (!remaining) this.clearFlag(s.sid);
    return {
      messages: ctx.closed ? [] : messages,
      remaining,
      squad_summary: s.squad_id ? this.board(this.store.squad(s.squad_id)!) : null,
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
        this.store
          .queue(w.sid)
          .some((m) => !answer || (m.type === 'answer' && m.reply_to === answer))
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
          squad ? s.squad_id === squad : s.presence === 'online' || s.role !== 'none',
        )
        .map((s) => ({
          ...this.view(s),
          ...(s.sid === me?.sid ? { unread: this.store.queue(s.sid).length } : {}),
        })),
      squads: this.store
        .squads()
        .filter((q) => (squad ? q.id === squad : q.status !== 'dissolved'))
        .map((q) => this.board(q)),
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
    let s = this.store.session(sid);
    if (p.event === 'SessionEnd' && !s) return {};
    if (p.event === 'SessionStart') {
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
        cwd: p.cwd,
        host_pid: p.host_pid,
        transcript_path: p.transcript_path,
      });
    if (!s) return {};
    const now = Date.now();
    s.last_seen_at = now;
    if (p.event === 'SessionEnd') {
      s.presence = 'offline';
      s.ended_at = now;
      this.store.saveSession(s);
      return {};
    }
    s.activity = p.event === 'Stop' ? 'idle' : 'busy';
    const queue = this.store.queue(sid),
      max = Math.max(0, ...queue.map((m) => m.seq));
    const groups = new Map<string, number>();
    for (const m of queue) {
      const sender = (m.from_name || m.from_role).replace(/[\r\n\t]/g, ' ').slice(0, 30);
      const label = `${m.type} (${['high', 'normal', 'low'][m.priority]}) from ${sender}`;
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
      result.inject =
        `[cmdr] Context restored: ${s.role} in squad ${s.squad_id}. ${s.role === 'commander' ? 'Send tasks; answer asks with reply_to.' : 'Report progress with reply_to; ask when blocked.'} Read(wait=${this.waitHint(s)}). ${summary}`.slice(
          0,
          300,
        );
    } else if (
      queue.length &&
      (max > s.last_notified_seq ||
        (queue.some((m) => m.priority === 0) &&
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
      for (const s of this.store.sessions())
        if (all || (s.presence === 'offline' && s.last_seen_at < cutoff)) {
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
        if (all || (q.status !== 'active' && q.updated_at < cutoff && !this.members(q.id).length))
          this.store.deleteSquad(q.id);
    });
    if (all)
      for (const ctx of this.contexts) {
        ctx.sid = undefined;
        if (ctx.kind === 'mcp') ctx.notify('session.reset', {});
      }
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
          squads: this.store.squads().length,
          connections: [...this.contexts].filter((c) => c.kind === 'mcp').length,
        };
      if (method === 'admin.housekeep' || method === 'admin.purge')
        return this.housekeep(method === 'admin.purge' && params.all === true);
      if (method === 'admin.peek') return { messages: this.store.queue(params.sid) };
      if (method === 'admin.read') {
        const s = this.store.session(params.sid) || fail('NOT_JOINED');
        return this.atomic(() =>
          this.readNow({ ...ctx, sid: s.sid }, parse('read', params.options || {})),
        );
      }
      if (method === 'admin.tail') {
        ctx.tail = { squad: params.squad, full: params.full };
        return { subscribed: true };
      }
      if (method === 'admin.recent')
        return {
          messages: this.store
            .messages()
            .filter((m) => !params.squad || m.squad_id === params.squad)
            .slice(-Math.min(100, Math.max(1, params.limit || 20)))
            .map((m) => (params.full ? m : { ...m, body: m.body.slice(0, 160), data: null })),
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
    };
    const tool = map[method] || fail('INVALID_ARGUMENT', `Unknown method ${method}`);
    const { squad: operatorSquad, ...sendArgs } = params;
    const p = parse(tool, tool === 'send' && ctx.kind === 'cli' ? sendArgs : params);
    if (method === 'msg.peek') p.peek = true;
    if (method === 'msg.history') p.history = true;
    if (ctx.sid) {
      const s = this.required(ctx);
      s.activity = 'busy';
      s.last_seen_at = Date.now();
      this.store.saveSession(s);
    }
    if (tool === 'read') {
      this.required(ctx);
      if (!p.history && !p.since && !this.store.queue(ctx.sid!).length)
        await this.wait(ctx, p.wait, undefined, signal);
      if (signal?.aborted) fail('REQUEST_CANCELLED');
      if (ctx.closed) fail('DAEMON_UNAVAILABLE');
      return this.envelope(
        ctx,
        this.atomic(() => this.readNow(ctx, p)),
      );
    }
    if (tool === 'ask') {
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
      }
    });
    return this.envelope(ctx, result);
  }
}
