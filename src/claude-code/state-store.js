'use strict';

/**
 * Claude Code bridge: per-session state store.
 *
 * Claude Code spawns a fresh process per hook event, so the in-process `state`
 * object the Pi extension mutates is invisible across hook invocations. This
 * module persists the SAME field set as extensions/memory-layer/state.ts to
 * ~/.pi/memory/claude-sessions/<claude_session_id>.json and reads it back on
 * the next hook.
 *
 * Concurrency: each hook is its own process, so reads may be stale relative to
 * a concurrent hook. loadState merges onto defaults so newer fields never
 * crash older state files, and a corrupt file degrades to defaults.
 * mutateState performs a locked read-modify-write so parallel PostToolUse
 * counters are not lost (#228).
 *
 * Fail-open contract: an unusable session_id (missing/null/empty/placeholder)
 * must NEVER collapse multiple sessions onto one shared file (#224). Such a
 * key yields defaults on load and a no-op on save, so the hook degrades
 * gracefully instead of cross-contaminating state.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const DEFAULT_DIR = path.join(HOME, '.pi', 'memory', 'claude-sessions');
const DEFAULT_TTL_HOURS = 24;

// Lock tuning for mutateState (#228). A crashed holder leaves a lockfile; it is
// broken once older than LOCK_STALE_MS so a wedged lock never permanently
// blocks the fast path.
const LOCK_TIMEOUT_MS = 2000;
const LOCK_POLL_MS = 25;
const LOCK_STALE_MS = 10_000;

// Placeholders that String(...) of a missing session_id collapses to; refusing
// them prevents every keyless session sharing one file (#224).
const PLACEHOLDER_KEYS = new Set(['undefined', 'null', 'nan', '', '_', '__', '___']);

// Field set mirrors extensions/memory-layer/state.ts (session-relevant subset;
// caches like cachedRepos/compressionStats are intentionally excluded).
function defaultState() {
  return {
    sessionId: null,
    currentProject: null,
    projectSessionCount: 0,
    memoriesSavedThisSession: 0,
    editedFiles: [],
    exploredFiles: [],
    turnCount: 0,
    dreamTriggeredThisSession: false,
    lastMemoryToolCall: 0,
    callsSinceLastMemory: 0,
    lastAutoDecisionSave: 0,
    hasInjectedContext: false,
    pendingRecallFeedback: [],
    nativeChecked: false,
  };
}

function resolveDir(opts) {
  return opts?.dir || DEFAULT_DIR;
}

/**
 * Resolve a session_id into a safe, non-placeholder filename stem. Returns
 * null for unusable keys (non-string, empty, or one of the placeholder strings
 * a missing session_id degenerates to) so callers can fail open (#224).
 */
function sanitizeKey(sessionId) {
  if (typeof sessionId !== 'string' && typeof sessionId !== 'number') {
    return null;
  }
  const raw = String(sessionId).trim();
  if (!raw) {
    return null;
  }
  const safe = raw.replace(/[^\w.-]/g, '_');
  if (!safe || PLACEHOLDER_KEYS.has(safe.toLowerCase()) || /^_+$/.test(safe)) {
    return null;
  }
  return safe;
}

function statePath(sessionId, opts) {
  const safe = sanitizeKey(sessionId);
  if (!safe) {
    return null;
  }
  return path.join(resolveDir(opts), `${safe}.json`);
}

/** Resolve the configurable stale-session TTL (hours). #233 */
function defaultTtlHours() {
  const raw = process.env.LAPIS_SESSION_TTL_HOURS;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) {
    return n;
  }
  return DEFAULT_TTL_HOURS;
}

/**
 * Load + normalize a stored state. Returns defaults for missing/corrupt files,
 * merged onto the current default set so forward-compatible fields are filled.
 * A null (unusable) session_id returns defaults without touching disk (#224).
 */
function loadState(sessionId, opts) {
  const filePath = statePath(sessionId, opts);
  if (!filePath) {
    return defaultState();
  }
  return readStateFile(filePath);
}

function readStateFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return defaultState();
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaultState();
  }

  if (!parsed || typeof parsed !== 'object') {
    return defaultState();
  }

  // Merge onto defaults so any newly-added field is present.
  return { ...defaultState(), ...parsed };
}

/**
 * Atomic write: temp file + rename. read-modify-write callers should use
 * mutateState (locked) or loadState first, mutate, then saveState.
 * A null (unusable) session_id is a no-op (#224).
 */
function saveState(sessionId, state, opts) {
  const filePath = statePath(sessionId, opts);
  if (!filePath) {
    return false;
  }
  atomicWrite(filePath, state);
  return true;
}

function atomicWrite(filePath, state) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 0), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

/** Unlink the state file; idempotent on ENOENT. A null key is a no-op (#224). */
function clearState(sessionId, opts) {
  const filePath = statePath(sessionId, opts);
  if (!filePath) {
    return;
  }
  try {
    fs.unlinkSync(filePath);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      throw e;
    }
  }
}

/**
 * Locked read-modify-write. Prevents lost updates when two PostToolUse hooks
 * race on the same session file (#228). Best-effort: if the lock cannot be
 * acquired within LOCK_TIMEOUT_MS it proceeds unlocked (a possible lost write
 * is preferable to blocking the hook and tripping Claude Code's timeout). A
 * null (unusable) session_id runs the mutator against a transient default
 * state and discards the result (#224).
 *
 * @returns the mutator's return value.
 */
async function mutateState(sessionId, mutator, opts) {
  const filePath = statePath(sessionId, opts);
  if (!filePath) {
    return mutator(defaultState());
  }
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const lockPath = `${filePath}.lock`;
  const acquired = await acquireLock(lockPath, opts);
  try {
    const state = readStateFile(filePath);
    const result = await mutator(state);
    atomicWrite(filePath, state);
    return result;
  } finally {
    if (acquired) {
      releaseLock(lockPath);
    }
  }
}

async function acquireLock(lockPath, opts = {}) {
  const timeoutMs = opts.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
  const pollMs = opts.lockPollMs ?? LOCK_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.closeSync(fd);
      fs.writeFileSync(lockPath, String(process.pid), 'utf8');
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') {
        // Cannot create the lock — fail open (proceed unlocked).
        return false;
      }
      // Break a lock held by a process that died leaving the file behind.
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        // ignore; retry
      }
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

function releaseLock(lockPath) {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Already gone — nothing to release.
  }
}

/**
 * Sweep state files older than maxAgeHours (from force-killed Claude processes
 * that never reached SessionEnd). Called on SessionStart. Best-effort: never
 * throws — a GC failure must not block a session start. The default honors
 * LAPIS_SESSION_TTL_HOURS (#233).
 */
function sweepStaleSessions(maxAgeHours, opts) {
  const ttl = maxAgeHours === undefined ? defaultTtlHours() : maxAgeHours;
  return sweepSessions(ttl, opts);
}

function sweepSessions(maxAgeHours, opts) {
  const dir = resolveDir(opts);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return { swept: 0 };
  }

  const cutoff = Date.now() - maxAgeHours * 3600 * 1000;
  let swept = 0;
  for (const entry of entries) {
    if (!entry.endsWith('.json')) {
      continue;
    }
    const full = path.join(dir, entry);
    try {
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(full);
        swept++;
      }
    } catch {
      // Skip unreadable / already-removed files.
    }
  }
  return { swept };
}

/**
 * On-demand GC entry point: `lapis claude-code gc [--max-age-hours N]` (#233).
 * Never throws — surfaces a swept count + the directory it ran against.
 */
function runGc(argv, io = {}) {
  const log = io.log || (() => {});
  let maxAgeHours = defaultTtlHours();
  const args = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--max-age-hours' && args[i + 1] !== undefined) {
      const n = Number(args[++i]);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error('--max-age-hours requires a positive number');
      }
      maxAgeHours = n;
    } else if (args[i] === '--help' || args[i] === '-h') {
      log('Usage: lapis claude-code gc [--max-age-hours N]');
      return { swept: 0, maxAgeHours };
    } else {
      throw new Error(`Unknown flag: ${args[i]}`);
    }
  }
  const result = sweepSessions(maxAgeHours, io);
  const dir = resolveDir(io);
  log(`Swept ${result.swept} stale session state file(s) older than ${maxAgeHours}h from ${dir}.`);
  return { ...result, maxAgeHours, dir };
}

module.exports = {
  defaultState,
  loadState,
  saveState,
  clearState,
  mutateState,
  sweepStaleSessions,
  sanitizeKey,
  defaultTtlHours,
  runGc,
  DEFAULT_DIR,
  DEFAULT_TTL_HOURS,
};
