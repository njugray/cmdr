// Build exactly as npm pack/publish would, then verify the dependency-free tarball.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
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
  const files = new Set(pack.files.map((file) => file.path));
  for (const name of ['cli', 'mcp', 'hook', 'daemon'])
    assert.ok(files.has(`plugins/cmdr/dist/${name}.mjs`), `Missing ${name} bundle`);
  for (const path of [
    'plugins/cmdr/THIRD_PARTY_NOTICES.txt',
    '.agents/plugins/marketplace.json',
    '.claude-plugin/marketplace.json',
    'marketplace.json',
    'plugins/cmdr/.zcode-plugin/plugin.json',
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
  assert.ok(
    !existsSync(join(prefix, 'lib/node_modules', pkg.name, 'node_modules')),
    'Runtime must not need external dependencies',
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
  assert.equal((await client.listTools()).tools.length, 7);
  const result = await client.callTool({ name: 'list', arguments: {} });
  assert.ok(!result.isError);
  assert.equal(JSON.parse(result.content[0].text).me.sid, 'generic:package-smoke');
  console.log(
    `npm package verified: ${pack.files.length} files, ${pack.size} compressed bytes; offline CLI and seven MCP tools work.`,
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
