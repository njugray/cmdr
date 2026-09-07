import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdirSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { safeSid } from './ids.js';
export function paths(home = process.env.CMDR_HOME || join(homedir(), '.cmdr')) {
  home = resolve(home);
  let socket = join(home, 'cmdr.sock');
  if (Buffer.byteLength(socket) > 100)
    socket = join(
      tmpdir(),
      `cmdr-${createHash('sha256').update(`${process.getuid?.()}:${home}`).digest('hex').slice(0, 20)}.sock`,
    );
  return {
    home,
    socket,
    db: join(home, 'cmdr.db'),
    lock: join(home, 'daemon.lock'),
    spawn: join(home, 'spawn.lock'),
    info: join(home, 'daemon.json'),
    flags: join(home, 'flags'),
    log: join(home, 'logs/daemon.log'),
    config: join(home, 'config.json'),
    flag: (sid: string) => join(home, 'flags', safeSid(sid)),
  };
}
export type Paths = ReturnType<typeof paths>;
export function prepare(p: Paths) {
  for (const dir of [p.home, p.flags, join(p.home, 'logs')]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
}
