// pi-mvm-agent: tiny HTTP agent that runs inside the Lambda MicroVM.
//
// Port 8080 (public, behind the Lambda MicroVM HTTPS proxy + JWE auth):
//   GET  /health
//   POST /exec            {command, cwd, env, timeoutSec}  -> SSE stream of {o: base64} / {hb} / {exit} / {error}
//   GET  /fs/read?path=   -> raw bytes
//   POST /fs/write?path=&offset=N  (raw body)  -> mkdir -p + write at offset (0 = truncate)
//   POST /fs/mkdir?path=
//   GET  /fs/stat?path=   -> {type, size, mtimeMs}
//   GET  /fs/readdir?path=-> [names]
//   POST /fs/untar?src=&dest=&remove=1  -> tar xzf src -C dest
//   GET  /fs/tar?path=    -> tar.gz stream of path
//
// Port 9000 (lifecycle hooks, never included in client auth tokens):
//   /aws/lambda-microvms/runtime/v1/{ready,validate,run,resume,suspend,terminate}
//
// Defense in depth: besides the Lambda-managed JWE token, every request on 8080 must carry
// the per-MicroVM secret delivered via the /run hook payload (x-mvm-secret header).

"use strict";
const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const API_PORT = Number(process.env.MVM_API_PORT || 8080);
const HOOK_PORT = Number(process.env.MVM_HOOK_PORT || 9000);
const WORKSPACE = process.env.MVM_WORKSPACE || "/workspace";
const SHELL = fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";

let secret = null; // set by the /run hook
let microvmId = null;

fs.mkdirSync(WORKSPACE, { recursive: true });

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", "content-length": data.length });
  res.end(data);
}

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function resolvePath(p) {
  if (!p) return WORKSPACE;
  return path.resolve(WORKSPACE, p);
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function errStatus(err) {
  if (err && err.status) return err.status;
  switch (err && err.code) {
    case "ENOENT":
      return 404;
    case "EACCES":
    case "EPERM":
      return 403;
    case "EISDIR":
    case "ENOTDIR":
      return 400;
    default:
      return 500;
  }
}

// ---------------------------------------------------------------------------
// exec
// ---------------------------------------------------------------------------

function handleExec(req, res, body) {
  const { command, cwd, env, timeoutSec } = JSON.parse(body.toString("utf8") || "{}");
  if (typeof command !== "string") return json(res, 400, { error: "command required" });
  const workdir = resolvePath(cwd);
  if (!fs.existsSync(workdir)) return json(res, 400, { error: `Working directory does not exist: ${workdir}` });

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    "x-accel-buffering": "no",
  });
  const send = (obj) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  const child = spawn(SHELL, ["-lc", command], {
    cwd: workdir,
    env: { ...process.env, HOME: process.env.HOME || "/root", ...(env || {}) },
    detached: true, // own process group so we can kill the whole tree
    stdio: ["ignore", "pipe", "pipe"],
  });

  let finished = false;
  const killTree = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  };
  const onData = (chunk) => send({ o: chunk.toString("base64") });
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  // Heartbeats keep the proxy connection (and the MicroVM idle timer) alive during quiet commands.
  const hb = setInterval(() => send({ hb: Date.now() }), 10_000);
  let timer;
  let timedOut = false;
  if (timeoutSec && timeoutSec > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutSec * 1000);
  }

  const finish = (obj) => {
    if (finished) return;
    finished = true;
    clearInterval(hb);
    if (timer) clearTimeout(timer);
    send(obj);
    res.end();
  };

  child.on("error", (err) => finish({ error: String(err && err.message ? err.message : err) }));
  child.on("close", (code, signal) => {
    if (timedOut) return finish({ timeout: true, exit: null });
    const exit = code !== null ? code : signal ? 128 + (require("node:os").constants.signals[signal] || 0) : null;
    finish({ exit });
  });
  // Client went away (abort / timeout on the pi side): kill the process tree.
  res.on("close", () => {
    if (!finished) {
      finished = true;
      clearInterval(hb);
      if (timer) clearTimeout(timer);
      killTree();
    }
  });
}

// ---------------------------------------------------------------------------
// filesystem
// ---------------------------------------------------------------------------

async function handleFs(req, res, url) {
  const op = url.pathname.slice("/fs/".length);
  const p = resolvePath(url.searchParams.get("path"));

  if (op === "read" && req.method === "GET") {
    const st = await fsp.stat(p);
    if (st.isDirectory()) throw Object.assign(new Error(`Is a directory: ${p}`), { status: 400 });
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": st.size });
    fs.createReadStream(p).pipe(res);
    return;
  }
  if (op === "write" && req.method === "POST") {
    // ?offset=N writes at byte offset N (offset 0 / absent truncates first). Idempotent and
    // order-independent, so chunks can be uploaded in parallel and retried safely.
    const body = await readBody(req);
    const offset = Number(url.searchParams.get("offset") || 0);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    if (offset === 0) await fsp.writeFile(p, body);
    else {
      const fh = await fsp.open(p, "r+");
      try {
        await fh.write(body, 0, body.length, offset);
      } finally {
        await fh.close();
      }
    }
    return json(res, 200, { ok: true, path: p, bytes: body.length });
  }
  if (op === "mkdir" && req.method === "POST") {
    await fsp.mkdir(p, { recursive: true });
    return json(res, 200, { ok: true });
  }
  if (op === "stat" && req.method === "GET") {
    const st = await fsp.stat(p);
    let writable = true;
    try {
      await fsp.access(p, fs.constants.W_OK);
    } catch {
      writable = false;
    }
    return json(res, 200, {
      type: st.isDirectory() ? "dir" : st.isFile() ? "file" : "other",
      size: st.size,
      mtimeMs: st.mtimeMs,
      writable,
    });
  }
  if (op === "readdir" && req.method === "GET") {
    return json(res, 200, await fsp.readdir(p));
  }
  if (op === "untar" && req.method === "POST") {
    const src = resolvePath(url.searchParams.get("src"));
    const dest = resolvePath(url.searchParams.get("dest"));
    await fsp.mkdir(dest, { recursive: true });
    await new Promise((resolve, reject) => {
      const c = spawn("tar", ["-xzf", src, "-C", dest], { stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      c.stderr.on("data", (d) => (err += d));
      c.on("error", reject);
      c.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar failed (${code}): ${err}`))));
    });
    if (url.searchParams.get("remove") === "1") await fsp.rm(src, { force: true });
    return json(res, 200, { ok: true, dest });
  }
  if (op === "tar" && req.method === "GET") {
    await fsp.stat(p);
    res.writeHead(200, { "content-type": "application/gzip" });
    const c = spawn("tar", ["-czf", "-", "-C", path.dirname(p), path.basename(p)], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    c.stdout.pipe(res);
    res.on("close", () => c.kill("SIGKILL"));
    return;
  }
  json(res, 404, { error: `unknown fs op ${req.method} ${op}` });
}

// ---------------------------------------------------------------------------
// servers
// ---------------------------------------------------------------------------

const api = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/health") return json(res, 200, { ok: true, microvmId, ready: !!secret });
    if (!secret) return json(res, 503, { error: "not initialized (run hook not received)" });
    if (!safeEqual(req.headers["x-mvm-secret"] || "", secret)) return json(res, 401, { error: "bad secret" });

    if (url.pathname === "/exec" && req.method === "POST") return handleExec(req, res, await readBody(req, 1024 * 1024));
    if (url.pathname.startsWith("/fs/")) return await handleFs(req, res, url);
    json(res, 404, { error: "not found" });
  } catch (err) {
    if (!res.headersSent) json(res, errStatus(err), { error: String(err && err.message ? err.message : err), code: err && err.code });
    else res.destroy(err);
  }
});
api.requestTimeout = 0; // long-running exec streams
api.headersTimeout = 60_000;
api.keepAliveTimeout = 65_000;

const HOOK_PREFIX = "/aws/lambda-microvms/runtime/v1/";
const hooks = http.createServer(async (req, res) => {
  const name = req.url.startsWith(HOOK_PREFIX) ? req.url.slice(HOOK_PREFIX.length).split("?")[0] : "";
  try {
    const body = await readBody(req, 1024 * 1024);
    log("hook", name);
    if (name === "run") {
      const payload = JSON.parse(body.toString("utf8") || "{}");
      microvmId = payload.microvmId || null;
      let cfg = {};
      try {
        cfg = JSON.parse(payload.runHookPayload || "{}");
      } catch {}
      if (typeof cfg.secret === "string" && cfg.secret.length >= 16) secret = cfg.secret;
      else log("run hook without valid secret; API stays locked");
    }
    // ready / validate / resume / suspend / terminate: nothing to do
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  } catch (err) {
    res.writeHead(500);
    res.end(String(err));
  }
});

api.listen(API_PORT, () => log(`api listening on ${API_PORT}`));
hooks.listen(HOOK_PORT, () => log(`hooks listening on ${HOOK_PORT}`));
