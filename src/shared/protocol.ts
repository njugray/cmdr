// Adapter IDs are open-ended, so any MCP host can participate.
export type Agent = string;
export type Role = 'none' | 'commander' | 'executor';
export type MessageType = 'command' | 'cancel' | 'ask' | 'answer' | 'report' | 'info' | 'system';
export const LIMITS = {
  maxWaitSec: 300,
  maxBody: 32768,
  maxData: 65536,
  maxFrame: 2 * 1024 * 1024,
};
export class CmdrError extends Error {
  constructor(
    public code: string,
    message = code,
  ) {
    super(message);
  }
}
export function fail(code: string, message?: string): never {
  throw new CmdrError(code, message);
}
// Raised only before a host delivery call is attempted, so deferral is safe.
export class WakeDeferred extends Error {}
export interface Session {
  sid: string;
  agent: Agent;
  native_id: string | null;
  name: string | null;
  title: string | null;
  cwd: string | null;
  pid: number | null;
  terminal: Record<string, unknown>;
  transcript_path: string | null;
  role: Role;
  squad_id: string | null;
  presence: 'online' | 'offline' | 'cli';
  transport?: 'mcp' | 'cli';
  member_id?: string;
  activity_at?: number;
  last_progress_at?: number;
  hook_seen_at?: number;
  activity: 'busy' | 'idle' | 'unknown';
  last_status: { status: string; message: string } | null;
  last_notified_seq: number;
  last_notified_at: number;
  last_stop_block_seq: number;
  created_at: number;
  last_seen_at: number;
  ended_at: number | null;
}
export interface Squad {
  id: string;
  name: string | null;
  name_key: string | null;
  commander_sid: string | null;
  status: 'active' | 'orphaned' | 'dissolved';
  created_at: number;
  updated_at: number;
}
export interface Message {
  id: string;
  seq: number;
  squad_id: string | null;
  type: MessageType;
  priority: number;
  from_sid: string;
  from_role: string;
  from_name: string | null;
  to_sid: string;
  body: string;
  data: Record<string, unknown> | null;
  reply_to: string | null;
  status: 'queued' | 'delivered';
  attn: boolean;
  direct?: boolean;
  created_at: number;
  delivered_at: number | null;
  work?: Work;
  task_key?: string;
  blocked_by?: string;
}

export type WorkState = 'queued' | 'read' | 'accepted' | 'completed' | 'failed' | 'cancelled';
export interface Work {
  state: WorkState;
  updated_at: number;
  accepted_at?: number;
  cancel_requested_at?: number;
  replacement_id?: string;
}
export const terminalWork = (m: Message | undefined) =>
  !!m?.work && ['completed', 'failed', 'cancelled'].includes(m.work.state);
export interface LifecycleEvent {
  event_seq: number;
  at: number;
  kind: string;
  channel: string | null;
  from_sid?: string;
  to_sid?: string;
  message_id?: string;
  reply_to?: string | null;
  reason?: string;
  message?: Message;
  data?: Record<string, unknown>;
}
export interface WakeRequest {
  transport?: 'proxy' | 'queue';
  id: string;
  fingerprint: string;
  message_ids: string[];
  created_at: number;
  state: 'requested' | 'accepted' | 'observed' | 'uncertain' | 'failed';
  submission_id?: string;
  error?: string;
}
export interface Standby {
  generation?: number;
  sid: string;
  enabled: boolean;
  wake_mode: 'codex' | 'claude' | 'zcode' | 'manual';
  transport?: 'proxy' | 'queue';
  codex_transport?: 'auto' | 'proxy' | 'queue';
  lease?: { token: string; expires_at: number };
  executable?: string;
  socket?: string;
  health: 'starting' | 'healthy' | 'stopped' | 'manual' | 'error' | 'uncertain' | 'stalled';
  host_state: 'idle' | 'busy' | 'unknown';
  checked_at: number | null;
  error?: string;
  request?: WakeRequest;
}
