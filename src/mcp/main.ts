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
  join: 'Create/join a squad. For /cmdr <name>, pass only squad_name for atomic find-or-create. Otherwise specify role and optional squad ID/name. Executors report ready after joining. Reply to the user with user_reply, then read(wait=me.recommended_wait).',
  list: 'Show squad members, presence, activity and pending commands. scope=all lists squads and sessions.',
  send: 'Commander: dispatch clear tasks with acceptance criteria, or answer an ask using type=answer and reply_to. to accepts all, exact sid, unique sid prefix or member name.',
  report:
    'Executor: report ready (cwd/capabilities), working, blocked, done or failed; include reply_to for the command.',
  ask: 'Executor: ask the commander for guidance. Optional wait waits for the matching answer; use me.recommended_wait as the upper bound.',
  read: 'Fetch messages in priority order (reading dequeues). Use wait=me.recommended_wait to stand by, peek to inspect or history to review delivered messages. Do at most 40 standby rounds.',
  leave:
    'Leave the squad. Commander departure orphans it; dissolve=true disbands it. Messages already queued remain readable.',
};
const methods: Record<Tool, string> = {
  join: 'session.join',
  list: 'session.list',
  send: 'msg.send',
  report: 'msg.report',
  ask: 'msg.ask',
  read: 'msg.read',
  leave: 'session.leave',
};
for (const name of Object.keys(schemas) as Tool[]) {
  server.registerTool(
    name,
    { description: descriptions[name], inputSchema: schemas[name].shape },
    async (args: any, extra: { signal: AbortSignal }) => {
      try {
        const { _cmdr_session, ...params } = args;
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
