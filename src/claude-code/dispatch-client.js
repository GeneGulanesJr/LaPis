'use strict';

/**
 * Claude Code bridge: dispatch-client (direct + daemon mode).
 *
 * The single module owning process/DB access so the lifecycle handlers stay
 * transport-agnostic and unit-testable with a fake dispatch.
 *
 * Backends (auto-selected):
 *   1. Daemon mode — when LAPIS_DAEMON_URL or the daemon lockfile points at a
 *      live `lapis serve`, POST {cmd,args} to /dispatch (~ms latency).
 *   2. Direct mode — in-process gateway.dispatch (Phase 2 fallback).
 *
 * Handlers receive `dispatch` (writes) and the read helpers below. In tests
 * both can be stubbed; nothing here touches the real DB unless invoked.
 */

const { resolveDaemonUrl } = require('./daemon');

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

let _directDispatch = null;

function loadDirectDispatch() {
  if (!_directDispatch) {
    _directDispatch = require('../cli/gateway').dispatch;
  }
  return _directDispatch;
}

/**
 * POST to a running daemon. Injectable fetch/http for tests.
 */
async function dispatchViaDaemon(baseUrl, cmd, args, opts = {}) {
  const fetchFn = opts.fetch || globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new Error('fetch is unavailable for daemon dispatch');
  }
  // args.project is already serialized into payload.args.project by
  // stringifyArgs; the server's mergeDispatchArgs reads it from there. A
  // redundant top-level `project` field was never consumed and only obscured
  // the real source of truth (#229).
  const payload = { cmd, args: stringifyArgs(args) };
  const res = await fetchFn(`${baseUrl.replace(/\/$/, '')}/dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let message = `Daemon dispatch failed (${res.status})`;
    try {
      const errBody = await res.json();
      if (errBody?.error?.message) {
        message = errBody.error.message;
      }
    } catch {
      // ignore parse errors
    }
    throw new Error(message);
  }
  return res.json();
}

/**
 * Dispatch a gateway command. Uses daemon mode when available, else direct.
 */
async function dispatch(cmd, args, opts = {}) {
  const resolveUrl = opts.resolveDaemonUrl || resolveDaemonUrl;
  const daemonUrl = resolveUrl(opts);
  if (daemonUrl && !opts.forceDirect) {
    try {
      return await dispatchViaDaemon(daemonUrl, cmd, args || {}, opts);
    } catch (e) {
      if (opts.requireDaemon) {
        throw e;
      }
      process.stderr.write(
        `claude-code: daemon dispatch failed, falling back to direct mode: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }
  const directFn = opts.directDispatch || loadDirectDispatch();
  return directFn(cmd, stringifyArgs(args));
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

module.exports = {
  dispatch,
  dispatchViaDaemon,
  countSessionMemories,
  getKnownRepos,
  stringifyArgs,
  loadDirectDispatch,
};
