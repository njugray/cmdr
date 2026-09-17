import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { Core } from './core.js';
import { CodexAdapter, type HostAdapter } from './adapters/codex.js';
import { fail, type Standby, type Message } from '../shared/protocol.js';

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
      return s || { sid: p.sid, wake_mode: 'manual', health: 'manual', enabled: false };
    if (!['start', 'stop', 'resume'].includes(p.action)) fail('INVALID_ARGUMENT');
    if (p.executable && (typeof p.executable !== 'string' || !isAbsolute(p.executable)))
      fail('INVALID_ARGUMENT', 'executable must be an absolute path');
    if (p.socket && (typeof p.socket !== 'string' || !isAbsolute(p.socket)))
      fail('INVALID_ARGUMENT', 'socket must be an absolute path');
    if (p.adapter && !['codex', 'manual'].includes(p.adapter)) fail('INVALID_ARGUMENT');
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
      if (p.adapter === 'codex' && session.agent !== 'codex')
        fail('INVALID_ARGUMENT', 'Codex adapter requires a Codex member');
      s.wake_mode =
        p.adapter ||
        (p.action === 'start' ? (session.agent === 'codex' ? 'codex' : 'manual') : s.wake_mode);
      s.enabled = true;
      s.health = s.wake_mode === 'manual' ? 'manual' : 'starting';
      s.executable = p.executable || s.executable;
      s.socket = p.socket || s.socket;
      if (p.resolve === 'retry') s.request = undefined;
      if (p.resolve === 'accepted' && s.request) s.request.state = 'accepted';
      if (s.request?.state === 'failed') s.request = undefined;
    }
    s.generation = (s.generation || 0) + 1;
    this.adapters.get(s.sid)?.close();
    this.adapters.delete(s.sid);
    this.save(
      s,
      'standby.changed',
      p.resolve ? `operator resolved wake as ${p.resolve}` : p.action,
    );
    return s;
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
  private actionable(sid: string): Message[] {
    const session = this.core.store.session(sid)!;
    return [
      ...new Map(
        [
          ...this.core.inbox(session).filter((m) => m.attn),
          ...this.core.store
            .commands(sid)
            .filter(
              (m) =>
                !m.blocked_by ||
                ['completed', 'failed', 'cancelled'].includes(
                  this.core.store.message(m.blocked_by)?.work?.state || '',
                ),
            ),
        ].map((m) => [m.id, m]),
      ).values(),
    ];
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
      const records = this.core.store
        .standbys()
        .filter((s) => s.enabled && s.wake_mode !== 'manual');
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
      s.checked_at = Date.now();
      s.error =
        host === 'unknown'
          ? 'Host session is not loaded or its runtime state is unavailable; resume it in the host.'
          : undefined;
      const work = this.actionable(s.sid);
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
