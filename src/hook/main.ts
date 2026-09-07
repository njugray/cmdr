import { existsSync } from 'node:fs';
import { paths } from '../shared/paths.js';
import { detectAgent, cmdrTool } from '../shared/env.js';
import { quickCall } from '../shared/client.js';
import { ancestors } from '../mcp/terminal.js';
export async function runHook(input: any, event = input.hook_event_name) {
  const agent = detectAgent(process.env, input),
    sid = `${agent}:${input.session_id}`;
  if (!input.session_id) return;
  if (event === 'PreToolUse' && cmdrTool.test(input.tool_name || '')) {
    if (agent !== 'claude')
      return {
        hookSpecificOutput: {
          hookEventName: event,
          permissionDecision: 'allow',
          updatedInput: { ...input.tool_input, _cmdr_session: input.session_id },
        },
      };
    return;
  }
  if (event === 'PreToolUse' && !existsSync(paths().flag(sid))) return;
  const result = await quickCall(
    'hook.event',
    {
      ...input,
      event,
      agent,
      ...(event === 'SessionStart' ? { ancestors: ancestors(), host_pid: process.ppid } : {}),
    },
    { kind: 'hook', timeout: 100 },
  );
  if (event === 'SessionEnd') return;
  if (result.block) return { decision: 'block', reason: result.reason };
  if (result.inject)
    return { hookSpecificOutput: { hookEventName: event, additionalContext: result.inject } };
}
const timer = setTimeout(() => process.exit(0), 450);
try {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 2 * 1024 * 1024) throw new Error('large input');
  }
  const result = await runHook(JSON.parse(input), process.argv[2]);
  if (result) process.stdout.write(JSON.stringify(result) + '\n');
} catch {
  /* hooks always fail open, including malformed input and absent daemon */
}
clearTimeout(timer);
