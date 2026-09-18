import type { Work, Squad } from './protocol.js';

export const DASHBOARD_LIMITS = {
  recordsPerKind: 200,
  runsPerTask: 100,
  htmlBytes: 256 * 1024,
  htmlBytesPerSquad: 8 * 1024 * 1024,
};
export type TaskState =
  'planned' | 'queued' | 'read' | 'working' | 'blocked' | 'completed' | 'failed' | 'cancelled';
export interface TaskRun {
  command_id: string;
  member_id: string;
  sid: string;
  name: string | null;
  message: string;
  work: Work;
  blocked_by?: string;
  report?: { status: string; message: string; at: number };
  created_at: number;
}
export interface Task {
  id: string;
  squad_id: string;
  title: string;
  description: string;
  acceptance: string;
  position: number;
  artifact_ids: string[];
  archived: boolean;
  state: TaskState;
  runs: TaskRun[];
  run_count?: number;
  created_at: number;
  updated_at: number;
}
export type QuestionKind = 'single' | 'multiple' | 'text' | 'confirm';
export interface AnswerInput {
  question_id: string;
  version: number;
  submission_id: string;
  selected: string[];
  text: string;
  confirmed?: boolean;
}
export interface UserMessageInput {
  squad_id: string;
  submission_id: string;
  text: string;
}
export interface UserMessageReceipt {
  message_id: string;
  received_at: number;
}
export interface Question {
  id: string;
  squad_id: string;
  task_id?: string;
  question: string;
  description: string;
  kind: QuestionKind;
  options: { id: string; label: string }[];
  artifact_ids: string[];
  version: number;
  status: 'pending' | 'answered' | 'handled' | 'withdrawn';
  answer?: AnswerInput & { received_at: number; message_id: string };
  result?: string;
  created_at: number;
  updated_at: number;
}
export interface Artifact {
  id: string;
  squad_id: string;
  title: string;
  html: string;
  version: number;
  created_at: number;
  updated_at: number;
}
export type ArtifactSummary = Omit<Artifact, 'html'>;
export interface Submission {
  input: AnswerInput;
  receipt: {
    question_id: string;
    version: number;
    submission_id: string;
    received_at: number;
    message_id: string;
  };
  snapshot: { question: Question; artifacts: Artifact[] };
}
export interface DashboardMember {
  sid: string;
  member_id: string;
  name: string | null;
  agent: string;
  role: string;
  presence: string;
  activity: string;
  last_seen: number;
  last_progress_at: number | null;
  last_status: { status: string; message: string } | null;
  commands: { id: string; state: string; cancel_requested_at?: number }[];
  listener: {
    wake_mode: string;
    health: string;
    can_auto_respond: boolean;
    error?: string;
    request?: { state: string };
  };
}
export interface SquadSummary extends Squad {
  task_count: number;
  active_tasks: number;
  pending_questions: number;
  unanswered_decisions: number;
}
export interface DashboardSnapshot {
  squad: Squad;
  tasks: Task[];
  questions: Question[];
  artifacts: ArtifactSummary[];
  members: DashboardMember[];
  activity: { id: number; at: number; kind: string; message?: string }[];
}
