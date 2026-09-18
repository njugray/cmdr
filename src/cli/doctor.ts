import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { quickCall } from '../shared/client.js';
import { diagnosticStatus } from '../shared/diagnostics.js';
import { schemas } from '../shared/schemas.js';
const exec = promisify(execFile);
export async function inspectInstallation(root: string) {
  // Run the check shipped with this intact installation against the selected target.
  const checker = new URL('../bin/cmdr-check.mjs', import.meta.url);
  try {
    return JSON.parse(
      (await exec(process.execPath, [fileURLToPath(checker), root], { timeout: 5000 })).stdout,
    );
  } catch (e: any) {
    try {
      return JSON.parse(e.stdout);
    } catch {
      return {
        ok: false,
        plugin_root: root,
        errors: ['Installation checker unavailable or timed out; reinstall cmdr-mcp.'],
      };
    }
  }
}
export async function probeMcp(root: string) {
  const home = mkdtempSync(join(tmpdir(), 'cmdr-doctor-'));
  const child = spawn(join(root, 'bin/cmdr-mcp'), [], {
    env: { ...process.env, CMDR_HOME: home, CMDR_AGENT: 'generic', CMDR_SESSION_ID: 'doctor' },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let requestId = 0;
  let closed = false;
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const fail = () => {
    closed = true;
    for (const p of pending.values())
      p.reject(new Error('MCP process exited before completing handshake'));
    pending.clear();
  };
  child.on('error', fail);
  child.on('exit', fail);
  child.stdin.on('error', fail);
  lines.on('line', (line) => {
    try {
      const m = JSON.parse(line);
      const p = pending.get(m.id);
      if (p) {
        pending.delete(m.id);
        m.error ? p.reject(new Error('MCP rejected handshake')) : p.resolve(m.result);
      }
    } catch {
      fail();
    }
  });
  const request = (method: string, params: unknown) =>
    new Promise<any>((resolve, reject) => {
      if (closed || child.exitCode !== null || child.signalCode !== null) {
        reject(new Error('MCP exited'));
        return;
      }
      const id = ++requestId;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      (async () => {
        await request('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'cmdr-doctor', version: '1' },
        });
        child.stdin.write(
          JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
        );
        const result = await request('tools/list', {});
        const names = result.tools?.map((t: any) => t.name).sort();
        if (JSON.stringify(names) !== JSON.stringify(Object.keys(schemas).sort()))
          throw new Error('Unexpected cmdr tool set');
        // A successful tool call checks daemon availability as well as tool registration.
        const call = await request('tools/call', { name: 'list', arguments: {} });
        if (call.isError) throw new Error('MCP tool cannot reach daemon');
        return { ok: true, tools: names, isolated: true };
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('MCP probe timed out after 8 seconds')), 8000);
      }),
    ]);
  } catch (e: any) {
    return { ok: false, error: e.message, isolated: true };
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const t = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 1000);
      child.once('close', () => {
        clearTimeout(t);
        resolve();
      });
    });
    lines.close();
    fail();
    try {
      await quickCall('admin.shutdown', { reason: 'doctor' }, { home, timeout: 1000 });
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
    rmSync(home, { recursive: true, force: true });
  }
}
export { diagnosticStatus };
