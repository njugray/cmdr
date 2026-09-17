// Optional smoke test against an installed ZCode desktop runtime; no model calls.
// All plugin state and the test workspace are isolated under a temporary directory.
import { spawn, execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  renameSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
const runtime =
  process.env.ZCODE_RUNTIME_PATH || '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';
if (!existsSync(runtime))
  throw new Error('Set ZCODE_RUNTIME_PATH to the installed desktop app’s glm/zcode.cjs.');
const dir = mkdtempSync(join(tmpdir(), 'cmdr-zcode-'));
const sourceRoot = join(dir, 'source');
mkdirSync(sourceRoot);
const input = process.argv[2];
let packageRoot;
if (input) {
  // Accept an already unpacked package root; never rename or mutate the caller's directory.
  const { cpSync } = await import('node:fs');
  cpSync(resolve(input), join(sourceRoot, 'package'), { recursive: true });
  packageRoot = join(sourceRoot, 'package');
} else {
  const [pack] = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--pack-destination', dir], {
      encoding: 'utf8',
      env: { ...process.env, npm_config_cache: join(dir, 'npm-cache'), npm_config_offline: 'true' },
    }),
  );
  execFileSync('tar', ['-xzf', join(dir, pack.filename), '-C', sourceRoot]);
  packageRoot = join(sourceRoot, 'package');
}
const workspace = { workspacePath: dir, workspaceKey: 'cmdr-smoke' };
const sessionDbPath = join(dir, 'zcode', 'cli', 'db', 'db.sqlite');
mkdirSync(join(dir, '.zcode'));
writeFileSync(
  join(dir, '.zcode/config.json'),
  JSON.stringify({
    storage: { dir: join(dir, 'zcode'), sessionDbPath },
    mcp: { servers: {} },
    plugins: { dirs: [], enabledPlugins: {} },
  }),
);
const child = spawn(
  process.execPath,
  [runtime, 'app-server', '--cwd', dir, '--surface', 'desktop'],
  {
    env: {
      ...process.env,
      ZCODE_STORAGE_DIR: join(dir, 'zcode'),
      // storage.dir does not control the session database opened at startup.
      ZCODE_SESSION_DB_PATH: sessionDbPath,
      CMDR_HOME: join(dir, 'cmdr'),
      OTEL_SDK_DISABLED: 'true',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  },
);
let id = 0,
  stderr = '';
const pending = new Map();
child.stderr.on('data', (b) => {
  stderr = (stderr + b).slice(-4000);
});
const lines = createInterface({ input: child.stdout });
lines.on('line', (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  clearTimeout(p.timer);
  if (m.error) p.reject(new Error(JSON.stringify(m.error)));
  else p.resolve(m.result);
});
function request(method, params) {
  return new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => {
      pending.delete(key);
      reject(new Error(`Timed out: ${method}\n${stderr}`));
    }, 20000);
    pending.set(key, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id: key, method, params }) + '\n');
  });
}
try {
  const validation = await request('plugins/validate', {
    workspace,
    source: packageRoot,
    pluginName: 'cmdr',
  });
  assert.equal(validation.ok, true, JSON.stringify(validation.diagnostics));
  assert.ok(existsSync(sessionDbPath), 'Runtime must open its database in the temporary directory');
  console.log('ZCode native plugin validation passed.');
  await request('plugins/marketplace/add', { workspace, source: packageRoot });
  const install = await request('plugins/install', {
    workspace,
    marketplace: 'cmdr',
    pluginName: 'cmdr',
    scope: 'workspace',
  });
  assert.equal(
    install.diagnostics.filter((d) => d.severity === 'error').length,
    0,
    JSON.stringify(install.diagnostics),
  );
  assert.ok(
    install.installedPlugins.find((p) => p.name === 'cmdr')?.installPath.startsWith(dir),
    'Plugin must be installed in the temporary runtime only',
  );
  const installedPath = install.installedPlugins.find((p) => p.name === 'cmdr').installPath;
  const integrity = JSON.parse(
    execFileSync(process.execPath, [join(installedPath, 'bin/cmdr-check.mjs'), installedPath], {
      encoding: 'utf8',
    }),
  );
  assert.equal(integrity.ok, true);
  const description = await request('plugins/describe', {
    workspace,
    marketplace: 'cmdr',
    pluginName: 'cmdr',
  });
  console.log(
    'ZCode discovered components:',
    description.components.map((c) => `${c.kind}=${c.items.length}`).join(', '),
  );
  renameSync(sourceRoot, join(dir, 'source-removed'));
  const result = await request('mcp/list', { workspace, mode: 'connect', mcpServers: [] });
  const status = result.statuses['plugin:cmdr:cmdr'];
  console.log('ZCode cmdr MCP status:', JSON.stringify(status));
  assert.ok(status, 'ZCode must discover the plugin MCP server');
  assert.equal(status.status, 'connected');
  assert.equal(status.toolCount, 7);
  console.log(
    'ZCode cached release passed integrity and connected to seven tools with the source directory removed. No model request was made.',
  );
} finally {
  for (const p of pending.values()) clearTimeout(p.timer);
  child.stdin.end();
  child.kill('SIGTERM');
  await new Promise((r) => {
    child.once('exit', r);
    setTimeout(r, 2000).unref();
  });
  const daemonInfo = join(dir, 'cmdr/daemon.json');
  if (existsSync(daemonInfo)) {
    try {
      process.kill(JSON.parse(readFileSync(daemonInfo, 'utf8')).pid, 'SIGTERM');
    } catch {}
  }
  await new Promise((r) => setTimeout(r, 100));
  rmSync(dir, { recursive: true, force: true });
}
