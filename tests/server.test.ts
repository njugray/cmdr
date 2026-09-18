import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDaemon } from '../src/daemon/server.js';
import { daemonConnection } from '../src/shared/client.js';
import { paths } from '../src/shared/paths.js';

it('logs unexpected request failures with their stack while clients see INTERNAL_ERROR', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cmdr-server-')),
    umask = process.umask();
  const daemon = (await startDaemon(home))!;
  try {
    const rpc = await daemonConnection({ home });
    try {
      await expect(rpc.request('admin.status')).rejects.toMatchObject({
        code: 'ROLE_NOT_ALLOWED',
      });
      daemon.core.handle = async () => {
        throw new TypeError('boom');
      };
      await expect(rpc.request('session.list')).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    } finally {
      rpc.close();
    }
    const log = readFileSync(paths(home).log, 'utf8');
    expect(log.match(/internal error in /g)).toHaveLength(1);
    expect(log).toContain('internal error in session.list: TypeError: boom');
    expect(log).toMatch(/\n\s+at /);
  } finally {
    await daemon.stop();
    // startDaemon sets the process umask; restore it for later tests in this worker.
    process.umask(umask);
    rmSync(home, { recursive: true, force: true });
  }
});
