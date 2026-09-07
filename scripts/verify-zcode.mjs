// Optional smoke test against an installed ZCode desktop runtime; no model calls.
// All plugin state and the test workspace are isolated under a temporary directory.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
const runtime =
  process.env.ZCODE_RUNTIME_PATH || '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';
if (!existsSync(runtime))
  throw new Error('Set ZCODE_RUNTIME_PATH to the installed desktop app’s glm/zcode.cjs.');
const dir = mkdtempSync(join(tmpdir(), 'cmdr-zcode-'));
const workspace = { workspacePath: dir, workspaceKey: 'cmdr-smoke' };
mkdirSync(join(dir, '.zcode'));
writeFileSync(
  join(dir, '.zcode/config.json'),
  JSON.stringify({
    storage: { dir: join(dir, 'zcode') },
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
    source: resolve('.'),
    pluginName: 'cmdr',
  });
  assert.equal(validation.ok, true, JSON.stringify(validation.diagnostics));
  console.log('ZCode native plugin validation passed.');
  await request('plugins/marketplace/add', { workspace, source: resolve('.') });
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
  const description = await request('plugins/describe', {
    workspace,
    marketplace: 'cmdr',
    pluginName: 'cmdr',
  });
  console.log(
    'ZCode discovered components:',
    description.components.map((c) => `${c.kind}=${c.items.length}`).join(', '),
  );
  const result = await request('mcp/list', { workspace, mode: 'connect', mcpServers: [] });
  const status = result.statuses['plugin:cmdr:cmdr'];
  console.log('ZCode cmdr MCP status:', JSON.stringify(status));
  assert.ok(status, 'ZCode must discover the plugin MCP server');
  assert.equal(status.status, 'connected');
  assert.equal(status.toolCount, 7);
  console.log(
    'ZCode desktop runtime connected to all seven cmdr tools. No model request was made.',
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
