import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { paths } from './paths.js';
const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop', 'SessionEnd'] as const;
type Diagnostic =
  | 'hook-error'
  | 'hook-unavailable'
  | 'identity-conflict'
  | 'upgrade'
  | 'reconnected'
  | `hook-${(typeof events)[number]}`;
export function diagnostic(
  code: Diagnostic,
  detail: Record<string, string | number> = {},
  home?: string,
) {
  // Fixed keys, bounded metadata only. No event payloads, messages, env or credentials.
  const dir = join(paths(home).home, 'logs/diagnostics');
  const file = join(dir, `${code}.json`);
  let temp: string | undefined;
  try {
    const previous = JSON.parse(readFileSync(file, 'utf8'));
    if (Date.now() - previous.at < 10000) return;
  } catch {}
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    temp = `${file}.${randomUUID()}.tmp`;
    const allowed = Object.fromEntries(
      Object.entries(detail)
        .filter(([k]) => ['agent', 'event', 'from', 'to', 'protocol'].includes(k))
        .map(([k, v]) => [
          k,
          String(v)
            .replace(/[^a-zA-Z0-9_.:-]/g, '')
            .slice(0, 80),
        ]),
    );
    writeFileSync(temp, JSON.stringify({ code, at: Date.now(), ...allowed }), { mode: 0o600 });
    renameSync(temp, file);
  } catch {
    /* Diagnostics never break hooks or IPC. */
  } finally {
    if (temp) {
      try {
        rmSync(temp, { force: true });
      } catch {}
    }
  }
}
export function observedHook(event: string, agent: string) {
  if (events.includes(event as (typeof events)[number]))
    diagnostic(`hook-${event as (typeof events)[number]}`, { event, agent });
}
export function diagnosticStatus(home?: string) {
  return Object.fromEntries(
    [
      ...events.map((e) => `hook-${e}`),
      'hook-error',
      'hook-unavailable',
      'identity-conflict',
      'upgrade',
      'reconnected',
      'bootstrap-node',
      'bootstrap-runtime',
    ].map((code) => {
      try {
        return [
          code,
          JSON.parse(
            readFileSync(join(paths(home).home, 'logs/diagnostics', `${code}.json`), 'utf8'),
          ),
        ];
      } catch {
        return [code, 'unknown'];
      }
    }),
  );
}
