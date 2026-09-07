import { appendFileSync, existsSync, renameSync, rmSync, statSync } from 'node:fs';
export function logger(path: string) {
  return (message: string) => {
    try {
      if (existsSync(path) && statSync(path).size > 5 * 1024 * 1024) {
        rmSync(`${path}.5`, { force: true });
        for (let i = 4; i >= 1; i--)
          if (existsSync(`${path}.${i}`)) renameSync(`${path}.${i}`, `${path}.${i + 1}`);
        renameSync(path, `${path}.1`);
      }
      appendFileSync(path, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
    } catch {
      /* logging cannot break IPC */
    }
  };
}
