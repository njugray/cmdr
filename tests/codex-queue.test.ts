import { afterEach, expect, it, vi } from 'vitest';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { CodexAdapter } from '../src/daemon/adapters/codex.js';
import { CodexQueueAdapter } from '../src/daemon/adapters/codex-queue.js';
import type { Standby, WakeRequest } from '../src/shared/protocol.js';
let dir = '';
let adapter: CodexAdapter | CodexQueueAdapter;
afterEach(() => {
  adapter?.close();
  vi.unstubAllEnvs();
  if (dir) rmSync(dir, { recursive: true, force: true });
});
function setup() {
  dir = mkdtempSync(join(tmpdir(), 'cmdr-codex-queue-'));
  vi.stubEnv('CODEX_HOME', dir);
  const rollout = join(dir, 'rollout.jsonl');
  const db = new DatabaseSync(join(dir, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)');
  db.prepare('INSERT INTO threads VALUES (?, ?)').run('existing', rollout);
  db.close();
  writeFileSync(rollout, '');
  const executable = join(dir, 'codex');
  writeFileSync(
    executable,
    `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'app-server') { console.error('socket missing'); process.exit(1); }
if (args[1] === '--help') { console.log('--thread --message'); process.exit(0); }
appendFileSync(${JSON.stringify(join(dir, 'sent'))}, JSON.stringify(args) + '\\n');
`,
    { mode: 0o700 },
  );
  const options: Standby = {
    sid: 'codex:existing',
    enabled: true,
    wake_mode: 'codex',
    health: 'starting',
    host_state: 'unknown',
    checked_at: null,
    executable,
  };
  const event = (type: string) =>
    appendFileSync(rollout, JSON.stringify({ type: 'event_msg', payload: { type } }) + '\n');
  const request: WakeRequest = {
    id: randomUUID(),
    fingerprint: 'fp',
    message_ids: ['m'],
    created_at: Date.now(),
    state: 'requested',
    transport: 'queue',
  };
  return { options, rollout, event, request };
}
it('falls back from a missing proxy to queue, using only real thread ID and metadata', async () => {
  const { options, event, request } = setup();
  event('task_complete');
  adapter = new CodexAdapter(options);
  expect(await adapter.state('existing')).toBe('idle');
  expect(adapter.transport).toBe('queue');
  expect(await adapter.enqueue('existing', request)).toBeUndefined();
  await adapter.start('existing');
  const args = JSON.parse(readFileSync(join(dir, 'sent'), 'utf8'));
  expect(args.slice(0, 4)).toEqual(['queue', '--thread', 'existing', '--message']);
  expect(args).toHaveLength(5);
  expect(args[4]).toContain(request.id);
});
it('reads the entire lifecycle, respects busy/partial records and reconciles only actual user markers', async () => {
  const { options, rollout, event, request } = setup();
  event('task_complete');
  appendFileSync(rollout, JSON.stringify({ type: 'noise', text: 'a'.repeat(100000) }) + '\n');
  adapter = new CodexQueueAdapter(options);
  expect(await adapter.state('existing')).toBe('idle');
  event('task_started');
  expect(await adapter.state('existing')).toBe('busy');
  await expect(adapter.enqueue('existing', request)).rejects.toThrow('became busy');
  appendFileSync(rollout, '{"type":"event_msg","payload":{"type":"task_complete"}}');
  expect(await adapter.state('existing')).toBe('busy');
  appendFileSync(rollout, '\n');
  expect(await adapter.state('existing')).toBe('idle');
  appendFileSync(rollout, '{"type":"event_msg","payload":{"type":"task_started"}}');
  await expect(adapter.state('existing')).rejects.toThrow('incomplete record');
  appendFileSync(rollout, '\n');
  expect(await adapter.state('existing')).toBe('busy');
  appendFileSync(
    rollout,
    JSON.stringify({
      type: 'response_item',
      payload: {
        role: 'assistant',
        content: [{ type: 'output_text', text: `[cmdr wake ${request.id}]` }],
      },
    }) + '\n',
  );
  expect(await adapter.lookup('existing', request)).toEqual({ found: false });
  appendFileSync(
    rollout,
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'user_message', message: `[cmdr wake ${request.id}] read` },
    }) + '\n',
  );
  expect(await adapter.lookup('existing', request)).toEqual({ found: true });
});
it('does not fall back across an unresolved proxy request and does not guess missing idle state', async () => {
  const { options, event, request } = setup();
  event('task_complete');
  options.request = { ...request, transport: 'proxy' };
  adapter = new CodexAdapter(options);
  await expect(adapter.state('existing')).rejects.toThrow('socket missing');
  adapter.close();
  adapter = new CodexQueueAdapter(options);
  await expect(adapter.state('missing')).rejects.toThrow('Thread missing');
});
