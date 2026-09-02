'use strict';

/**
 * Claude Code bridge: shared-dispatch daemon lifecycle.
 *
 * Wraps `lapis serve` as a long-lived process so hook handlers can POST to
 * `/dispatch` instead of cold-starting node + better-sqlite3 on every
 * PreToolUse. Lockfile location is overridable via LAPIS_DAEMON_LOCKFILE;
 * daemon URL for clients is LAPIS_DAEMON_URL or derived from the lockfile.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process'),
  HOME = process.env.HOME || process.env.USERPROFILE || os.homedir(),
  DEFAULT_LOCKFILE = path.join(HOME, '.pi', 'memory', 'claude-daemon.json'),
  DEFAULT_HOST = '127.0.0.1',
  DEFAULT_PORT = 9100,
  HEALTH_POLL_MS = 100,
  HEALTH_TIMEOUT_MS = 15_000,
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
 * Resolve the daemon base URL for dispatch-client. Priority:
 *   1. LAPIS_DAEMON_URL env
 *   2. lockfile with a live pid
 */
function resolveDaemonUrl(opts = {}) {
  const envUrl = process.env.LAPIS_DAEMON_URL,
  lockfilePath = !(envUrl) ? (opts.lockfilePath || defaultLockfilePath()) : undefined,
  info = !(envUrl) ? (readLockfile(lockfilePath)) : undefined;
  if (envUrl) {
    return envUrl.replace(/\/$/, '');
  }
  if (!info) {
    return null;
  }
  if (info.pid && !isProcessAlive(info.pid)) {
    return null;
  }
  return daemonUrlFromLock(info);
}

function httpGet(urlPath, { host, port }) {
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
    existing = readLockfile(lockfilePath);
  if (existing?.pid && isProcessAlive(existing.pid)) {
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
    const info = {
      pid: child.pid,
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
  
    
  return (() => {
    removeLockfile(lockfilePath);
  });
})();process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('exit', cleanup);

  const { startHttpServer } = require('../http/server');
  log(`LaPis daemon listening on http://${flags.host}:${flags.port}`);
  await startHttpServer({ host: flags.host, port: flags.port });
  return info;
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
  if (info.pid && info.pid !== process.pid) {
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
  resolveDaemonUrl,
  waitForHealth,
  runStart,
  runStop,
  stopProcess,
  spawnDetachedServe,
};
