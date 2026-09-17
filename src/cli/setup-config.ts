import { isDeepStrictEqual } from 'node:util';
import { parse, stringify } from 'smol-toml';

export type SetupHost = 'claude' | 'codex' | 'zcode';
type ObjectValue = Record<string, any>;
const begin = '# BEGIN cmdr setup';
const end = '# END cmdr setup';

export function object(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object; no configuration was changed.`);
  return value as ObjectValue;
}

export function jsonConfig(text: string, label: string): ObjectValue {
  try {
    return object(JSON.parse(text || '{}'), label);
  } catch {
    throw new Error(`Cannot parse ${label} as a JSON object; no configuration was changed.`);
  }
}

export function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function checkPlugin(config: ObjectValue, host: SetupHost) {
  const plugins =
    host === 'codex' ? config.plugins : config.enabledPlugins || config.plugins?.enabledPlugins;
  if (
    plugins &&
    Object.entries(object(plugins, 'plugins')).some(
      ([name, value]) =>
        /^(cmdr@|cmdr$)/.test(name) &&
        (value === true ||
          (typeof value === 'object' &&
            value !== null &&
            (value as ObjectValue).enabled !== false)),
    )
  )
    throw new Error(
      'The cmdr plugin is already enabled. Use its installation, or disable it before running standalone setup to avoid duplicate tools and hooks.',
    );
}

function serverConfig(previous: unknown, command: string, host: SetupHost): ObjectValue {
  const server = previous === undefined ? {} : object(previous, 'cmdr MCP server');
  if (previous !== undefined && (server.command !== command || server.url))
    throw new Error(
      'An unmanaged cmdr MCP server already exists. Remove that cmdr entry before running setup; other servers will be preserved.',
    );
  return {
    ...server,
    command,
    args: [],
    ...(host === 'codex' ? { tool_timeout_sec: 600 } : { type: 'stdio' }),
    ...(host === 'zcode' ? { timeoutMs: 600000 } : {}),
  };
}

export function mergeJsonServer(config: ObjectValue, command: string, host: 'claude' | 'zcode') {
  const parent = host === 'zcode' ? (config.mcp = object(config.mcp ?? {}, 'mcp')) : config;
  const key = host === 'zcode' ? 'servers' : 'mcpServers';
  const servers = (parent[key] = object(parent[key] ?? {}, key));
  servers.cmdr = serverConfig(servers.cmdr, command, host);
}

export function codexConfig(text: string, command: string) {
  let config: ObjectValue;
  try {
    config = parse(text, { integersAsBigInt: 'asNeeded' });
  } catch {
    throw new Error('Cannot parse Codex config.toml; no configuration was changed.');
  }
  checkPlugin(config, 'codex');
  const servers = object(config.mcp_servers ?? {}, 'mcp_servers');
  const server = serverConfig(servers.cmdr, command, 'codex');
  const block = `${begin}\n${stringify({ mcp_servers: { cmdr: server } })}${end}`;
  const start = text.indexOf(begin),
    stop = text.indexOf(end);
  let output: string;
  if (start >= 0 || stop >= 0) {
    if (
      start < 0 ||
      stop < start ||
      text.indexOf(begin, start + begin.length) >= 0 ||
      text.indexOf(end, stop + end.length) >= 0
    )
      throw new Error(
        'Invalid cmdr setup markers in config.toml. Restore the managed block before retrying.',
      );
    output = text.slice(0, start) + block + text.slice(stop + end.length);
  } else {
    if (servers.cmdr !== undefined)
      throw new Error(
        'The cmdr MCP entry is not managed by setup. Remove that entry before retrying.',
      );
    output = `${text}${text && !text.endsWith('\n') ? '\n' : ''}\n${block}\n`;
  }
  // Markers inside strings, inline tables and edits around the block must never
  // change the meaning of unrelated configuration. Keep its original text too.
  const expected = { ...config, mcp_servers: { ...servers, cmdr: server } };
  try {
    if (!isDeepStrictEqual(parse(output, { integersAsBigInt: 'asNeeded' }), expected))
      throw new Error();
  } catch {
    throw new Error(
      'Cannot safely merge the cmdr block into config.toml. Move the cmdr MCP entry to a separate table and retry.',
    );
  }
  return {
    text: output,
    hooksDisabled: config.features?.hooks === false || config.features?.codex_hooks === false,
    serverDisabled: server.enabled === false,
  };
}

export function mergeHooks(config: ObjectValue, executable: string, host: SetupHost) {
  const container = (config.hooks = object(config.hooks ?? {}, 'hooks'));
  const hooks =
    host === 'zcode'
      ? (container.events = object(container.events ?? {}, 'hooks.events'))
      : container;
  const disabled = host === 'zcode' ? container.enabled === false : config.disableAllHooks === true;
  // Preserve an explicit user opt-out; do not enable other disabled user hooks.
  if (host === 'zcode' && container.enabled === undefined) container.enabled = true;
  const events = [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'Stop',
    ...(host === 'zcode' ? [] : ['SessionEnd']),
  ];
  for (const event of events) {
    const entries = hooks[event] ?? [];
    if (!Array.isArray(entries)) throw new Error(`hooks.${event} must be an array.`);
    const command = `${shellQuote(executable)} ${event}`;
    const retained = entries.flatMap((entry: unknown) => {
      const group = object(entry, `hooks.${event} entry`);
      if (!Array.isArray(group.hooks))
        throw new Error(`hooks.${event} entry must contain a hooks array.`);
      const handlers = group.hooks.filter((handler: unknown) => {
        const hook = object(handler, 'hook handler');
        return host === 'zcode'
          ? !(
              hook.type === 'process' &&
              hook.command === executable &&
              isDeepStrictEqual(hook.args, [event])
            )
          : !(hook.type === 'command' && hook.command === command);
      });
      return handlers.length === group.hooks.length
        ? [group]
        : handlers.length
          ? [{ ...group, hooks: handlers }]
          : [];
    });
    hooks[event] = [
      ...retained,
      {
        hooks: [
          host === 'zcode'
            ? {
                type: 'process',
                command: executable,
                args: [event],
                enabled: true,
                timeoutMs: 5000,
              }
            : { type: 'command', command, timeout: event === 'SessionEnd' ? 1 : 5 },
        ],
      },
    ];
  }
  return disabled;
}
