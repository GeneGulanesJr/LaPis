'use strict';

/**
 * Claude Code bridge: dispatch-client (direct mode).
 *
 * The single module owning process/DB access so the lifecycle handlers stay
 * transport-agnostic and unit-testable with a fake dispatch. Phase 2 ships
 * "direct" mode only — a lazy require of the in-process gateway (same seam as
 * src/mcp/server.js:49 and extensions/.../host/memory-client.ts:17). Daemon
 * mode (POST /dispatch) is Phase 5.
 *
 * Handlers receive a `dispatch` (writes) and the two read helpers below. In
 * tests both can be stubbed; nothing here touches the real DB unless invoked.
 */

/**
 * Coerce an args bag into the string-only record the gateway expects.
 * Mirrors host/memory-client.ts:33-39 (skip undefined/null/'').
 */
function stringifyArgs(args) {
  const out = {};
  for (const [k, v] of Object.entries(args || {})) {
    if (v !== undefined && v !== null && v !== '') {
      out[k] = String(v);
    }
  }
  return out;
}

let _dispatch = null;

/**
 * Direct (in-process) dispatch. Lazily loads the gateway so a fake dispatch in
 * tests never requires the DB.
 */
function dispatch(cmd, args) {
  if (!_dispatch) {
    // Resolve relative to this file: claude-code/ → src/ → src/cli/gateway
    _dispatch = require('../cli/gateway').dispatch;
  }
  return _dispatch(cmd, stringifyArgs(args));
}

/**
 * DB-derived count of observations saved under a session. Used by session-end
 * instead of the fragile in-process counter (issue #207). Best-effort: returns
 * 0 if the DB/session can't be read.
 */
function countSessionMemories(sessionId) {
  if (sessionId === undefined || sessionId === null || sessionId === '') {
    return 0;
  }
  try {
    const { getDb } = require('../../db');
    const row = getDb().prepare('SELECT COUNT(*) AS n FROM observations WHERE session_id = ?').get(sessionId);
    return Number(row?.n) || 0;
  } catch {
    return 0;
  }
}

/**
 * Known indexed code repos, for cwd-repo resolution + preflight gating.
 * Mirrors extensions/.../host/project-detector.ts getKnownRepos(). Best-effort.
 */
function getKnownRepos() {
  try {
    const { sqlJson } = require('../../db');
    return sqlJson('SELECT name, path, indexed_at FROM code_repos') || [];
  } catch {
    return [];
  }
}

module.exports = { dispatch, countSessionMemories, getKnownRepos, stringifyArgs };
