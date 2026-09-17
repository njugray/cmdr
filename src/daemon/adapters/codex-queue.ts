import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createReadStream, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Standby, WakeRequest } from '../../shared/protocol.js';
import { WakeDeferred } from '../../shared/protocol.js';
import { wakePrompt } from '../../shared/wake.js';
import type { HostAdapter } from './codex.js';

const run = promisify(execFile);
// Compatibility reader for Codex 0.153/0.154 state_5 + JSONL lifecycle records.
// Read-only, incremental, and fail-closed on missing/unrecognized evidence.
// The queue CLI is the delivery API; these files only establish idle/reconciliation.
export class CodexQueueAdapter implements HostAdapter {
  readonly transport = 'queue' as const;
  private abort = new AbortController();
  private probed = false;
  private file = '';
  private ino = 0;
  private offset = 0;
  private incomplete = false;
  private status: 'idle' | 'busy' | 'unknown' = 'unknown';
  private markers = new Set<string>();
  constructor(private options: Pick<Standby, 'executable'>) {}
  private async scan(native: string) {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 12))
      throw new Error(
        'Codex queue compatibility needs Node >=22.12 for read-only SQLite; use Node 24 or the proxy transport',
      );
    const home = process.env.CODEX_HOME || join(homedir(), '.codex');
    const db = new DatabaseSync(join(home, 'state_5.sqlite'), { readOnly: true });
    let path: string;
    try {
      const row = db.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(native);
      if (typeof row?.rollout_path !== 'string')
        throw new Error('Thread missing from Codex state_5.sqlite');
      path = row.rollout_path;
    } finally {
      db.close();
    }
    const stat = statSync(path);
    if (this.file !== path || this.ino !== stat.ino || stat.size < this.offset) {
      this.file = path;
      this.ino = stat.ino;
      this.offset = 0;
      this.incomplete = false;
      this.status = 'unknown';
      this.markers.clear();
    }
    if (stat.size === this.offset) return;
    const input = createReadStream(path, {
      start: this.offset,
      end: stat.size - 1,
      signal: this.abort.signal,
    });
    // Only commit complete newline-terminated records; a concurrent writer can
    // leave a partial final record, which will be retried on the next scan.
    let partial = Buffer.alloc(0);
    for await (const chunk of input) {
      partial = Buffer.concat([partial, Buffer.from(chunk)]);
      let end: number;
      while ((end = partial.indexOf(10)) >= 0) {
        const line = partial.subarray(0, end).toString('utf8');
        partial = partial.subarray(end + 1);
        this.offset += end + 1;
        let record: any;
        try {
          record = JSON.parse(line);
        } catch {
          this.status = 'unknown';
          continue;
        }
        if (record.type === 'event_msg') {
          if (record.payload?.type === 'task_started') this.status = 'busy';
          else if (['task_complete', 'turn_aborted'].includes(record.payload?.type))
            this.status = 'idle';
        }
        // Never treat tool/assistant output that quotes a marker as acceptance.
        const user =
          record.type === 'event_msg' && record.payload?.type === 'user_message'
            ? record.payload.message
            : record.type === 'response_item' && record.payload?.role === 'user'
              ? record.payload.content
                  ?.filter((c: any) => c.type === 'input_text')
                  .map((c: any) => c.text)
                  .join('\n')
              : undefined;
        if (typeof user === 'string') {
          const match = user.match(/^\[cmdr wake ([a-f0-9-]{36})\]/);
          if (match) this.markers.add(match[1]);
        }
      }
      if (partial.length > 16 * 1024 * 1024)
        throw new Error('Unrecognized Codex rollout record size');
    }
    this.incomplete = partial.length > 0;
  }
  async state(native: string) {
    if (!this.probed) {
      const { stdout } = await run(this.options.executable || 'codex', ['queue', '--help'], {
        timeout: 10000,
        maxBuffer: 1024 * 1024,
        signal: this.abort.signal,
      });
      if (!stdout.includes('--thread') || !stdout.includes('--message'))
        throw new Error('Codex CLI does not support queue --thread/--message');
      this.probed = true;
    }
    await this.scan(native);
    if (this.incomplete && this.status !== 'busy')
      throw new Error(
        'Codex rollout has an incomplete record; waiting for the host to finish writing before assuming idle',
      );
    if (this.status === 'unknown')
      throw new Error(
        'Codex queue idle state unavailable: no recognized lifecycle marker in state_5 rollout',
      );
    return this.status;
  }
  async lookup(native: string, request: WakeRequest) {
    await this.scan(native);
    return { found: this.markers.has(request.id) };
  }
  async enqueue(native: string, request: WakeRequest) {
    // Repeat the read immediately before submission. The CLI/host must arbitrate
    // any remaining race with a new user turn; no resume/exec fallback is allowed.
    if ((await this.state(native)) !== 'idle')
      throw new WakeDeferred('Codex became busy before queue submission');
    await run(
      this.options.executable || 'codex',
      ['queue', '--thread', native, '--message', wakePrompt(request.id)],
      { timeout: 30000, maxBuffer: 1024 * 1024, signal: this.abort.signal },
    );
    // CLI exit 0 confirms delivery but exposes no queued-submission identifier.
    return undefined;
  }
  async start() {}
  close() {
    this.abort.abort();
  }
}
