import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

function fingerprint(path: string): string | null {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (e: any) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  if (stat.isSymbolicLink()) return `link:${readlinkSync(path)}`;
  if (stat.isDirectory())
    return `dir:${readdirSync(path)
      .sort()
      .map((name) => JSON.stringify([name, fingerprint(join(path, name))]))
      .join('')}`;
  if (!stat.isFile()) throw new Error(`Cannot replace non-file: ${path}`);
  return `file:${stat.mode}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

export type SetupChange = {
  path: string;
  before: string | null;
  content?: string;
  mode?: number;
  link?: string;
};

export function fileChange(path: string, content: string, mode?: number): SetupChange | undefined {
  const before = fingerprint(path);
  if (before !== null && !before.startsWith('file:'))
    throw new Error(`Expected a regular file at ${path}; no configuration was changed.`);
  if (
    before !== null &&
    readFileSync(path, 'utf8') === content &&
    (mode === undefined || (lstatSync(path).mode & 0o777) === mode)
  )
    return;
  return {
    path,
    before,
    content,
    mode: mode ?? (before === null ? 0o600 : lstatSync(path).mode & 0o777),
  };
}

export function skillChange(path: string, target: string): SetupChange | undefined {
  const before = fingerprint(path);
  if (before === `link:${target}`) return;
  if (before !== null) {
    let skill = '';
    try {
      skill = readFileSync(join(path, 'SKILL.md'), 'utf8');
    } catch {}
    if (
      !/^name: cmdr$/m.test(skill) ||
      !/^  source: https:\/\/github.com\/njugray\/cmdr$/m.test(skill)
    )
      throw new Error(
        `An unrelated or unreadable skill exists at ${path}. Move it before installing cmdr.`,
      );
  }
  return { path, before, link: target };
}

// Config is prepared and probed before this function. Backups live outside skill
// discovery paths, and rollback refuses to overwrite concurrent user edits.
export function applyChanges(changes: SetupChange[], backupRoot: string) {
  const run = join(backupRoot, `${Date.now()}-${randomUUID()}`);
  const applied: { change: SetupChange; backup?: string; after: string | null }[] = [];
  const backups: { path: string; backup: string | null }[] = [];
  try {
    for (const change of changes) {
      if (fingerprint(change.path) !== change.before)
        throw new Error(`Configuration changed during setup: ${change.path}. Retry setup.`);
    }
    for (const [index, change] of changes.entries()) {
      if (fingerprint(change.path) !== change.before)
        throw new Error(`Configuration changed during setup: ${change.path}. Retry setup.`);
      mkdirSync(dirname(change.path), { recursive: true, mode: 0o700 });
      const temporary = join(
        dirname(change.path),
        `.${basename(change.path)}.cmdr-${randomUUID()}`,
      );
      let backup: string | undefined;
      try {
        if (change.link) symlinkSync(change.link, temporary, 'dir');
        else writeFileSync(temporary, change.content!, { mode: change.mode, flag: 'wx' });
        if (change.before !== null) {
          mkdirSync(run, { recursive: true, mode: 0o700 });
          backup = join(run, `${index}-${basename(change.path)}`);
          cpSync(change.path, backup, {
            recursive: true,
            dereference: false,
            verbatimSymlinks: true,
          });
        }
        // Persist recovery information before a target is changed, including
        // newly created files. A killed setup can then be recovered manually.
        mkdirSync(run, { recursive: true, mode: 0o700 });
        backups.push({ path: change.path, backup: backup ?? null });
        writeFileSync(join(run, 'restore.json'), JSON.stringify(backups, null, 2) + '\n', {
          mode: 0o600,
        });
        if (change.before !== null) {
          // rename replaces regular files and symlinks atomically. Only an
          // adopted npx-skills copy needs its directory moved out of the way.
          if (lstatSync(change.path).isDirectory()) rmSync(change.path, { recursive: true });
        }
        const record = { change, backup, after: fingerprint(change.path) };
        applied.push(record);
        renameSync(temporary, change.path);
        record.after = fingerprint(change.path);
      } finally {
        rmSync(temporary, { force: true });
      }
    }
    return backups.length ? run : null;
  } catch (error) {
    const failures: string[] = [];
    for (const { change, backup, after } of applied.reverse()) {
      try {
        if (fingerprint(change.path) !== after) throw new Error('concurrent edit');
        rmSync(change.path, { recursive: true, force: true });
        if (backup)
          cpSync(backup, change.path, {
            recursive: true,
            dereference: false,
            verbatimSymlinks: true,
          });
      } catch {
        failures.push(change.path);
      }
    }
    if (existsSync(run))
      writeFileSync(join(run, 'restore.json'), JSON.stringify(backups, null, 2) + '\n', {
        mode: 0o600,
      });
    if (failures.length)
      throw new Error(`Setup failed. Restore these paths from ${run}: ${failures.join(', ')}`, {
        cause: error,
      });
    throw error;
  }
}
