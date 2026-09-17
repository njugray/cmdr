import { tail } from './tail.js';
import { runSession } from './session.js';
import { inspectInstallation, probeMcp, diagnosticStatus } from './doctor.js';
import { waitRecommendation } from '../shared/env.js';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { quickCall, daemonConnection } from '../shared/client.js';
import { paths } from '../shared/paths.js';
import { VERSION } from '../shared/version.js';
import { runSetup } from './setup.js';
if (process.argv[2] === 'setup') {
  try {
    await runSetup(process.argv.slice(3), dirname(dirname(fileURLToPath(import.meta.url))));
  } catch (e: any) {
    console.error(e.message);
    process.exitCode = 1;
  }
} else if (process.argv[2] === 'session') {
  await runSession(process.argv.slice(3));
} else {
  const { values: v, positionals: args } = parseArgs({
    allowPositionals: true,
    options: {
      agent: { type: 'string' },
      'plugin-root': { type: 'string' },
      deep: { type: 'boolean' },
      all: { type: 'boolean' },
      squad: { type: 'string' },
      to: { type: 'string' },
      type: { type: 'string' },
      'reply-to': { type: 'string' },
      priority: { type: 'string' },
      'task-key': { type: 'string' },
      reassign: { type: 'string' },
      after: { type: 'string' },
      for: { type: 'string' },
      adapter: { type: 'string' },
      executable: { type: 'string' },
      socket: { type: 'string' },
      resolve: { type: 'string' },
      recover: { type: 'boolean' },
      history: { type: 'boolean' },
      id: { type: 'string' },
      limit: { type: 'string' },
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
    const target = resolve(v['plugin-root'] || root);
    const installation = await inspectInstallation(target);
    checks.installation = installation;
    checks.diagnostics = diagnosticStatus();
    checks.wait_recommendation = waitRecommendation(v.agent || 'generic');
    if (!installation.ok) process.exitCode = 1;
    if (v.deep && installation.ok) {
      const probe = await probeMcp(target);
      checks.mcp = probe;
      if (!probe.ok) process.exitCode = 1;
    }
    for (const host of ['claude', 'codex']) {
      try {
        checks[host] = execFileSync(host, ['--version'], {
          encoding: 'utf8',
          timeout: 3000,
        }).trim();
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
        'cmdr status | setup --agent claude-code|codex|zcode [--dry-run] [--json] | list [--all] [--squad ID] | tail [--follow] [--full] [--json] [--after EVENT_SEQ] [--for SID] | standby start|status|stop|resume --session SID [--adapter codex|manual] | send --squad ID [--to MEMBER] [--type command|cancel|info|answer] TEXT | read --session SID [--peek] | daemon start|stop|restart|status|logs | config [--agent HOST] [--session ID] | doctor [--plugin-root PATH] [--deep] | session --help | purge [--all]\n',
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
        agent === 'zcode'
          ? { mcp: { servers: { cmdr: server } } }
          : { mcpServers: { cmdr: server } },
      );
    } else if (cmd === 'doctor') await doctor();
    else if (cmd === 'status') print(await call('admin.status'));
    else if (cmd === 'list') {
      const result = await call('session.list', {
        scope: v.all ? 'all' : undefined,
        squad: v.squad,
        full: !!v.full,
      });
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
            work: s.commands
              .map((m: any) => `${m.id}:${m.state}${m.cancel_requested_at ? ':cancelling' : ''}`)
              .join(', '),
            unacked: s.unacked,
            in_progress: s.in_progress,
            activity: s.activity,
            progress_seconds_ago: s.last_progress_at
              ? Math.floor((Date.now() - s.last_progress_at) / 1000)
              : 'unknown',
            connection: s.presence,
            pending: s.pending,
            wake: `${s.listener.wake_mode}/${s.listener.health}`,
            identity: s.native_id ? 'confirmed' : 'provisional',
            seen_seconds_ago: Math.floor((Date.now() - s.last_seen) / 1000),
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
            priority: v.priority,
            reassign: v.reassign,
            task_key: v['task-key'],
            message: args.slice(1).join(' '),
          },
          true,
        ),
      );
    else if (cmd === 'read') {
      if (!v.session) throw new Error('--session SID is required');
      print(
        await call('admin.read', {
          sid: v.session,
          options: {
            peek: !!v.peek,
            history: !!v.history,
            full: !!v.full,
            recover: !!v.recover,
            id: v.id,
            limit: v.limit ? Number(v.limit) : undefined,
          },
        }),
      );
    } else if (cmd === 'purge') print(await call('admin.purge', { all: !!v.all }));
    else if (cmd === 'standby') {
      if (!v.session) throw new Error('--session SID is required');
      print(
        await call(
          'admin.standby',
          {
            sid: v.session,
            action: args[1] || 'status',
            adapter: v.adapter,
            executable: v.executable,
            socket: v.socket,
            resolve: v.resolve,
          },
          true,
        ),
      );
    } else if (cmd === 'tail') {
      const after = v.after === undefined ? undefined : Number(v.after);
      if (after !== undefined && (!Number.isSafeInteger(after) || after < 0))
        throw new Error('--after requires a nonnegative event_seq');
      await tail({
        squad: v.squad,
        for: v.for,
        after,
        full: !!v.full,
        json: !!v.json,
        follow: !!v.follow,
      });
    } else if (cmd === 'daemon') {
      const action = args[1] || 'status';
      if (action === 'logs')
        process.stdout.write(existsSync(p.log) ? readFileSync(p.log, 'utf8') : 'No daemon logs.\n');
      else if (action === 'status') print(await call('admin.status'));
      else if (action === 'stop' || action === 'restart') {
        if (action === 'restart')
          execFileSync(
            process.execPath,
            [
              '--experimental-sqlite',
              join(dirname(fileURLToPath(import.meta.url)), 'daemon.mjs'),
              '--preflight',
            ],
            { timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] },
          );
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
}
