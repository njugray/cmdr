// Stage the exact npm distribution for the generated marketplace branch.
// The destination must not exist; source and installed user caches are never modified.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const destination = process.argv[2];
if (!destination) throw new Error('Usage: node scripts/prepare-marketplace.mjs NEW_DIRECTORY');
const output = resolve(destination);
mkdirSync(output); // Refuse to overwrite an existing directory.
const temporary = mkdtempSync(join(tmpdir(), 'cmdr-marketplace-'));
try {
  const [pack] = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--pack-destination', temporary], {
      encoding: 'utf8',
      env: {
        ...process.env,
        npm_config_cache: join(temporary, 'npm-cache'),
        npm_config_offline: 'true',
      },
    }),
  );
  execFileSync('tar', [
    '-xzf',
    join(temporary, pack.filename),
    '-C',
    output,
    '--strip-components=1',
  ]);
  const plugin = join(output, 'plugins/cmdr');
  const integrity = JSON.parse(
    execFileSync(process.execPath, [join(plugin, 'bin/cmdr-check.mjs'), plugin], {
      encoding: 'utf8',
    }),
  );
  assert.equal(integrity.ok, true, JSON.stringify(integrity));
  console.log(`Marketplace ready: ${output} (${pack.name}@${pack.version})`);
} catch (error) {
  rmSync(output, { recursive: true, force: true });
  throw error;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
