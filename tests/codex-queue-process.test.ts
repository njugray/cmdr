import { afterEach, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { quickCall } from '../src/shared/client.js';
const run = promisify(execFile),
  cli = resolve('plugins/cmdr/bin/cmdr');
let home = '';
const env = () => ({
  ...process.env,
  CMDR_HOME: home,
  CODEX_HOME: join(home, 'codex'),
  CMDR_AGENT: '',
  CMDR_SESSION_ID: '',
});
const command = async (args: string[]) => JSON.parse((await run(cli, args, { env: env() })).stdout);
const member = (native: string, action: string, input = {}) =>
  command([
    'session',
    action,
    '--agent',
    'codex',
    '--native-id',
    native,
    '--input',
    JSON.stringify(input),
  ]);
afterEach(async () => {
  if (home) {
    try {
      await quickCall('admin.shutdown', { reason: 'test' }, { home });
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
    rmSync(home, { recursive: true, force: true });
  }
});
it('queue fallback coalesces while busy and reconciles a lost response across daemon restart', async () => {
  home = mkdtempSync(join(tmpdir(), 'cmdr-queue-process-'));
  mkdirSync(join(home, 'codex'));
  const rollout = join(home, 'rollout.jsonl'),
    sent = join(home, 'sent.jsonl'),
    executable = join(home, 'codex-cli');
  const db = new DatabaseSync(join(home, 'codex/state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)');
  db.prepare('INSERT INTO threads VALUES (?, ?)').run('e', rollout);
  db.close();
  const event = (type: string) =>
    appendFileSync(rollout, JSON.stringify({ type: 'event_msg', payload: { type } }) + '\n');
  event('task_started');
  writeFileSync(
    executable,
    `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const a = process.argv.slice(2);
if (a[0] === 'app-server') { console.error('missing socket'); process.exit(1); }
if (a[1] === '--help') { console.log('--thread --message'); process.exit(0); }
appendFileSync(${JSON.stringify(sent)}, JSON.stringify(a) + '\\n');
appendFileSync(${JSON.stringify(rollout)}, JSON.stringify({type:'event_msg',payload:{type:'user_message',message:a[4]}}) + '\\n' + JSON.stringify({type:'event_msg',payload:{type:'task_started'}}) + '\\n');
console.error('lost response after delivery'); process.exit(1);
`,
    { mode: 0o700 },
  );
  await member('c', 'join', { squad_name: 'queue', role: 'commander' });
  await member('e', 'join', { squad_name: 'queue' });
  const id = (await member('c', 'send', { to: 'codex:e', message: 'recover once' })).ids[0];
  await command(['standby', 'start', '--session', 'codex:e', '--executable', executable]);
  const listener = () => command(['standby', 'status', '--session', 'codex:e']);
  await expect.poll(async () => (await listener()).host_state, { timeout: 5000 }).toBe('busy');
  expect(existsSync(sent)).toBe(false);
  event('task_complete');
  await expect.poll(() => existsSync(sent), { timeout: 5000 }).toBe(true);
  await run(cli, ['daemon', 'restart'], { env: env() });
  await expect
    .poll(async () => (await listener()).request?.state, { timeout: 5000 })
    .toBe('accepted');
  expect((await listener()).transport).toBe('queue');
  expect(readFileSync(sent, 'utf8').trim().split('\n')).toHaveLength(1);
  expect((await member('e', 'read', { peek: true })).messages[0].id).toBe(id);
  await member('e', 'read');
  await member('e', 'report', { status: 'working', reply_to: id, message: 'accepted' });
  await member('e', 'report', { status: 'done', reply_to: id, message: 'finished' });
  event('task_complete');
  await expect
    .poll(async () => (await listener()).request?.state, { timeout: 5000 })
    .toBe('observed');
  expect(readFileSync(sent, 'utf8').trim().split('\n')).toHaveLength(1);
}, 20000);
