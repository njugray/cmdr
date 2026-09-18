import type { Agent } from './protocol.js';
export const cmdrTool =
  /(?:^|[_:])cmdr(?:__|:)(list|join|report|leave|ask|send|read|task|artifact)$/;
export function detectAgent(env = process.env, hook?: Record<string, unknown>): Agent {
  if (env.CMDR_AGENT && /^[a-z][a-z0-9_-]{0,63}$/.test(env.CMDR_AGENT)) return env.CMDR_AGENT;
  if (env.ZCODE_PLUGIN_ROOT || env.ZCODE_PLUGIN_ID) return 'zcode';
  if (env.KIMI_PLUGIN_ROOT) return 'kimi';
  if (env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_CODE_ENTRYPOINT) return 'claude';
  if (hook?.transcript_path && String(hook.transcript_path).includes('/.claude/')) return 'claude';
  if (env.CODEX_HOME || env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || hook?.turn_id)
    return 'codex';
  return 'generic';
}
export function waitRecommendation(agent: Agent, env = process.env) {
  const timeout = Number(env.CMDR_TOOL_TIMEOUT_SEC);
  if (Number.isFinite(timeout) && timeout > 0) {
    return {
      seconds: Math.min(300, Math.max(0, timeout - Math.min(15, timeout / 4))),
      source: 'CMDR_TOOL_TIMEOUT_SEC',
      timeout,
    };
  }
  return { seconds: agent === 'claude' ? 300 : 45, source: 'host default', timeout: null };
}
export function recommendedWait(agent: Agent, env = process.env) {
  return waitRecommendation(agent, env).seconds;
}
