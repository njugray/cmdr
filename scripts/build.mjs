import { build } from 'esbuild';
import { readFile, writeFile, mkdir, readdir, chmod } from 'node:fs/promises';
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
await mkdir('plugins/cmdr/dist', { recursive: true });
const result = await build({
  metafile: true,
  entryPoints: {
    daemon: 'src/daemon/main.ts',
    mcp: 'src/mcp/main.ts',
    hook: 'src/hook/main.ts',
    cli: 'src/cli/main.ts',
  },
  outdir: 'plugins/cmdr/dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node22.5',
  format: 'esm',
  legalComments: 'none',
  banner: {
    js: '#!/usr/bin/env -S node --experimental-sqlite --disable-warning=ExperimentalWarning\nimport { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
  define: { __VERSION__: JSON.stringify(pkg.version) },
});
for (const entry of ['cli', 'mcp', 'hook', 'daemon'])
  await chmod(`plugins/cmdr/dist/${entry}.mjs`, 0o755);
for (const host of ['claude', 'codex', 'zcode']) {
  const path = `plugins/cmdr/.${host}-plugin/plugin.json`,
    manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.version = pkg.version;
  await writeFile(path, JSON.stringify(manifest, null, 2) + '\n');
}

for (const path of ['marketplace.json', '.claude-plugin/marketplace.json']) {
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  for (const plugin of manifest.plugins) if (plugin.name === 'cmdr') plugin.version = pkg.version;
  await writeFile(path, JSON.stringify(manifest, null, 2) + '\n');
}

// Bundled runtime dependencies must retain their license notices.
const packages = new Set();
for (const file of Object.keys(result.metafile.inputs)) {
  const match = file.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
  if (match) packages.add(match[1]);
}
const notices = [];
for (const name of [...packages].sort()) {
  const dir = `node_modules/${name}`;
  const info = JSON.parse(await readFile(`${dir}/package.json`, 'utf8'));
  const files = (await readdir(dir)).filter((file) =>
    /^(license|licence|copying|notice)(\.|$)/i.test(file),
  );
  notices.push(
    `${name} ${info.version} (${info.license || 'see package'})\n${files.length ? (await Promise.all(files.map((file) => readFile(`${dir}/${file}`, 'utf8')))).join('\n') : 'See the upstream package for license terms.'}`,
  );
}
await writeFile(
  'plugins/cmdr/THIRD_PARTY_NOTICES.txt',
  notices.join('\n\n' + '='.repeat(72) + '\n\n') + '\n',
);
