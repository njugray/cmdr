import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { recommendedWait, detectAgent, cmdrTool } from '../src/shared/env.js';
import { sessionCwd } from '../src/mcp/cwd.js';
import { paths } from '../src/shared/paths.js';
import { titleFor } from '../src/daemon/title.js';
import { acquireLock, releaseLock } from '../src/daemon/lock.js';
import { config } from '../src/shared/config.js';
import { squadId } from '../src/shared/ids.js';
let dir: string;
const previous = process.env.CODEX_HOME;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (previous === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previous;
});
it('detects hosts without treating generic clients as Codex', () => {
  expect(detectAgent({})).toBe('generic');
  expect(detectAgent({ CMDR_AGENT: 'custom-agent' })).toBe('custom-agent');
  expect(detectAgent({ ZCODE_PLUGIN_ROOT: '/plugin', CLAUDE_CODE_SESSION_ID: 'z' })).toBe('zcode');
  expect(detectAgent({ CLAUDE_CODE_SESSION_ID: 'c' })).toBe('claude');
  expect(detectAgent({ CODEX_HOME: '/codex' })).toBe('codex');
  for (const name of [
    'mcp__cmdr__join',
    'mcp__plugin_cmdr_cmdr__read',
    'mcp__plugin:cmdr:cmdr__list',
    'plugin:cmdr:cmdr:ask',
  ])
    expect(cmdrTool.test(name)).toBe(true);
  for (const name of ['other__join', 'xcmdr__join', 'cmdr__destroy', 'Bash'])
    expect(cmdrTool.test(name)).toBe(false);
});
it('negotiates wait budgets conservatively', () => {
  expect(recommendedWait('claude', {})).toBe(300);
  expect(recommendedWait('codex', {})).toBe(45);
  expect(recommendedWait('zcode', { CMDR_TOOL_TIMEOUT_SEC: '600' })).toBe(300);
  expect(recommendedWait('custom', { CMDR_TOOL_TIMEOUT_SEC: '120' })).toBe(105);
  expect(recommendedWait('generic', { CMDR_TOOL_TIMEOUT_SEC: 'NaN' })).toBe(45);
});
it('rejects plugin cwd including symlinks but retains sibling project directories', () => {
  dir = mkdtempSync(join(tmpdir(), 'cmdr-cwd-'));
  mkdirSync(join(dir, 'plugin'));
  mkdirSync(join(dir, 'plugin-two'));
  symlinkSync(join(dir, 'plugin'), join(dir, 'link'));
  expect(sessionCwd('/', join(dir, 'plugin'))).toBeNull();
  expect(sessionCwd(join(dir, 'link'), join(dir, 'plugin'))).toBeNull();
  expect(sessionCwd(join(dir, 'plugin-two'), join(dir, 'plugin'))).toBe(join(dir, 'plugin-two'));
});
it('derives Codex titles using user name, sidebar, then first message', () => {
  dir = mkdtempSync(join(tmpdir(), 'cmdr-title-'));
  process.env.CODEX_HOME = dir;
  const db = new DatabaseSync(join(dir, 'state_12.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT,name TEXT,title TEXT,first_user_message TEXT)');
  db.prepare('INSERT INTO threads VALUES (?,?,?,?)').run('one', 'Named', 'First prompt', 'First');
  db.prepare('INSERT INTO threads VALUES (?,?,?,?)').run('two', null, 'First prompt', 'First');
  db.close();
  writeFileSync(
    join(dir, 'session_index.jsonl'),
    JSON.stringify({ id: 'two', thread_name: 'Sidebar title' }) + '\n',
  );
  expect(titleFor({ agent: 'codex', native_id: 'one', sid: 'codex:one' } as any)).toBe('Named');
  expect(titleFor({ agent: 'codex', native_id: 'two', sid: 'codex:two' } as any)).toBe(
    'Sidebar title',
  );
});
it('derives Claude title from transcript and generic title from explicit metadata', () => {
  dir = mkdtempSync(join(tmpdir(), 'cmdr-claude-title-'));
  const transcript = join(dir, 'transcript.jsonl');
  writeFileSync(
    transcript,
    JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'text', text: 'Build a feature' }] },
    }) + '\n',
  );
  expect(
    titleFor({ agent: 'claude', sid: 'claude:title', transcript_path: transcript } as any),
  ).toBe('Build a feature');
  expect(
    titleFor({ agent: 'other', sid: 'other:title', title: 'My work', cwd: '/test' } as any),
  ).toBe('My work');
});
it('uses a stable short Unix socket path for long CMDR_HOME paths', () => {
  const home = '/tmp/' + 'long'.repeat(50);
  expect(Buffer.byteLength(paths(home).socket)).toBeLessThanOrEqual(100);
  expect(paths(home).socket).toBe(paths(home).socket);
  expect(paths(home + 'b').socket).not.toBe(paths(home).socket);
});
it('keeps an active lock and recovers a stale empty lock', () => {
  dir = mkdtempSync(join(tmpdir(), 'cmdr-lock-'));
  const path = join(dir, 'lock');
  expect(acquireLock(path)).toBe(true);
  expect(acquireLock(path)).toBe(false);
  releaseLock(path);
  writeFileSync(path, '');
  expect(acquireLock(path)).toBe(false);
  utimesSync(path, new Date(0), new Date(0));
  expect(acquireLock(path)).toBe(true);
  releaseLock(path);
});
it('ignores invalid configuration fields and produces unambiguous squad IDs', () => {
  dir = mkdtempSync(join(tmpdir(), 'cmdr-config-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ maxQueue: -1, ttlDays: 'oops', idleExitMinutes: 2 }));
  expect(config(path)).toMatchObject({ maxQueue: 1000, ttlDays: 7, idleExitMinutes: 2 });
  for (let i = 0; i < 100; i++) expect(squadId()).toMatch(/^[23456789abcdefghjkmnpqrstuvwxyz]{6}$/);
});
