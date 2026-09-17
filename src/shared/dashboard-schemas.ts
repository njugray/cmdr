import { z } from 'zod';
import { DASHBOARD_LIMITS } from './dashboard.js';

const id = z.string().min(1).max(128);
const text = z.string().max(8000);
const artifacts = z.array(id).max(8);
export const taskFields = {
  action: z.enum(['create', 'update', 'get', 'list', 'archive', 'restore']).default('list'),
  id: id.optional(),
  title: z.string().trim().min(1).max(200).optional(),
  description: text.optional(),
  acceptance: text.optional(),
  position: z.number().finite().optional(),
  artifact_ids: artifacts.optional(),
  archived: z.boolean().optional(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(50).default(20),
};
export const questionFields = {
  target: z.enum(['commander', 'user']).default('commander'),
  action: z.enum(['create', 'update', 'get', 'list', 'withdraw', 'handle']).default('create'),
  id: id.optional(),
  task_id: id.optional(),
  version: z.number().int().positive().optional(),
  description: text.optional(),
  kind: z.enum(['single', 'multiple', 'text', 'confirm']).optional(),
  options: z
    .array(z.object({ id, label: z.string().trim().min(1).max(300) }).strict())
    .max(20)
    .optional(),
  artifact_ids: artifacts.optional(),
  result: text.optional(),
  status: z.enum(['pending', 'answered', 'handled', 'withdrawn']).optional(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(50).default(20),
};
export const artifactFields = {
  action: z.enum(['publish', 'get', 'list']).default('publish'),
  id: id.optional(),
  version: z.number().int().positive().optional(),
  title: z.string().trim().min(1).max(200).optional(),
  html: z
    .string()
    .min(1)
    .refine((s) => Buffer.byteLength(s) <= DASHBOARD_LIMITS.htmlBytes, 'MESSAGE_TOO_LARGE')
    .optional(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(50).default(20),
};
export const answerSchema = z
  .object({
    question_id: id,
    version: z.number().int().positive(),
    submission_id: z.string().uuid(),
    selected: z.array(id).max(20).default([]),
    text: text.default(''),
    confirmed: z.boolean().optional(),
  })
  .strict();

export const userMessageSchema = z
  .object({
    squad_id: id,
    submission_id: z.string().uuid(),
    text: z.string().trim().min(1).max(8000),
  })
  .strict();
