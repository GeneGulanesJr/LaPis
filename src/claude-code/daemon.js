'use strict';

/**
 * Claude Code bridge: shared-dispatch daemon lifecycle.
 *
 * Wraps `lapis serve` as a long-lived process so hook handlers can POST to
 * `/dispatch` instead of cold-starting node + better-sqlite3 on every
 * PreToolUse. Lockfile location is overridable via LAPIS_DAEMON_LOCKFILE;
 * daemon URL for clients is LAPIS_DAEMON_URL or derived from the lockfile.
 */

const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  http = require('node:http'),
  { spawn } = require('node:child_process'),
  HOME = process.env.HOME || process.env.USERPROFILE || os.homedir(),
  DEFAULT_LOCKFILE = path.join(HOME, '.pi', 'memory', 'claude-daemon.json'),
  DEFAULT_HOST = '127.0.0.1',
  DEFAULT_PORT = 9100,
  HEALTH_POLL_MS = 100,
  HEALTH_TIMEOUT_MS = 15_000,
  PROBE_TIMEOUT_MS = 1000,
  STOP_GRACE_MS = 5_000;

function defaultLockfilePath() {
  return process.env.LAPIS_DAEMON_LOCKFILE || DEFAULT_LOCKFILE;
}

function parseStartFlags(argv) {
  const flags = {
      port: DEFAULT_PORT,
      host: DEFAULT_HOST,
      detached: false,
    },
    args = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--detached') {
      flags.detached = true;
    } else if (a === '--port') {
      const v = Number(args[++i]);
      if (!Number.isInteger(v) || v <= 0 || v > 65535) {
        throw new Error('--port requires an integer between 1 and 65535');
      }
      flags.port = v;
    } else if (a === '--host') {
      const v = args[++i];
      if (!v) {
        throw new Error('--host requires a value');
      }
      flags.host = v;
    } else {
      throw new Error(`Unknown flag: ${a}`);
    }
  }
  return flags;
}

function readLockfile(lockfilePath = defaultLockfilePath()) {
  let raw;
  try {
    raw = fs.readFileSync(lockfilePath, 'utf8');
  } catch {
    return null;
  }
  if (!raw.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeLockfile(info, lockfilePath = defaultLockfilePath()) {
  fs.mkdirSync(path.dirname(lockfilePath), { recursive: true });
  const tmpPath = `${lockfilePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, lockfilePath);
}

function removeLockfile(lockfilePath = defaultLockfilePath()) {
  try {
    fs.unlinkSync(lockfilePath);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      throw e;
    }
  }
}

function isProcessAlive(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function daemonUrlFromLock(info) {
  if (!info || info.port === undefined || info.port === null) {
    return null;
  }
  const host = info.host || DEFAULT_HOST;
  return `http://${host}:${info.port}`;
}

/**
 * Pid the LaPis server on host:port reports via /health, or null when nothing
 * answers in time or the answer is not a LaPis health body.
 */
async function probeDaemonPid(host, port, timeoutMs = PROBE_TIMEOUT_MS) {
  try {
    const res = await httpGet('/health', { host, port, timeoutMs }),
      pid = res.status === 200 ? JSON.parse(res.body)?.pid : null;
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * A lockfile is trusted only when its pid is the server answering on its
 * host:port. A bare liveness check is not enough: after a crash or reboot the
 * OS can hand the recorded pid to an unrelated program.
 */
async function lockOwnerIsLive(info, probe = probeDaemonPid) {
  if (!info?.pid || !daemonUrlFromLock(info) || !isProcessAlive(info.pid)) {
    return false;
  }
  return (await probe(info.host || DEFAULT_HOST, info.port)) === info.pid;
}

/**
 * Resolve the daemon base URL for dispatch-client. Priority:
 *   1. LAPIS_DAEMON_URL env
 *   2. lockfile whose pid is the server answering /health on its port
 */
async function resolveDaemonUrl(opts = {}) {
  const envUrl = process.env.LAPIS_DAEMON_URL;
  if (envUrl) {
    return envUrl.replace(/\/$/, '');
  }
  const info = readLockfile(opts.lockfilePath || defaultLockfilePath());
  return (await lockOwnerIsLive(info, opts.probeDaemonPid)) ? daemonUrlFromLock(info) : null;
}

const AUTODAEMON_ENV = 'LAPIS_HOOK_AUTODAEMON',
  // Hook processes must not hang on a cold start: bounded health wait, then
  // fall back to direct dispatch for this invocation. Later hooks find the
  // warm lockfile and dispatch over HTTP (~ms instead of ~100ms+ of in-process
  // module loading and SQLite open per fresh hook process).
  AUTODAEMON_HEALTH_TIMEOUT_MS = 2500;

function autoDaemonEnabled() {
  const v = process.env[AUTODAEMON_ENV];
  return v === '1' || v === 'true';
}

/**
 * Hook-path auto-start, opt-in via LAPIS_HOOK_AUTODAEMON=1/true. Resolves the
 * daemon URL as usual (env / live-pid lockfile) and, when none is running,
 * starts a detached `lapis serve` and waits (bounded) for health. Never writes
 * to stdout (hook protocol) and never throws: null means "dispatch direct".
 */
async function ensureDaemonRunning(opts = {}) {
  if (opts.forceDirect || !autoDaemonEnabled()) {
    return null;
  }
  const existing = await resolveDaemonUrl(opts);
  if (existing) {
    return existing;
  }
  const startFn = opts.startFn || runStart;
  try {
    await startFn(['--detached'], {
      lockfilePath: opts.lockfilePath,
      log: () => {},
      waitForHealth: (host, port, waitOpts) =>
        waitForHealth(host, port, { ...waitOpts, timeoutMs: opts.timeoutMs ?? AUTODAEMON_HEALTH_TIMEOUT_MS }),
    });
  } catch {
    return null;
  }
  return await resolveDaemonUrl(opts);
}

function httpGet(urlPath, { host, port, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'GET',
        hostname: host,
        port,
        path: urlPath,
        headers: { Accept: 'application/json' },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode, body: data });
        });
      },
    );
    req.on('error', reject);
    if (timeoutMs) {
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)));
    }
    req.end();
  });
}

async function waitForHealth(host, port, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? HEALTH_TIMEOUT_MS,
    pollMs = opts.pollMs ?? HEALTH_POLL_MS,
    deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await httpGet('/health', { host, port });
      if (res.status === 200) {
        return true;
      }
    } catch {
      // Keep polling
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`Daemon did not become healthy on ${host}:${port} within ${timeoutMs}ms`);
}

function cliEntryPath() {
  return path.resolve(__dirname, '../../cli.js');
}

function spawnDetachedServe({ host, port }) {
  const child = spawn(process.execPath, [cliEntryPath(), 'serve', '--host', host, '--port', String(port)], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child;
}

async function runStart(argv, io = {}) {
  const flags = parseStartFlags(argv),
    lockfilePath = io.lockfilePath || defaultLockfilePath(),
    log = io.log || ((line) => process.stdout.write(`${line}\n`)),
    probe = io.probeDaemonPid || probeDaemonPid,
    existing = readLockfile(lockfilePath);
  if (existing && (await lockOwnerIsLive(existing, probe))) {
    const portMismatch = Number.isFinite(existing.port) && existing.port !== flags.port,
      hostMismatch = Boolean(existing.host) && existing.host !== flags.host;
    if (portMismatch || hostMismatch) {
      // The lockfile is the source of truth; the install `--daemon-port` flag
      // Cannot relocate a running daemon. Warn loudly and keep the existing one
      // Rather than silently dropping the flag or disrupting other sessions
      // Sharing this daemon (#232).
      log(
        `⚠ LaPis daemon already running (pid ${existing.pid}) on http://${existing.host}:${existing.port},` +
          ` but http://${flags.host}:${flags.port} was requested.`,
      );
      log('  Run `lapis claude-code stop` first to change the host/port. Keeping the existing daemon.');
    } else {
      log(`LaPis daemon already running (pid ${existing.pid}, port ${existing.port}).`);
    }
    return {
      alreadyRunning: true,
      ...existing,
      requestedPort: flags.port,
      requestedHost: flags.host,
      ...(portMismatch || hostMismatch ? { mismatch: { portMismatch, hostMismatch } } : {}),
    };
  }
  if (existing) {
    removeLockfile(lockfilePath);
  }

  if (flags.detached) {
    const spawnFn = io.spawnDetachedServe || spawnDetachedServe,
      waitFn = io.waitForHealth || waitForHealth,
      stopFn = io.stopProcess || stopProcess,
      child = spawnFn(flags);
    try {
      await waitFn(flags.host, flags.port, io);
    } catch (e) {
      if (child?.pid) {
        await stopFn(child.pid, io);
      }
      throw e;
    }
    // Record the pid the server on the port reports, not child.pid: when a
    // concurrent start or an existing `lapis serve` already held the port, our
    // child died on EADDRINUSE and health was answered by that server. Adopt
    // it; a recorded dead pid would make every later hook start again.
    const pid = await probe(flags.host, flags.port);
    if (!pid) {
      if (child?.pid) {
        await stopFn(child.pid, io);
      }
      throw new Error(`Server on ${flags.host}:${flags.port} is not a LaPis daemon (no pid in /health)`);
    }
    {
      const current = readLockfile(lockfilePath);
      if (current?.pid === pid && current.port === flags.port && (!current.host || current.host === flags.host)) {
        log(`LaPis daemon already started by a concurrent process (pid ${current.pid}).`);
        return { alreadyRunning: true, ...current };
      }
    }
    const info = {
      pid,
      port: flags.port,
      host: flags.host,
      startedAt: new Date().toISOString(),
    };
    writeLockfile(info, lockfilePath);
    log(`LaPis daemon started (pid ${info.pid}, http://${flags.host}:${flags.port}).`);
    return info;
  }

  const info = {
      pid: process.pid,
      port: flags.port,
      host: flags.host,
      startedAt: new Date().toISOString(),
    },
    cleanup = (() => {
      writeLockfile(info, lockfilePath);

      return () => {
        removeLockfile(lockfilePath);
      };
    })();
  // A signal listener replaces Node's default exit, so exit explicitly; the
  // 'exit' listener removes the lockfile.
  process.on('SIGINT', () => process.exit(130));
  process.on('SIGTERM', () => process.exit(143));
  process.on('exit', cleanup);

  {
    const { startHttpServer } = require('../http/server');
    log(`LaPis daemon listening on http://${flags.host}:${flags.port}`);
    await startHttpServer({ host: flags.host, port: flags.port });
    return info;
  }
}

async function stopProcess(pid, opts = {}) {
  if (!isProcessAlive(pid)) {
    return false;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return false;
  }
  const graceMs = opts.graceMs ?? STOP_GRACE_MS,
    deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone
  }
  return !isProcessAlive(pid);
}

async function runStop(_argv, io = {}) {
  const lockfilePath = io.lockfilePath || defaultLockfilePath(),
    log = io.log || ((line) => process.stdout.write(`${line}\n`)),
    info = readLockfile(lockfilePath);
  if (!info) {
    log('LaPis daemon is not running (no lockfile).');
    return { stopped: false };
  }
  // Signal only a pid that is provably our daemon; a reused pid is someone else's program.
  if (info.pid && info.pid !== process.pid && (await lockOwnerIsLive(info, io.probeDaemonPid))) {
    await stopProcess(info.pid, io);
  }
  removeLockfile(lockfilePath);
  log('LaPis daemon stopped.');
  return { stopped: true, ...info };
}

module.exports = {
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_LOCKFILE,
  defaultLockfilePath,
  parseStartFlags,
  readLockfile,
  writeLockfile,
  removeLockfile,
  isProcessAlive,
  daemonUrlFromLock,
  probeDaemonPid,
  lockOwnerIsLive,
  resolveDaemonUrl,
  autoDaemonEnabled,
  ensureDaemonRunning,
  waitForHealth,
  runStart,
  runStop,
  stopProcess,
  spawnDetachedServe,
};
