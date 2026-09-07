import { realpathSync } from 'node:fs';
import { dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
export function sessionCwd(
  cwd = process.cwd(),
  pluginRoot = dirname(dirname(fileURLToPath(import.meta.url))),
) {
  try {
    const dir = realpathSync(cwd),
      root = realpathSync(pluginRoot);
    return dir === '/' || dir === root || dir.startsWith(root + sep) ? null : cwd;
  } catch {
    return null;
  }
}
