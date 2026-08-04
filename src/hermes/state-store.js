// src/hermes/state-store.js
'use strict';
// Per-Hermes-session state store. Hermes spawns a fresh process per hook
// event, so cross-event state (mapped LaPis session id, turn counter) lives
// on disk, mirroring src/claude-code/state-store.js. Fail-open: unusable
// session ids never collapse onto one shared file; corrupt files degrade to
// defaults. No locking needed for v1 (single-writer-per-event, best-effort).

const fs = require('node:fs');
const path = require('node:path');

const PLACEHOLDERS = new Set(['', 'none', 'null', 'undefined', 'None', 'NULL']);

function isUsableSessionId(id) {
  return id !== undefined && id !== null && !PLACEHOLDERS.has(String(id).trim());
}

function statePath(dir, sessionId) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(dir, `${safe}.json`);
}

function loadState(dir, sessionId) {
  if (!isUsableSessionId(sessionId)) return {};
  try {
    const raw = fs.readFileSync(statePath(dir, sessionId), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveState(dir, sessionId, patch) {
  if (!isUsableSessionId(sessionId)) return;
  fs.mkdirSync(dir, { recursive: true });
  const current = loadState(dir, sessionId);
  const next = { ...current, ...patch };
  const tmp = `${statePath(dir, sessionId)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(tmp, statePath(dir, sessionId));
}

/** LaPis per-Hermes-session state dir under the memory root (mirrors claude-sessions). */
function sessionStateDir() {
  const { HOME } = require('../../db');
  return path.join(HOME, '.pi', 'memory', 'hermes-sessions');
}

module.exports = { loadState, saveState, statePath, isUsableSessionId, sessionStateDir };
