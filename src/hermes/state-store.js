// Src/hermes/state-store.js
'use strict';
// Per-Hermes-session state store. Hermes spawns a fresh process per hook
// Event, so cross-event state (mapped LaPis session id, turn counter) lives
// On disk, mirroring src/claude-code/state-store.js. Fail-open: unusable
// Session ids never collapse onto one shared file; corrupt files degrade to
// Defaults. saveState is a read-modify-write, and hook events overlap — so
// It runs under a short atomic-mkdir lock (stale locks break after 5s) to
// Avoid last-writer-wins dropping the other event's patch (#296).

const fs = require('node:fs'),
  path = require('node:path'),
  PLACEHOLDERS = new Set(['', 'none', 'null', 'undefined', 'None', 'NULL']),
  LOCK_TIMEOUT_MS = 1000,
  LOCK_STALE_MS = 5000,
  LOCK_POLL_MS = 25;

// Synchronous bounded lock (saveState must stay sync — hook.js calls it
// Fire-and-forget and the process can exit right after). Atomic mkdir as
// The lock primitive; stale locks from crashed holders break after 5s. On
// Timeout it proceeds unlocked — a possible lost write beats blocking the
// Hook past Hermes' timeout.
function acquireSyncLock(lockPath) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') {
        throw e;
      }
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Stat failed — lock may have just been released; retry below.
      }
    }
    if (Date.now() >= deadline) {
      return false;
    }
    // Synchronous sleep: Atomics.wait on a zero-length window.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_POLL_MS);
  }
}

function releaseSyncLock(lockPath) {
  try {
    fs.rmSync(lockPath, { recursive: true, force: true });
  } catch {
    // Best-effort.
  }
}

function isUsableSessionId(id) {
  return id !== undefined && id !== null && !PLACEHOLDERS.has(String(id).trim());
}

function statePath(dir, sessionId) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(dir, `${safe}.json`);
}

function loadState(dir, sessionId) {
  if (!isUsableSessionId(sessionId)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(statePath(dir, sessionId), 'utf8'),
      parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveState(dir, sessionId, patch) {
  if (!isUsableSessionId(sessionId)) {
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  const target = statePath(dir, sessionId),
    lockPath = `${target}.lock`,
    acquired = acquireSyncLock(lockPath);
  try {
    const current = loadState(dir, sessionId),
      next = { ...current, ...patch },
      tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    fs.renameSync(tmp, target);
  } finally {
    if (acquired) {
      releaseSyncLock(lockPath);
    }
  }
}

/** LaPis per-Hermes-session state dir under the memory root (mirrors claude-sessions). */
function sessionStateDir() {
  const { HOME } = require('../../db');
  return path.join(HOME, '.pi', 'memory', 'hermes-sessions');
}

module.exports = { loadState, saveState, statePath, isUsableSessionId, sessionStateDir };
