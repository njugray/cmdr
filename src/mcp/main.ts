import { CmdrError } from '../shared/protocol.js';
import { methods } from '../shared/methods.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { schemas, type Tool } from '../shared/schemas.js';
import { VERSION } from '../shared/version.js';
import { detectAgent, recommendedWait } from '../shared/env.js';
import { DaemonClient } from '../shared/client.js';
import { sessionCwd } from './cwd.js';
import { terminal } from './terminal.js';
const agent = detectAgent();
const registration = {
  kind: 'mcp',
  agent,
  native_id:
    process.env.CMDR_SESSION_ID ||
    (agent === 'claude' ? process.env.CLAUDE_CODE_SESSION_ID : undefined),
  cwd: process.env.CMDR_CWD || sessionCwd(),
  title: process.env.CMDR_SESSION_TITLE,
  host_pid: process.ppid,
  terminal: terminal(),
  wait_hint: recommendedWait(agent),
};
const client = new DaemonClient(registration);
const clients = new Map<string, DaemonClient>();
let binding = Promise.resolve();
async function forSession(native?: string): Promise<DaemonClient> {
  if (!native) return client;
  if (process.env.CMDR_SESSION_ID && native !== process.env.CMDR_SESSION_ID)
    throw new CmdrError(
      'INVALID_ARGUMENT',
      'Session stamp conflicts with CMDR_SESSION_ID; use one process per explicit ID or stamps for a shared process.',
    );
  // Serialize only identity binding; long polls on separate sessions stay concurrent.
  let selected = client;
  const operation = binding.then(async () => {
    if (clients.get(native)?.nativeId === native) {
      selected = clients.get(native)!;
      return;
    }
    if (!client.nativeId || client.nativeId === native) {
      await client.identify(native);
      selected = client;
    } else {
      selected = new DaemonClient({ ...registration, native_id: native });
      await selected.connect();
    }
    clients.set(native, selected);
  });
  binding = operation.catch(() => {});
  await operation;
  return selected;
}
function closeClients() {
  client.close();
  for (const c of clients.values()) c.close();
}
const server = new McpServer({ name: 'cmdr', version: VERSION });
const descriptions: Record<Tool, string> = {
  join: 'Create/join a squad. For /cmdr <name>, pass squad_name for atomic find-or-create; role defaults to executor. Explicitly claim role=commander, use takeover=true for handover or rebind=member_id for a new endpoint. Otherwise specify role and optional squad ID/name. Use standby=auto; Claude/ZCode/Kimi must run listener.arm.command with the indicated native host tool, and re-arm on termination. Codex is daemon driven. Inspect listener health before ending the turn. Executors report ready after joining. Reply with user_reply and follow listener health; bounded read(wait=me.recommended_wait) is the manual fallback.',
  list: 'Show task ownership, unacked_for, execution activity, connection presence and listener health. Offline never authorizes reassignment. Use full=true for expanded session metadata; listings never include command bodies. Read your own messages with read(id=...). scope=all lists squads and sessions.',
  send: 'Commander: dispatch clear tasks with acceptance criteria, optionally linked to task_id from the dashboard task tool, or answer an executor ask using type=answer and reply_to. Use task_key to prevent duplicate tickets and reassign=<command id> for a gated handover preserving the original task/task_key. type=cancel with reply_to requests a safe stop. to accepts all, member_id, sid, unique sid prefix or member name.',
  report:
    'Executor: report ready (cwd/capabilities), working, blocked, done, failed or cancelled; include reply_to for the command.',
  ask: 'Executor: ask the commander (default target=commander). Commander: target=user creates a durable dashboard question (kind=single|multiple|text|confirm); use action=list|get|update|withdraw|handle, id and current version. handle requires result. User replies arrive in read; query status=answered to recover unhandled decisions. User questions do not use wait.',
  task: 'Maintain dashboard tasks. Commander uses action=create|update|archive|restore; title is required for create. Members can list/get within their squad. Dispatch with send(task_id=...). Execution states follow commands/reports; unfinished work cannot be archived. list is paginated; get includes durable execution history.',
  artifact:
    'Commander publishes self-contained HTML as an isolated dashboard explanation (256 KiB maximum). action=publish requires title and html; updating also requires id and current version. Link returned id via task/ask artifact_ids. Members can list/get. User answers always use built-in forms outside HTML. Updating an artifact increments versions of pending questions that reference it.',
  read: 'Fetch messages in priority order (reading dequeues). Use wait=me.recommended_wait to stand by, peek to inspect or history to review delivered messages. Use recover=true for all unfinished commands (non-consuming), id for a non-consuming message lookup (blocked replacements return REASSIGNMENT_PENDING), full for squad details. With a healthy listener, end the turn. Claude/ZCode/Kimi must first arm the built-in host watcher from listener.arm. Only when host wake is unavailable, do at most two waits and explain manual continuation.',
  leave:
    'Leave the squad. Commander departure orphans it; dissolve=true disbands it. Messages already queued remain readable.',
};
for (const name of Object.keys(schemas) as Tool[]) {
  server.registerTool(
    name,
    { description: descriptions[name], inputSchema: schemas[name].shape },
    async (args: any, extra: { signal: AbortSignal }) => {
      try {
        const { _cmdr_session, ...params } = args;
        if (agent === 'kimi' && !_cmdr_session && !process.env.CMDR_SESSION_ID)
          throw new CmdrError(
            'SESSION_STAMP_REQUIRED',
            'Kimi Code shares one cmdr MCP process per workspace, so every cmdr call must carry this session identity: retry with _cmdr_session="<session-id>". The id is the session_... value the cmdr identity skill renders for this session (${KIMI_SESSION_ID}); the main agent passes it on every call, including calls made on behalf of subagents.',
          );
        const selected = await forSession(_cmdr_session);
        const result = await selected.call(methods[name], params, extra.signal);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (e: any) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ code: e.code || 'DAEMON_UNAVAILABLE', message: e.message }),
            },
          ],
        };
      }
    },
  );
}
process.stdin.on('end', () => {
  closeClients();
  void server.close();
});
process.on('SIGTERM', () => {
  closeClients();
  void server.close();
});
await server.connect(new StdioServerTransport());
client.connect().catch(() => {
  /* tools report errors; next call retries */
});
