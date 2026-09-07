import { execFileSync } from 'node:child_process';
export function ancestors(start = process.ppid): number[] {
  const result: number[] = [];
  let pid = start;
  for (let i = 0; i < 12 && pid > 1 && !result.includes(pid); i++) {
    result.push(pid);
    try {
      pid = Number(
        execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
          encoding: 'utf8',
          timeout: 100,
        }).trim(),
      );
    } catch {
      break;
    }
  }
  return result;
}
export function terminal() {
  let program = process.env.TERM_PROGRAM || '',
    tty = '';
  try {
    tty = execFileSync('ps', ['-o', 'tty=', '-p', String(process.ppid)], {
      encoding: 'utf8',
      timeout: 100,
    }).trim();
  } catch {
    /* GUI */
  }
  if (!program)
    for (const pid of ancestors()) {
      try {
        const command = execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], {
          encoding: 'utf8',
          timeout: 100,
        });
        const match = command.match(
          /(Zcode|ZCode|zcode|Codex|ChatGPT|Claude|iTerm2|Terminal|Code Helper|Warp)/,
        );
        if (match) {
          program = match[1];
          break;
        }
      } catch {
        /* optional */
      }
    }
  return {
    program: program || 'unknown',
    tty: tty === '??' ? null : tty,
    tmux_pane: process.env.TMUX_PANE || null,
    entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT || null,
    pid: process.ppid,
  };
}
