import { armHint, hostStandby } from '../shared/wake.js';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { Core } from './core.js';
import { CodexAdapter, type HostAdapter } from './adapters/codex.js';
import { fail, WakeDeferred, type Standby } from '../shared/protocol.js';

export class StandbyManager {
  private adapters = new Map<string, HostAdapter>();
  private running = false;
  private stopped = false;
  constructor(
    private core: Core,
    private factory: (s: Standby) => HostAdapter = (s) => new CodexAdapter(s),
  ) {
    for (const listener of core.store.standbys())
      if (listener.enabled && listener.wake_mode !== 'manual') {
        listener.health = 'starting';
        listener.lease = undefined;
        listener.host_state = 'unknown';
        core.store.saveStandby(listener);
      }
  }
  get active() {
    return this.core.store.standbys().some((s) => s.enabled && s.wake_mode !== 'manual');
  }
  configure(p: any) {
    const store = this.core.store,
      session = store.session(p.sid) || fail('NOT_JOINED');
    if (!session.native_id || !session.squad_id)
      fail('IDENTITY_REQUIRED', 'Join with the real host session ID first');
    let s = store.standby(session.sid);
    if (p.action === 'status')
      return s
        ? { ...s, ...this.core.standbyView(s.sid) }
        : { sid: p.sid, wake_mode: 'manual', health: 'manual', enabled: false };
    if (!['start', 'stop', 'resume'].includes(p.action)) fail('INVALID_ARGUMENT');
    if (p.executable && (typeof p.executable !== 'string' || !isAbsolute(p.executable)))
      fail('INVALID_ARGUMENT', 'executable must be an absolute path');
    if (p.socket && (typeof p.socket !== 'string' || !isAbsolute(p.socket)))
      fail('INVALID_ARGUMENT', 'socket must be an absolute path');
    if (p.adapter && !['codex', 'claude', 'zcode', 'kimi', 'manual'].includes(p.adapter))
      fail('INVALID_ARGUMENT');
    if (p.transport && !['auto', 'proxy', 'queue'].includes(p.transport)) fail('INVALID_ARGUMENT');
    if (p.resolve && !['retry', 'accepted'].includes(p.resolve)) fail('INVALID_ARGUMENT');
    if (!s)
      s = {
        sid: session.sid,
        enabled: false,
        wake_mode: 'manual',
        health: 'manual',
        host_state: 'unknown',
        checked_at: null,
      };
    if (p.action === 'stop') {
      s.enabled = false;
      s.health = 'stopped';
    } else {
      if (p.adapter && p.adapter !== 'manual' && p.adapter !== session.agent)
        fail('INVALID_ARGUMENT', 'Adapter must match the member host');
      // Repeated join(auto) must preserve a healthy watcher and its lease.
      if (
        s.enabled &&
        s.wake_mode !== 'manual' &&
        p.action === 'start' &&
        !p.adapter &&
        !p.executable &&
        !p.socket &&
        !p.transport &&
        !p.resolve
      )
        return { ...s, arm: armHint(s, this.core.paths.home) };
      s.wake_mode =
        p.adapter ||
        (p.action === 'start'
          ? ['codex', 'claude', 'zcode', 'kimi'].includes(session.agent)
            ? (session.agent as Standby['wake_mode'])
            : 'manual'
          : s.wake_mode);
      s.enabled = true;
      s.health = s.wake_mode === 'manual' ? 'manual' : 'starting';
      s.executable = p.executable || s.executable;
      s.socket = p.socket || s.socket;
      s.codex_transport = p.transport || s.codex_transport;
      if (p.resolve === 'retry') s.request = undefined;
      if (p.resolve === 'accepted' && s.request) s.request.state = 'accepted';
      if (s.request?.state === 'failed') s.request = undefined;
    }
    s.lease = undefined;
    s.generation = (s.generation || 0) + 1;
    this.adapters.get(s.sid)?.close();
    this.adapters.delete(s.sid);
    this.save(
      s,
      'standby.changed',
      p.resolve ? `operator resolved wake as ${p.resolve}` : p.action,
    );
    return { ...s, arm: armHint(s, this.core.paths.home) };
  }
  private save(s: Standby, kind?: string, reason?: string) {
    if (this.stopped || !this.core.store.session(s.sid)) return;
    const cursor = this.core.store.eventCursor();
    this.core.store.transaction(() => {
      this.core.store.saveStandby(s);
      if (kind)
        this.core.record(kind, this.core.store.session(s.sid)!.squad_id, {
          to_sid: s.sid,
          reason,
          data: {
            wake_id: s.request?.id,
            message_ids: s.request?.message_ids,
            state: s.request?.state,
            health: s.health,
            host_state: s.host_state,
          },
        });
    });
    this.core.publishEvents(cursor);
  }
  watch(sid: string, token: string, action: 'attach' | 'pulse' | 'detach') {
    const s = this.core.store.standby(sid);
    const session = this.core.store.session(sid);
    if (!s?.enabled || !session?.squad_id || !hostStandby(s.wake_mode))
      fail(
        'WATCHER_DISABLED',
        'Join with standby=auto on Claude/ZCode/Kimi before arming a watcher',
      );
    if (action === 'detach') {
      if (s.lease?.token === token) {
        s.lease = undefined;
        s.health = 'starting';
        this.save(s, 'standby.disarmed');
      }
      return {};
    }
    if (s.lease && s.lease.token !== token && s.lease.expires_at > Date.now())
      fail(
        'WATCHER_ACTIVE',
        'A watcher already owns this member; inspect the host task before replacing it',
      );
    if (action === 'pulse' && s.lease?.token !== token)
      fail('WATCHER_EXPIRED', 'Watcher lease lost; re-arm from the host');
    const changed = s.health !== 'healthy' || s.lease?.token !== token;
    s.lease = { token, expires_at: Date.now() + 90000 };
    s.health = 'healthy';
    s.checked_at = Date.now();
    s.error = undefined;
    this.save(s, changed ? 'standby.armed' : undefined);
    // Observers only see metadata and never consume or acknowledge work.
    return {
      wake_mode: s.wake_mode,
      messages: this.core.actionable(sid).map((m) => ({
        id: m.id,
        type: m.type,
        from_sid: m.from_sid,
        reply_to: m.reply_to,
        status: m.data?.status,
        work_state: m.work?.state,
        updated_at: m.work?.updated_at,
        cancel_requested_at: m.work?.cancel_requested_at,
      })),
    };
  }
  async tick() {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      for (const [sid, adapter] of this.adapters) {
        const current = this.core.store.standby(sid);
        if (!current?.enabled || current.wake_mode === 'manual') {
          adapter.close();
          this.adapters.delete(sid);
        }
      }
      for (const s of this.core.store.standbys()) {
        if (
          s.enabled &&
          hostStandby(s.wake_mode) &&
          s.health === 'healthy' &&
          (s.lease?.expires_at || 0) <= Date.now()
        ) {
          s.health = 'stalled';
          s.error = 'Host watcher expired; re-arm it from the host session.';
          this.save(s, 'standby.health', s.error);
        }
      }
      const records = this.core.store
        .standbys()
        .filter((s) => s.enabled && s.wake_mode === 'codex');
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, records.length) }, async () => {
          while (!this.stopped && next < records.length) await this.check(records[next++]);
        }),
      );
    } finally {
      this.running = false;
    }
  }
  private async check(s: Standby) {
    const store = this.core.store,
      session = store.session(s.sid);
    if (!session?.native_id || !session.squad_id) return;
    let adapter = this.adapters.get(s.sid);
    if (!adapter) {
      adapter = this.factory(s);
      this.adapters.set(s.sid, adapter);
    }
    // A stop/rebind while a host request is in flight must not revive the listener.
    const valid = () =>
      !this.stopped &&
      store.session(s.sid)?.native_id === session.native_id &&
      store.standby(s.sid)?.enabled === true &&
      store.standby(s.sid)?.generation === s.generation;
    try {
      const host = await adapter.state(session.native_id);
      if (!valid()) return;
      s.host_state = host;
      s.transport = adapter.transport;
      s.checked_at = Date.now();
      s.error =
        host === 'unknown'
          ? 'Host session is not loaded or its runtime state is unavailable; resume it in the host.'
          : undefined;
      const work = this.core.actionable(s.sid);
      const fingerprint = createHash('sha256')
        .update(
          JSON.stringify(
            work.map((m) => [m.id, m.work?.state, m.work?.updated_at, m.work?.cancel_requested_at]),
          ),
        )
        .digest('hex');
      if (s.request && s.request.state !== 'observed') {
        if (s.request.state === 'accepted' && host === 'busy') {
          s.health = 'healthy';
          this.save(s);
          return;
        }
        const found = await adapter.lookup(session.native_id, s.request);
        if (!valid()) return;
        if (found.submission) {
          // An accepted queued wake still owns the slot even if hooks already handled
          // its original messages. Reuse it for backlog rather than queueing a rival.
          s.request.state = 'accepted';
          s.request.submission_id = found.submission;
          s.request.message_ids = [
            ...new Set([...s.request.message_ids, ...work.map((m) => m.id)]),
          ];
          s.health = host === 'unknown' ? 'error' : 'healthy';
          this.save(
            s,
            recordChanged(store.standby(s.sid), s) ? 'wake.accepted' : undefined,
            s.error,
          );
          if (host === 'idle') await adapter.start(session.native_id, found.submission);
          return;
        }
        if (found.found || s.request.state === 'accepted') {
          const unresolved = s.request.message_ids.some((id) => work.some((m) => m.id === id));
          s.request.state = 'accepted';
          s.request.submission_id = undefined;
          if (
            !unresolved ||
            (found.found && host === 'idle' && fingerprint !== s.request.fingerprint)
          ) {
            s.request.state = 'observed';
            s.health = host === 'unknown' ? 'error' : 'healthy';
            this.save(s, 'wake.observed');
          } else {
            s.health =
              host === 'idle' && Date.now() - s.request.created_at > 60000
                ? 'stalled'
                : host === 'unknown'
                  ? 'error'
                  : 'healthy';
            this.save(s, recordChanged(store.standby(s.sid), s) ? 'standby.health' : undefined);
            return;
          }
        } else {
          s.request.state = 'uncertain';
          s.health = 'uncertain';
          s.error =
            'Wake not found in host queue/history. Inspect host and use standby resume --resolve retry|accepted; no automatic replay.';
          this.save(
            s,
            recordChanged(store.standby(s.sid), s) ? 'wake.uncertain' : undefined,
            s.error,
          );
          return;
        }
      }
      s.health = host === 'unknown' ? 'error' : 'healthy';
      this.save(s, recordChanged(store.standby(s.sid), s) ? 'standby.health' : undefined, s.error);
      if (!work.length || host !== 'idle') return;
      s.request = {
        id: randomUUID(),
        transport: adapter.transport,
        fingerprint,
        message_ids: work.map((m) => m.id),
        created_at: Date.now(),
        state: 'requested',
      };
      this.save(s, 'wake.requested');
      // Write-ahead request remains unresolved across a crash; it is never a seen marker.
      const submission = await adapter.enqueue(session.native_id, s.request);
      if (!valid()) return;
      s.request.state = 'accepted';
      s.request.submission_id = submission;
      this.save(s, 'wake.accepted');
      await adapter.start(session.native_id, submission);
    } catch (e) {
      if (!valid()) return;
      if (e instanceof WakeDeferred) {
        s.request = undefined;
        s.host_state = 'busy';
        s.health = 'healthy';
        s.error = undefined;
        this.save(s, 'wake.deferred', e.message);
        return;
      }
      s.checked_at = Date.now();
      s.error = String(e).slice(0, 500);
      if (s.request && s.request.state !== 'observed') {
        s.request.state = 'uncertain';
        s.health = 'uncertain';
        s.request.error = s.error;
      } else s.health = 'error';
      const previous = store.standby(s.sid);
      this.save(
        s,
        recordChanged(previous, s) || previous?.error !== s.error ? 'wake.failed' : undefined,
        s.error,
      );
    }
  }
  close() {
    this.stopped = true;
    for (const a of this.adapters.values()) a.close();
    this.adapters.clear();
  }
}
function recordChanged(a: Standby | undefined, b: Standby) {
  return (
    a?.health !== b.health ||
    a?.host_state !== b.host_state ||
    a?.request?.state !== b.request?.state
  );
}
