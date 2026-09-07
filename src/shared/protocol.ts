// Adapter IDs are open-ended, so any MCP host can participate.
export type Agent = string;
export type Role = 'none' | 'commander' | 'executor';
export type MessageType = 'command' | 'ask' | 'answer' | 'report' | 'info' | 'system';
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
  presence: 'online' | 'offline';
  activity: 'busy' | 'idle';
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
  created_at: number;
  delivered_at: number | null;
}
