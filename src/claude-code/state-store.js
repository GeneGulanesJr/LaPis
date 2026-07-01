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
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const DEFAULT_DIR = path.join(HOME, '.pi', 'memory', 'claude-sessions');

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

function statePath(sessionId, opts) {
  const safe = String(sessionId).replace(/[^\w.-]/g, '_');
  return path.join(resolveDir(opts), `${safe}.json`);
}

/**
 * Load + normalize a stored state. Returns defaults for missing/corrupt files,
 * merged onto the current default set so forward-compatible fields are filled.
 */
function loadState(sessionId, opts) {
  let raw;
  try {
    raw = fs.readFileSync(statePath(sessionId, opts), 'utf8');
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
 * Atomic write: temp file + rename. read-modify-write callers should loadState
 * first, mutate, then saveState.
 */
function saveState(sessionId, state, opts) {
  const dir = resolveDir(opts);
  fs.mkdirSync(dir, { recursive: true });
  const finalPath = statePath(sessionId, opts);
  const tmpPath = `${finalPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 0), 'utf8');
  fs.renameSync(tmpPath, finalPath);
}

/** Unlink the state file; idempotent on ENOENT. */
function clearState(sessionId, opts) {
  try {
    fs.unlinkSync(statePath(sessionId, opts));
  } catch (e) {
    if (e.code !== 'ENOENT') {
      throw e;
    }
  }
}

/**
 * Sweep state files older than maxAgeHours (from force-killed Claude processes
 * that never reached SessionEnd). Called on SessionStart. Best-effort: never
 * throws — a GC failure must not block a session start.
 */
function sweepStaleSessions(maxAgeHours = 24, opts) {
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

module.exports = {
  defaultState,
  loadState,
  saveState,
  clearState,
  sweepStaleSessions,
  DEFAULT_DIR,
};
