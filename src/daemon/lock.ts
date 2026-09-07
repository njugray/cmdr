import { closeSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
export function alive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === 'EPERM';
  }
}
export function acquireLock(path: string) {
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      let pid = 0;
      try {
        pid = Number(readFileSync(path, 'utf8'));
      } catch {
        /* race */
      }
      // An empty lock may be in the tiny open-to-write window; never steal it.
      if (alive(pid)) return false;
      if (!pid) {
        try {
          if (Date.now() - statSync(path).mtimeMs < 10000) return false;
        } catch {
          continue;
        }
      }
      rmSync(path, { force: true });
    }
  }
  return false;
}
export function releaseLock(path: string) {
  try {
    if (Number(readFileSync(path, 'utf8')) === process.pid) rmSync(path, { force: true });
  } catch {
    /* already gone */
  }
}
