// Build exactly as npm pack/publish would, then verify the dependency-free tarball.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync, existsSync, cpSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const run = promisify(execFile);
const dir = mkdtempSync(join(tmpdir(), 'cmdr-package-'));
const prefix = join(dir, 'install');
const env = {
  ...process.env,
  CMDR_HOME: join(dir, 'state'),
  CMDR_AGENT: 'generic',
  CMDR_SESSION_ID: 'package-smoke',
  npm_config_cache: join(dir, 'npm-cache'),
  npm_config_offline: 'true',
  npm_config_update_notifier: 'false',
};
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
let client;
const cli = join(prefix, 'bin/cmdr');
try {
  // Do not use --ignore-scripts here: verify that prepack builds the runtime.
  const packed = await run('npm', ['pack', '--json', '--pack-destination', dir], {
    env,
    maxBuffer: 2 * 1024 * 1024,
  });
  const [pack] = JSON.parse(packed.stdout);
  assert.equal(pack.name, pkg.name);
  assert.equal(pack.version, pkg.version);
  const files = new Set(pack.files.map((file) => file.path));
  for (const name of ['cli', 'mcp', 'hook', 'daemon'])
    assert.ok(files.has(`plugins/cmdr/dist/${name}.mjs`), `Missing ${name} bundle`);
  for (const path of [
    'LICENSE',
    'README.md',
    'plugins/cmdr/THIRD_PARTY_NOTICES.txt',
    '.agents/plugins/marketplace.json',
    '.claude-plugin/marketplace.json',
    'marketplace.json',
    'plugins/cmdr/.zcode-plugin/plugin.json',
    'plugins/cmdr/.kimi-plugin/plugin.json',
    'plugins/cmdr/skills/cmdr/SKILL.md',
    'plugins/cmdr/skills/cmdr/references/setup.md',
    'plugins/cmdr/skills/cmdr/references/commander.md',
    'plugins/cmdr/skills/cmdr/references/executor.md',
    'plugins/cmdr/dist/dashboard/index.html',
    'plugins/cmdr/dist/dashboard/app.js',
    'plugins/cmdr/dist/dashboard/app.css',
  ])
    assert.ok(files.has(path), `Missing package asset: ${path}`);
  assert.ok(
    !pack.files.some((file) => /^(src|tests|node_modules)\//.test(file.path)),
    'Package should contain distribution files, not source, tests or node_modules',
  );
  await run(
    'npm',
    [
      'install',
      '--global',
      '--prefix',
      prefix,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--offline',
      join(dir, pack.filename),
    ],
    { env },
  );
  const installedRoot = join(prefix, 'lib/node_modules', pkg.name);
  const installed = JSON.parse(readFileSync(join(installedRoot, 'package.json'), 'utf8'));
  assert.equal(installed.name, 'cmdr-mcp');
  assert.equal(installed.version, pkg.version);
  assert.equal(installed.license, 'MIT');
  for (const path of [
    '.agents/plugins/marketplace.json',
    '.claude-plugin/marketplace.json',
    'marketplace.json',
  ]) {
    const marketplace = JSON.parse(readFileSync(join(installedRoot, path), 'utf8'));
    for (const plugin of marketplace.plugins) {
      const source = typeof plugin.source === 'string' ? plugin.source : plugin.source.path;
      assert.ok(existsSync(join(installedRoot, source)), `Missing installed plugin: ${source}`);
    }
  }
  assert.ok(
    !existsSync(join(prefix, 'lib/node_modules', pkg.name, 'node_modules')),
    'Runtime must not need external dependencies',
  );
  const pluginRoot = join(installedRoot, 'plugins/cmdr');
  const doctor = JSON.parse((await run(cli, ['doctor', '--deep'], { env, timeout: 15000 })).stdout);
  assert.equal(doctor.installation.ok, true);
  assert.equal(doctor.mcp.ok, true);
  const damaged = join(dir, 'damaged-plugin');
  cpSync(pluginRoot, damaged, { recursive: true });
  rmSync(join(damaged, 'dist/cli.mjs'));
  try {
    await run(join(damaged, 'bin/cmdr'), ['doctor'], { env });
    assert.fail('Damaged doctor must fail');
  } catch (e) {
    assert.equal(e.code, 1);
    assert.equal(JSON.parse(e.stdout).ok, false);
  }
  cpSync(pluginRoot, damaged, { recursive: true });
  writeFileSync(join(damaged, 'dist/mcp.mjs'), '// corrupted');
  try {
    await run(cli, ['doctor', '--plugin-root', damaged], { env });
    assert.fail('Corruption must fail');
  } catch (e) {
    assert.equal(e.code, 1);
    assert.equal(JSON.parse(e.stdout).installation.ok, false);
  }
  cpSync(pluginRoot, damaged, { recursive: true });
  assert.equal(
    JSON.parse((await run(cli, ['doctor', '--plugin-root', damaged], { env })).stdout).installation
      .ok,
    true,
  );
  const baseline = JSON.parse(readFileSync('scripts/package-size-baseline.json', 'utf8'));
  const sizeRatio = pack.size / baseline.compressed_bytes;
  console.log(
    `Package size: ${pack.size} bytes (${(sizeRatio * 100).toFixed(1)}% of ${baseline.version}); unpacked ${pack.unpackedSize}`,
  );
  if (sizeRatio > baseline.warn_ratio)
    console.warn(
      'Package grew beyond the review threshold; inspect bundle composition before release.',
    );
  const help = await run(cli, ['--help'], { env });
  assert.match(help.stdout, /cmdr status/);
  const transport = new StdioClientTransport({
    command: join(prefix, 'bin/cmdr-mcp'),
    env,
    stderr: 'pipe',
  });
  client = new Client({ name: 'package-smoke', version: '1.0.0' });
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 9);
  const result = await client.callTool({ name: 'list', arguments: {} });
  assert.ok(!result.isError);
  assert.equal(JSON.parse(result.content[0].text).me.sid, 'generic:package-smoke');
  // Exercise the documented one-command entry point from the real tarball,
  // entirely offline, then remove npx's cache and use only the persisted runtime.
  const setup = JSON.parse(
    (
      await run(
        'npx',
        [
          '--yes',
          '--offline',
          '--package',
          join(dir, pack.filename),
          'cmdr',
          'setup',
          '--agent',
          'claude-code',
          '--config-dir',
          join(dir, 'setup-host'),
          '--json',
        ],
        { env, cwd: dir, timeout: 30000 },
      )
    ).stdout,
  );
  assert.equal(setup.ok, true);
  assert.equal(setup.mcp.tools.length, 9);
  rmSync(join(dir, 'npm-cache'), { recursive: true, force: true });
  const persisted = JSON.parse(
    (await run(setup.cli, ['doctor', '--deep'], { env, timeout: 15000 })).stdout,
  );
  assert.equal(persisted.installation.ok, true);
  assert.equal(persisted.mcp.ok, true);
  const repeated = JSON.parse(
    (
      await run(
        setup.cli,
        ['setup', '--agent', 'claude-code', '--config-dir', join(dir, 'setup-host'), '--json'],
        { env, timeout: 15000 },
      )
    ).stdout,
  );
  assert.deepEqual(repeated.changed, []);
  // Use the persisted installation to restart and serve the bundled frontend.
  await client.close();
  client = undefined;
  await run(setup.cli, ['daemon', 'restart'], { env, timeout: 15000 });
  const dashboard = JSON.parse(
    (await run(setup.cli, ['dashboard', '--no-open'], { env, timeout: 15000 })).stdout,
  );
  assert.ok(dashboard.urls.includes(dashboard.url));
  const dashboardUrl = new URL(dashboard.url);
  assert.equal(dashboardUrl.hostname, '127.0.0.1');
  for (const url of dashboard.urls) {
    assert.equal(new URL(url).port, dashboardUrl.port);
    assert.notEqual(new URL(url).hostname, '0.0.0.0');
  }
  const html = await fetch(dashboardUrl.origin);
  assert.match(await html.text(), /app\.js/);
  const login = await fetch(`${dashboardUrl.origin}/api/session`, {
    method: 'POST',
    headers: { Origin: dashboardUrl.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: dashboardUrl.hash.slice(1) }),
  });
  assert.equal(login.status, 200);
  const state = await fetch(`${dashboardUrl.origin}/api/state`, {
    headers: { Cookie: login.headers.get('set-cookie').split(';')[0] },
  });
  assert.equal((await state.json()).home, env.CMDR_HOME);
  assert.equal((await fetch(`${dashboardUrl.origin}/app.css`)).status, 200);
  assert.equal((await fetch(`${dashboardUrl.origin}/app.js`)).status, 200);
  console.log(
    `npm package verified: ${pack.files.length} files, ${pack.size} compressed bytes; offline CLI, npx setup, repeat installation and nine MCP tools work after npx cache removal.`,
  );
} finally {
  await client?.close();
  if (existsSync(cli)) {
    try {
      await run(cli, ['daemon', 'stop'], { env, timeout: 3000 });
    } catch {}
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  rmSync(dir, { recursive: true, force: true });
}
