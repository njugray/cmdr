#!/usr/bin/env -S node --experimental-sqlite --disable-warning=ExperimentalWarning
import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);

// src/shared/diagnostics.ts
import { mkdirSync as mkdirSync2, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join as join2 } from "node:path";
import { randomUUID } from "node:crypto";

// src/shared/paths.ts
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";

// src/shared/ids.ts
var safeSid = (sid) => Buffer.from(sid).toString("base64url");

// src/shared/paths.ts
function paths(home = process.env.CMDR_HOME || join(homedir(), ".cmdr")) {
  home = resolve(home);
  let socket = join(home, "cmdr.sock");
  if (Buffer.byteLength(socket) > 100)
    socket = join(
      tmpdir(),
      `cmdr-${createHash("sha256").update(`${process.getuid?.()}:${home}`).digest("hex").slice(0, 20)}.sock`
    );
  return {
    home,
    socket,
    db: join(home, "cmdr.db"),
    lock: join(home, "daemon.lock"),
    spawn: join(home, "spawn.lock"),
    info: join(home, "daemon.json"),
    flags: join(home, "flags"),
    log: join(home, "logs/daemon.log"),
    config: join(home, "config.json"),
    flag: (sid) => join(home, "flags", safeSid(sid))
  };
}
function prepare(p) {
  for (const dir of [p.home, p.flags, join(p.home, "logs")]) {
    mkdirSync(dir, { recursive: true, mode: 448 });
    chmodSync(dir, 448);
  }
}

// src/shared/diagnostics.ts
var events = ["SessionStart", "UserPromptSubmit", "PreToolUse", "Stop", "SessionEnd"];
function diagnostic(code, detail = {}, home) {
  const dir = join2(paths(home).home, "logs/diagnostics");
  const file = join2(dir, `${code}.json`);
  let temp;
  try {
    const previous = JSON.parse(readFileSync(file, "utf8"));
    if (Date.now() - previous.at < 1e4) return;
  } catch {
  }
  try {
    mkdirSync2(dir, { recursive: true, mode: 448 });
    temp = `${file}.${randomUUID()}.tmp`;
    const allowed = Object.fromEntries(
      Object.entries(detail).filter(([k]) => ["agent", "event", "from", "to", "protocol"].includes(k)).map(([k, v]) => [
        k,
        String(v).replace(/[^a-zA-Z0-9_.:-]/g, "").slice(0, 80)
      ])
    );
    writeFileSync(temp, JSON.stringify({ code, at: Date.now(), ...allowed }), { mode: 384 });
    renameSync(temp, file);
  } catch {
  } finally {
    if (temp) {
      try {
        rmSync(temp, { force: true });
      } catch {
      }
    }
  }
}
function observedHook(event, agent) {
  if (events.includes(event))
    diagnostic(`hook-${event}`, { event, agent });
}

// src/hook/main.ts
import { existsSync } from "node:fs";

// src/shared/env.ts
var cmdrTool = /(?:^|[_:])cmdr(?:__|:)(list|join|report|leave|ask|send|read)$/;
function detectAgent(env = process.env, hook) {
  if (env.CMDR_AGENT && /^[a-z][a-z0-9_-]{0,63}$/.test(env.CMDR_AGENT)) return env.CMDR_AGENT;
  if (env.ZCODE_PLUGIN_ROOT || env.ZCODE_PLUGIN_ID) return "zcode";
  if (env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_CODE_ENTRYPOINT) return "claude";
  if (hook?.transcript_path && String(hook.transcript_path).includes("/.claude/")) return "claude";
  if (env.CODEX_HOME || env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || hook?.turn_id)
    return "codex";
  return "generic";
}

// src/shared/client.ts
import { connect } from "node:net";
import { spawn } from "node:child_process";
import { dirname, join as join3 } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync as mkdirSync3, readFileSync as readFileSync2, rmSync as rmSync2, statSync } from "node:fs";

// src/daemon/lock.ts
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

// src/shared/rpc.ts
import { EventEmitter } from "node:events";

// src/shared/protocol.ts
var LIMITS = {
  maxWaitSec: 300,
  maxBody: 32768,
  maxData: 65536,
  maxFrame: 2 * 1024 * 1024
};
var CmdrError = class extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
};

// src/shared/rpc.ts
var Rpc = class extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > LIMITS.maxFrame) {
        socket.destroy();
        return;
      }
      let at;
      while ((at = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, at);
        this.buffer = this.buffer.slice(at + 1);
        if (line.trim()) void this.receive(line);
      }
    });
    socket.on("error", () => {
    });
    socket.on("close", () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.cleanup();
        p.reject(new CmdrError("DAEMON_UNAVAILABLE"));
      }
      this.pending.clear();
      for (const c of this.active.values()) c.abort();
      this.active.clear();
      this.emit("close");
    });
  }
  buffer = "";
  next = 1;
  pending = /* @__PURE__ */ new Map();
  active = /* @__PURE__ */ new Map();
  handler;
  async receive(line) {
    let m;
    try {
      m = JSON.parse(line);
      if (!m || m.jsonrpc !== "2.0" || Array.isArray(m)) throw new Error();
    } catch {
      this.send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Invalid JSON-RPC frame" }
      });
      return;
    }
    if (typeof m.method === "string") {
      if (m.id === void 0) {
        if (m.method === "rpc.cancel") this.active.get(m.params?.id)?.abort();
        else this.emit("notification", m.method, m.params);
        return;
      }
      const controller = new AbortController();
      this.active.set(m.id, controller);
      try {
        const result = await this.handler?.(m.method, m.params || {}, controller.signal);
        this.send({ jsonrpc: "2.0", id: m.id, result: result ?? null });
      } catch (e) {
        this.send({
          jsonrpc: "2.0",
          id: m.id,
          error: {
            code: e instanceof CmdrError ? -32e3 : -32603,
            message: e instanceof CmdrError ? e.message : "Internal daemon error",
            data: { code: e instanceof CmdrError ? e.code : "INTERNAL_ERROR" }
          }
        });
      } finally {
        this.active.delete(m.id);
      }
    } else if (this.pending.has(m.id)) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      p.cleanup();
      if (m.error) p.reject(new CmdrError(m.error.data?.code || "RPC_ERROR", m.error.message));
      else p.resolve(m.result);
    }
  }
  send(value) {
    if (!this.socket.destroyed && this.socket.writable)
      this.socket.write(JSON.stringify(value) + "\n");
  }
  request(method, params = {}, timeout = 5e3, signal) {
    if (this.socket.destroyed) return Promise.reject(new CmdrError("DAEMON_UNAVAILABLE"));
    if (signal?.aborted) return Promise.reject(new CmdrError("REQUEST_CANCELLED"));
    return new Promise((resolve2, reject) => {
      const id = this.next++;
      const cancel = (code) => {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.cleanup();
        this.notify("rpc.cancel", { id });
        reject(new CmdrError(code));
      };
      const abort = () => cancel("REQUEST_CANCELLED");
      const timer2 = setTimeout(() => cancel("DAEMON_UNAVAILABLE"), timeout);
      this.pending.set(id, {
        resolve: resolve2,
        reject,
        timer: timer2,
        cleanup: () => signal?.removeEventListener("abort", abort)
      });
      signal?.addEventListener("abort", abort, { once: true });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }
  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }
  close() {
    this.socket.destroy();
  }
};

// src/shared/version.ts
var VERSION = true ? "0.4.0" : MIN_CLIENT_VERSION;
var PROTOCOL = 1;
function newer(a, b) {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] > y[i];
  }
  return false;
}

// src/shared/client.ts
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function dial(p, timeout = 1e3) {
  return new Promise((resolve2, reject) => {
    const socket = connect(p.socket);
    const timer2 = setTimeout(() => socket.destroy(new Error("connect timeout")), timeout);
    socket.once("error", (e) => {
      clearTimeout(timer2);
      reject(e);
    });
    socket.once("connect", () => {
      clearTimeout(timer2);
      resolve2(new Rpc(socket));
    });
  });
}
async function daemonConnection(options = {}) {
  const p = paths(options.home), timeout = options.timeout || 1e3;
  if (options.start) prepare(p);
  let owner = false, spawned = false;
  try {
    for (let attempt = 0; attempt < (options.start ? 65 : 1); attempt++) {
      let rpc;
      try {
        rpc = await dial(p, timeout);
        const hello = await rpc.request(
          "hello",
          { client: "cmdr", version: VERSION, protocol: PROTOCOL },
          timeout
        );
        if (options.upgrade && newer(VERSION, hello.version)) {
          diagnostic(
            "upgrade",
            { from: hello.version, to: VERSION, protocol: hello.protocol },
            options.home
          );
          throw new CmdrError(
            "UPGRADE_REQUIRED",
            `Daemon ${hello.version} is older than client ${VERSION}. Run cmdr daemon restart from this installation; automatic replacement is disabled to protect live sessions.`
          );
        }
        return rpc;
      } catch (e) {
        rpc?.close();
        if (e.code === "PROTOCOL_MISMATCH" || e.code === "UPGRADE_REQUIRED" || !options.start)
          throw e;
      }
      if (!owner) {
        try {
          mkdirSync3(p.spawn, { mode: 448 });
          owner = true;
        } catch {
          try {
            if (Date.now() - statSync(p.spawn).mtimeMs > 1e4)
              rmSync2(p.spawn, { recursive: true, force: true });
          } catch {
          }
        }
      }
      let daemonOwnsLock = false;
      try {
        daemonOwnsLock = alive(Number(readFileSync2(p.lock, "utf8")));
      } catch {
      }
      if (owner && !daemonOwnsLock) {
        if (attempt === 0 || !spawned) {
          const child = spawn(
            process.execPath,
            ["--experimental-sqlite", join3(dirname(fileURLToPath(import.meta.url)), "daemon.mjs")],
            { detached: true, stdio: "ignore", env: { ...process.env, CMDR_HOME: p.home } }
          );
          child.on("error", () => {
          });
          child.unref();
          spawned = true;
        }
      }
      await sleep(50);
    }
  } finally {
    if (owner) rmSync2(p.spawn, { recursive: true, force: true });
    spawned = false;
  }
  throw new CmdrError("DAEMON_UNAVAILABLE", "Cannot start cmdr daemon. Run cmdr doctor.");
}
async function quickCall(method, params = {}, options = {}) {
  const rpc = await daemonConnection({ ...options, upgrade: !!options.start });
  try {
    if (options.kind !== "hook")
      await rpc.request("session.register", { kind: "cli" }, options.timeout || 5e3);
    return await rpc.request(method, params, options.timeout || 5e3);
  } finally {
    rpc.close();
  }
}

// src/mcp/terminal.ts
import { execFileSync } from "node:child_process";
function ancestors(start = process.ppid) {
  const result = [];
  let pid = start;
  for (let i = 0; i < 12 && pid > 1 && !result.includes(pid); i++) {
    result.push(pid);
    try {
      pid = Number(
        execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
          encoding: "utf8",
          timeout: 100
        }).trim()
      );
    } catch {
      break;
    }
  }
  return result;
}

// src/hook/main.ts
async function runHook(input, event = input.hook_event_name) {
  const agent = detectAgent(process.env, input), sid = `${agent}:${input.session_id}`;
  observedHook(event, agent);
  if (!input.session_id) return;
  if (process.env.CMDR_SESSION_ID && process.env.CMDR_SESSION_ID !== input.session_id) {
    diagnostic("identity-conflict", { agent });
    return;
  }
  if (event === "PreToolUse" && cmdrTool.test(input.tool_name || "")) {
    if (agent !== "claude")
      return {
        hookSpecificOutput: {
          hookEventName: event,
          permissionDecision: "allow",
          updatedInput: { ...input.tool_input, _cmdr_session: input.session_id }
        }
      };
    return;
  }
  if (event === "PreToolUse" && !existsSync(paths().flag(sid))) return;
  const result = await quickCall(
    "hook.event",
    {
      ...input,
      event,
      agent,
      ...event === "SessionStart" ? { ancestors: ancestors(), host_pid: process.ppid } : {}
    },
    { kind: "hook", timeout: 100 }
  );
  if (event === "SessionEnd") return;
  if (result.block) return { decision: "block", reason: result.reason };
  if (result.inject)
    return { hookSpecificOutput: { hookEventName: event, additionalContext: result.inject } };
}
var timer = setTimeout(() => process.exit(0), 450);
try {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 2 * 1024 * 1024) throw new Error("large input");
  }
  const result = await runHook(JSON.parse(input), process.argv[2]);
  if (result) process.stdout.write(JSON.stringify(result) + "\n");
} catch (e) {
  diagnostic(e.code === "DAEMON_UNAVAILABLE" ? "hook-unavailable" : "hook-error");
}
clearTimeout(timer);
export {
  runHook
};
