import { parseArgs } from 'node:util';
import { DaemonClient } from '../shared/client.js';
import { schemas, parse, type Tool } from '../shared/schemas.js';
import { methods } from '../shared/methods.js';
import { recommendedWait } from '../shared/env.js';
export async function runSession(argv: string[]) {
  let client: DaemonClient | undefined;
  let timer: NodeJS.Timeout | undefined;
  const abort = new AbortController();
  const interrupt = () => {
    process.exitCode = 130;
    abort.abort();
    client?.close();
  };
  try {
    const { values: v, positionals: args } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        agent: { type: 'string' },
        'native-id': { type: 'string' },
        input: { type: 'string' },
        timeout: { type: 'string' },
        wait: { type: 'string' },
        role: { type: 'string' },
        squad: { type: 'string' },
        'squad-name': { type: 'string' },
        name: { type: 'string' },
        status: { type: 'string' },
        to: { type: 'string' },
        type: { type: 'string' },
        'reply-to': { type: 'string' },
        peek: { type: 'boolean' },
        history: { type: 'boolean' },
        dissolve: { type: 'boolean' },
        all: { type: 'boolean' },
        help: { type: 'boolean' },
      },
    });
    if (v.help) {
      console.log(
        'cmdr session join|list|send|report|ask|read|leave --agent HOST --native-id ID [--input JSON] [--timeout SECONDS]\nUse --squad-name for join; --status and text for report; --to and text for send; text for ask. read supports --wait/--peek/--history. IDs must match the host session; commands do not wake agents.',
      );
      return;
    }
    const action = args[0] as Tool;
    if (!Object.hasOwn(schemas, action))
      throw new Error('Expected session join|list|send|report|ask|read|leave');
    const agent = v.agent || process.env.CMDR_AGENT;
    const native = v['native-id'] || process.env.CMDR_SESSION_ID;
    if (!agent || !/^[a-z][a-z0-9_-]{0,63}$/.test(agent))
      throw new Error('--agent (or CMDR_AGENT) must be a valid host identifier');
    if (!native || native.length > 256)
      throw new Error(
        '--native-id (or CMDR_SESSION_ID) must be the stable native session ID (1–256 characters)',
      );
    if (
      (v.agent && process.env.CMDR_AGENT && v.agent !== process.env.CMDR_AGENT) ||
      (v['native-id'] && process.env.CMDR_SESSION_ID && native !== process.env.CMDR_SESSION_ID)
    )
      throw new Error(
        'Explicit identity conflicts with environment; use the same identity or unset the conflicting variable',
      );
    const input = v.input ? JSON.parse(v.input) : {};
    if (!input || typeof input !== 'object' || Array.isArray(input) || '_cmdr_session' in input)
      throw new Error('--input must be an object without _cmdr_session; use --native-id');
    const mapping = {
      role: 'role',
      squad: 'squad',
      'squad-name': 'squad_name',
      name: 'name',
      status: 'status',
      to: 'to',
      type: 'type',
      'reply-to': 'reply_to',
      peek: 'peek',
      history: 'history',
      dissolve: 'dissolve',
    } as const;
    for (const [flag, field] of Object.entries(mapping))
      if (v[flag as keyof typeof v] !== undefined) input[field] = v[flag as keyof typeof v];
    if (v.all) input.scope = 'all';
    if (v.wait !== undefined) input.wait = Number(v.wait);
    if (args.length > 1) input[action === 'ask' ? 'question' : 'message'] = args.slice(1).join(' ');
    const params = parse(action, input);
    const timeout = v.timeout === undefined ? (params.wait || 0) + 10 : Number(v.timeout);
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 3600)
      throw new Error('--timeout must be >0 and <=3600 seconds');
    client = new DaemonClient({
      kind: 'mcp',
      agent,
      native_id: native,
      cwd: process.cwd(),
      wait_hint: recommendedWait(agent),
    });
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', interrupt);
    timer = setTimeout(() => {
      abort.abort();
      client?.close();
    }, timeout * 1000);
    // Never retry a mutating request: a lost response is not proof of failed delivery.
    console.log(JSON.stringify(await client.call(methods[action], params, abort.signal), null, 2));
  } catch (e: any) {
    console.error(
      JSON.stringify({
        code: abort.signal.aborted ? 'REQUEST_CANCELLED' : e.code || 'INVALID_ARGUMENT',
        message: e.message,
      }),
    );
    process.exitCode ||= 1;
  } finally {
    clearTimeout(timer);
    client?.close();
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}
