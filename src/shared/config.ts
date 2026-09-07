import { readFileSync } from 'node:fs';
export const defaults = {
  ttlDays: 7,
  idleExitMinutes: 30,
  remindIntervalSec: 300,
  maxQueue: 1000,
  rateLimitPerMinute: 60,
  log: { level: 'info' },
};
export type Config = typeof defaults;
export function config(path: string): Config {
  let input: any = {};
  try {
    input = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    /* defaults */
  }
  const result = { ...defaults };
  for (const key of [
    'ttlDays',
    'idleExitMinutes',
    'remindIntervalSec',
    'maxQueue',
    'rateLimitPerMinute',
  ] as const) {
    if (typeof input[key] === 'number' && Number.isFinite(input[key]) && input[key] > 0)
      result[key] = input[key];
  }
  if (['debug', 'info', 'warn', 'error'].includes(input.log?.level))
    result.log = { level: input.log.level };
  return result;
}
