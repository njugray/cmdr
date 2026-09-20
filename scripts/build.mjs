import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { readFile, writeFile, mkdir, readdir, chmod, rm, copyFile } from 'node:fs/promises';
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
await mkdir('plugins/cmdr/dist', { recursive: true });
// The standalone skill owns the role protocol. Keep the existing plugin skill
// names as self-contained compatibility entries, generated from that source.
for (const role of ['commander', 'executor']) {
  const target = `plugins/cmdr/skills/cmdr-${role}/SKILL.md`;
  const current = await readFile(target, 'utf8');
  const frontmatter = current.match(/^---\n[\s\S]*?\n---\n/)[0];
  const reference = await readFile(`plugins/cmdr/skills/cmdr/references/${role}.md`, 'utf8');
  await writeFile(target, frontmatter + reference.replace(/^# [^\n]+\n\n/, ''));
}
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
await rm('plugins/cmdr/dist/dashboard', { recursive: true, force: true });
const frontend = await build({
  metafile: true,
  entryPoints: { app: 'src/dashboard/main.tsx' },
  outdir: 'plugins/cmdr/dist/dashboard',
  bundle: true,
  platform: 'browser',
  target: ['es2022'],
  format: 'esm',
  minify: true,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
});
await copyFile('src/dashboard/index.html', 'plugins/cmdr/dist/dashboard/index.html');
for (const entry of ['cli', 'mcp', 'hook', 'daemon'])
  await chmod(`plugins/cmdr/dist/${entry}.mjs`, 0o755);
for (const host of ['claude', 'codex', 'zcode', 'kimi']) {
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
for (const file of [
  ...Object.keys(result.metafile.inputs),
  ...Object.keys(frontend.metafile.inputs),
]) {
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

// Bind the complete plugin to one build. The checker deliberately lives outside dist.
const pluginRoot = 'plugins/cmdr';
const checksums = {};
async function collect(dir = '') {
  for (const entry of await readdir(`${pluginRoot}/${dir}`, { withFileTypes: true })) {
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await collect(path);
    else if (path !== 'dist/integrity.json' && path !== 'README.md') {
      checksums[path] = createHash('sha256')
        .update(await readFile(`${pluginRoot}/${path}`))
        .digest('hex');
    }
  }
}
await collect();
await writeFile(
  `${pluginRoot}/dist/integrity.json`,
  JSON.stringify({ version: pkg.version, files: checksums }, null, 2) + '\n',
);
const sizes = Object.fromEntries(
  await Promise.all(
    ['cli', 'mcp', 'hook', 'daemon'].map(async (name) => [
      name,
      (await readFile(`${pluginRoot}/dist/${name}.mjs`)).length,
    ]),
  ),
);
console.error('Bundle bytes:', JSON.stringify(sizes));
