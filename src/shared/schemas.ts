import { z } from 'zod';
import { LIMITS, fail } from './protocol.js';

const text = z
  .string()
  .min(1)
  .refine((v) => Buffer.byteLength(v) <= LIMITS.maxBody, 'MESSAGE_TOO_LARGE');
const data = z
  .record(z.unknown())
  .refine((v) => Buffer.byteLength(JSON.stringify(v)) <= LIMITS.maxData, 'MESSAGE_TOO_LARGE')
  .optional();
const wait = z.number().min(0).max(300).default(0);
const identity = { _cmdr_session: z.string().min(1).max(256).optional() };
export const schemas = {
  join: z
    .object({
      ...identity,
      role: z.enum(['commander', 'executor']).optional(),
      squad: z.string().optional(),
      name: z.string().trim().min(1).max(64).optional(),
      note: text.optional(),
      squad_name: z.string().trim().min(1).max(64).optional(),
    })
    .strict(),
  list: z
    .object({
      ...identity,
      scope: z.enum(['squad', 'all']).optional(),
      squad: z.string().optional(),
    })
    .strict(),
  report: z
    .object({
      ...identity,
      status: z.enum(['ready', 'working', 'blocked', 'done', 'failed']),
      message: text,
      reply_to: z.string().optional(),
      data,
    })
    .strict(),
  ask: z
    .object({ ...identity, question: text, wait, reply_to: z.string().optional(), data })
    .strict(),
  send: z
    .object({
      ...identity,
      to: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(1000)]),
      message: text,
      type: z.enum(['command', 'answer', 'info']).default('command'),
      priority: z.enum(['high', 'normal', 'low']).optional(),
      reply_to: z.string().optional(),
      data,
    })
    .strict(),
  read: z
    .object({
      ...identity,
      wait,
      limit: z.number().int().min(1).max(100).default(20),
      peek: z.boolean().default(false),
      history: z.boolean().default(false),
      since: z.string().optional(),
    })
    .strict(),
  leave: z
    .object({ ...identity, dissolve: z.boolean().default(false), message: text.optional() })
    .strict(),
};
export type Tool = keyof typeof schemas;
export function parse(tool: Tool, args: unknown): any {
  const r = schemas[tool].safeParse(args);
  if (!r.success)
    fail(
      r.error.issues.some((i) => i.message === 'MESSAGE_TOO_LARGE')
        ? 'MESSAGE_TOO_LARGE'
        : 'INVALID_ARGUMENT',
      r.error.message,
    );
  return r.data;
}
