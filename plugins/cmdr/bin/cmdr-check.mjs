#!/usr/bin/env node
// Kept outside dist so a damaged runtime can still be inspected with Node alone.
import { readFileSync, existsSync, lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve(process.argv[2]);
const errors = [];
const read = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
let manifest;
try {
  manifest = read('dist/integrity.json');
} catch {
  errors.push(
    'Missing or invalid dist/integrity.json; reinstall this plugin from the built npm package.',
  );
}
const files = {};
const required = [
  'dist/cli.mjs',
  'dist/mcp.mjs',
  'dist/hook.mjs',
  'dist/daemon.mjs',
  'bin/cmdr',
  'bin/cmdr-node',
  'bin/cmdr-mcp',
  'bin/cmdr-hook',
  'bin/cmdr-daemon',
  'bin/cmdr-check.mjs',
  'hooks/hooks.json',
  '.mcp.json',
  '.claude-plugin/plugin.json',
  '.codex-plugin/plugin.json',
  '.zcode-plugin/plugin.json',
];
for (const path of new Set([...required, ...Object.keys(manifest?.files || {})])) {
  if (
    !required.includes(path) &&
    !path.startsWith('skills/') &&
    !path.startsWith('commands/') &&
    path !== 'THIRD_PARTY_NOTICES.txt'
  ) {
    errors.push(`Unexpected manifest path: ${path}`);
    continue;
  }
  if (path.split('/').some((part) => part === '..' || part === '')) {
    errors.push('Invalid manifest path');
    continue;
  }
  try {
    const full = join(root, path);
    const linked = path
      .split('/')
      .some((_, i, parts) => lstatSync(join(root, ...parts.slice(0, i + 1))).isSymbolicLink());
    const digest = createHash('sha256').update(readFileSync(full)).digest('hex');
    files[path] = !linked && manifest?.files?.[path] === digest;
  } catch {
    files[path] = false;
  }
  if (!files[path]) errors.push(`Missing, modified or linked asset: ${path}`);
}
const versions = {};
for (const host of ['claude', 'codex', 'zcode']) {
  try {
    versions[host] = read(`.${host}-plugin/plugin.json`).version;
    if (versions[host] !== manifest?.version) errors.push(`${host} version differs from build`);
  } catch {
    errors.push(`Invalid ${host} manifest`);
  }
}
let hooks = {};
try {
  hooks = read('hooks/hooks.json').hooks;
} catch {
  errors.push('Invalid hooks configuration');
}
console.log(
  JSON.stringify(
    {
      ok: errors.length === 0,
      plugin_root: root,
      version: manifest?.version,
      node: process.version,
      files,
      versions,
      hooks: {
        configured: Object.keys(hooks || {}),
        observed: 'unknown; configuration alone does not prove execution',
      },
      errors,
      repair:
        'npm install -g cmdr-mcp; register its package root, then refresh/reinstall the host plugin cache and start a new session. For a source checkout run npm ci && npm run build at repository root. Do not link dist from another installation.',
    },
    null,
    2,
  ),
);
process.exitCode = errors.length ? 1 : 0;
