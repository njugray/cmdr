import { diagnostic, observedHook } from '../shared/diagnostics.js';
import { existsSync } from 'node:fs';
import { paths } from '../shared/paths.js';
import { detectAgent, cmdrTool } from '../shared/env.js';
import { quickCall } from '../shared/client.js';
import { ancestors } from '../mcp/terminal.js';
export async function runHook(input: any, event = input.hook_event_name) {
  const agent = detectAgent(process.env, input),
    sid = `${agent}:${input.session_id}`;
  observedHook(event, agent);
  if (!input.session_id) return;
  if (process.env.CMDR_SESSION_ID && process.env.CMDR_SESSION_ID !== input.session_id) {
    diagnostic('identity-conflict', { agent });
    return;
  }
  if (event === 'PreToolUse' && cmdrTool.test(input.tool_name || '')) {
    // Kimi Code pools one MCP process per workspace, so the model must supply
    // its session on every call; hooks cannot rewrite tool input, so a missing
    // or mismatched stamp is a native block (exit 2, stderr) instead.
    if (agent === 'kimi') {
      if ((input.tool_input || {})._cmdr_session === input.session_id) return;
      return {
        decision: 'block',
        reason: `[cmdr] Kimi Code shares one cmdr MCP process per workspace; retry this call with _cmdr_session="${input.session_id}".`,
      };
    }
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
  const parsed = JSON.parse(input);
  // Kimi Code delivers Stop/PreToolUse block reasons (exit code 2, stderr) and
  // UserPromptSubmit stdout into the model context; text on other events (e.g.
  // SessionStart reminders) is dropped by the host, so only those shapes are
  // emitted.
  const agent = detectAgent(process.env, parsed);
  const result = await runHook(parsed, process.argv[2]);
  if (result) {
    if (agent === 'kimi') {
      if (result.decision === 'block')
        process.stderr.write(`${result.reason}\n`, () => process.exit(2));
      else if (
        process.argv[2] === 'UserPromptSubmit' &&
        result.hookSpecificOutput?.additionalContext
      )
        process.stdout.write(result.hookSpecificOutput.additionalContext + '\n');
    } else process.stdout.write(JSON.stringify(result) + '\n');
  }
} catch (e: any) {
  diagnostic(e.code === 'DAEMON_UNAVAILABLE' ? 'hook-unavailable' : 'hook-error');
  /* hooks always fail open, including malformed input and absent daemon */
}
clearTimeout(timer);
