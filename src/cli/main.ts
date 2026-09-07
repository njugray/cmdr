import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { quickCall, daemonConnection } from '../shared/client.js';
import { paths } from '../shared/paths.js';
import { VERSION } from '../shared/version.js';
const { values: v, positionals: args } = parseArgs({
  allowPositionals: true,
  options: {
    agent: { type: 'string' },
    all: { type: 'boolean' },
    squad: { type: 'string' },
    to: { type: 'string' },
    type: { type: 'string' },
    'reply-to': { type: 'string' },
    session: { type: 'string' },
    peek: { type: 'boolean' },
    follow: { type: 'boolean' },
    full: { type: 'boolean' },
    json: { type: 'boolean' },
    help: { type: 'boolean' },
  },
});
const p = paths(),
  cmd = args[0] || 'status';
const print = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
const call = (method: string, params: any = {}, start = false) =>
  quickCall(method, params, { start });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function doctor() {
  const checks: Record<string, unknown> = {
    node: process.version,
    node_path: process.execPath,
    cmdr: VERSION,
    home: p.home,
  };
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  checks.bundles = Object.fromEntries(
    ['daemon', 'mcp', 'hook', 'cli'].map((n) => [n, existsSync(join(root, 'dist', `${n}.mjs`))]),
  );
  for (const host of ['claude', 'codex']) {
    try {
      checks[host] = execFileSync(host, ['--version'], { encoding: 'utf8', timeout: 3000 }).trim();
    } catch {
      checks[host] = 'CLI not available in PATH';
    }
  }
  try {
    checks.daemon = await call('admin.status');
  } catch {
    checks.daemon = 'not running';
  }
  try {
    const conf = readFileSync(
      join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml'),
      'utf8',
    );
    checks.codex_hooks = /(?:^|\n)\s*hooks\s*=\s*false/.test(conf)
      ? 'disabled'
      : 'not explicitly disabled; verify features.hooks in Codex';
    checks.codex_hook_trust =
      'Verify all five cmdr hooks in the Codex trust UI (storage format is host-specific).';
    if (/cmdr/.test(conf)) {
      const listing = execFileSync('codex', ['mcp', 'list'], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      checks.codex_mcp_registered = /\bcmdr\b/.test(listing);
    } else
      checks.codex_mcp_registered =
        'No cmdr entry found in config; run codex mcp list after installing.';
  } catch {
    checks.codex_hooks = 'Codex configuration unavailable';
  }
  const zcodeRoot = '/Applications/ZCode.app/Contents';
  if (existsSync(join(zcodeRoot, 'Info.plist'))) {
    try {
      checks.zcode = {
        app_version: execFileSync(
          '/usr/libexec/PlistBuddy',
          ['-c', 'Print :CFBundleShortVersionString', join(zcodeRoot, 'Info.plist')],
          { encoding: 'utf8', timeout: 1000 },
        ).trim(),
        runtime: join(zcodeRoot, 'Resources/glm/zcode.cjs'),
      };
    } catch {
      checks.zcode = 'Installed';
    }
  } else
    checks.zcode =
      'Desktop app not found in /Applications; generic MCP configuration is available.';
  try {
    const zconfig = JSON.parse(readFileSync(join(homedir(), '.zcode/cli/config.json'), 'utf8'));
    checks.zcode_user_hooks = zconfig.hooks?.enabled === true;
  } catch {
    checks.zcode_user_hooks =
      'No user hook config; installed plugin hooks follow plugin enablement.';
  }
  print(checks);
}
try {
  if (v.help)
    process.stdout.write(
      'cmdr status | list [--all] [--squad ID] | tail [--follow] [--full] | send --squad ID [--to MEMBER] [--type command|info|answer] TEXT | read --session SID [--peek] | daemon start|stop|restart|status|logs | config [--agent HOST] [--session ID] | doctor | purge [--all]\n',
    );
  else if (cmd === 'config') {
    const agent = v.agent || 'generic';
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(agent))
      throw new Error('Invalid --agent: use lowercase letters, digits, underscores or hyphens.');
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    const server = {
      command: join(root, 'bin/cmdr-mcp'),
      env: {
        CMDR_AGENT: agent,
        ...(v.session ? { CMDR_SESSION_ID: v.session } : {}),
        ...(agent === 'zcode' ? { CMDR_TOOL_TIMEOUT_SEC: '600' } : {}),
      },
      ...(agent === 'zcode' ? { timeoutMs: 600000 } : {}),
    };
    print(
      agent === 'zcode' ? { mcp: { servers: { cmdr: server } } } : { mcpServers: { cmdr: server } },
    );
  } else if (cmd === 'doctor') await doctor();
  else if (cmd === 'status') print(await call('admin.status'));
  else if (cmd === 'list') {
    const result = await call('session.list', { scope: v.all ? 'all' : undefined, squad: v.squad });
    if (v.json) print(result);
    else {
      console.table(
        result.sessions.map((s: any) => ({
          sid: s.short,
          agent: s.agent,
          name: s.name,
          title: s.title,
          role: s.role,
          squad: s.squad,
          presence: s.presence,
          activity: s.activity,
          pending: s.pending,
          cwd: s.cwd,
          terminal: s.terminal?.program,
        })),
      );
      console.table(
        result.squads.map((s: any) => ({
          id: s.id,
          name: s.name,
          status: s.status,
          commander: s.commander_sid,
        })),
      );
    }
  } else if (cmd === 'send')
    print(
      await call(
        'msg.send',
        {
          squad: v.squad,
          to: v.to || 'all',
          type: v.type || 'command',
          reply_to: v['reply-to'],
          message: args.slice(1).join(' '),
        },
        true,
      ),
    );
  else if (cmd === 'read') {
    if (!v.session) throw new Error('--session SID is required');
    print(await call('admin.read', { sid: v.session, options: { peek: !!v.peek } }));
  } else if (cmd === 'purge') print(await call('admin.purge', { all: !!v.all }));
  else if (cmd === 'tail') {
    const rpc = await daemonConnection();
    await rpc.request('session.register', { kind: 'cli' });
    if (v.follow) {
      rpc.on('notification', (method, value) => {
        if (method === 'msg.event') print(value);
      });
      await rpc.request('admin.tail', { squad: v.squad, full: !!v.full });
    }
    print(await rpc.request('admin.recent', { squad: v.squad, full: !!v.full }));
    if (!v.follow) rpc.close();
    else process.on('SIGINT', () => rpc.close());
  } else if (cmd === 'daemon') {
    const action = args[1] || 'status';
    if (action === 'logs')
      process.stdout.write(existsSync(p.log) ? readFileSync(p.log, 'utf8') : 'No daemon logs.\n');
    else if (action === 'status') print(await call('admin.status'));
    else if (action === 'stop' || action === 'restart') {
      try {
        print(await call('admin.shutdown', { reason: action }));
      } catch (e) {
        if (action === 'stop') throw e;
      }
      if (action === 'restart') {
        for (let n = 0; n < 60 && existsSync(p.socket); n++) await pause(50);
        print(await call('admin.status', {}, true));
      }
    } else if (action === 'start') print(await call('admin.status', {}, true));
    else throw new Error(`Unknown daemon action: ${action}`);
  } else throw new Error(`Unknown command: ${cmd}`);
} catch (e: any) {
  process.stderr.write(`cmdr: ${e.code || 'ERROR'}: ${e.message}\n`);
  process.exitCode = 1;
}
