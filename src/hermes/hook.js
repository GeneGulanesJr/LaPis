'use strict';

/**
 * Hermes Agent shell-hook handler — `lapis hermes hook`.
 *
 * Hermes spawns the configured hook command once per event and feeds it a
 * JSON payload on stdin:
 *
 *   { hook_event_name, tool_name, tool_input, session_id, cwd, extra }
 *
 * This module reads that payload and implements the LaPis guardrails for
 * Hermes, mirroring the Claude Code bridge (src/claude-code/handlers/*):
 *
 *   pre_tool_call  + read_file           → block whole-file reads of indexed
 *                                          code (outline-first guardrail)
 *   post_tool_call + write_file|patch    → fire-and-forget sync-code-trust
 *   on_session_end                       → best-effort session-end
 *
 * Hooks fail open: any error, timeout, or ambiguity lets the tool proceed.
 * Block responses use the Hermes wire format `{"decision":"block","reason":…}`
 * (the `{"action":"block","message":…}` alias is accepted too).
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { isCodeFile } = require('../code-index/scanner');
const { resolveIndexedRepo, normalizeRepoPath } = require('../hooks-engine/project');
const { CONFIG_FILENAMES } = require('../hooks-engine/guardrail-utils');

/** Absolute path to this repo's `memory-store.js` entry point. */
function lapisEntry() {
  return path.resolve(__dirname, '..', '..', 'memory-store.js');
}

/** Indexed code repos (rows from code_repos: {name, path, …}). Never throws. */
function indexedRepos() {
  try {
    const { listCodeReposInternal } = require('../../services/code-search');
    const result = listCodeReposInternal();
    return Array.isArray(result && result.repos) ? result.repos : [];
  } catch {
    return [];
  }
}

/**
 * The read guardrail: null when the read should proceed, otherwise a block
 * reason string. Mirrors src/claude-code/handlers/pre-tool-use.js readGuardrail
 * minus the exploredFiles session state (Hermes has no per-session state here).
 */
function readGuardReason(payload, deps) {
  const input = payload.tool_input || {};
  const filePath = typeof input.file_path === 'string' ? input.file_path : input.path;
  if (typeof filePath !== 'string' || !filePath) {
    return null;
  }
  if (!isCodeFile(filePath)) {
    return null;
  }
  // Targeted slice read — the agent already knows where to look.
  if (typeof input.offset === 'number' || typeof input.limit === 'number') {
    return null;
  }
  const basename = path.basename(filePath);
  if (CONFIG_FILENAMES.has(basename)) {
    return null;
  }
  if (filePath.includes('node_modules')) {
    return null;
  }

  const cwd = payload.cwd || process.cwd();
  const absPath = path.resolve(cwd, filePath);
  const absNorm = normalizeRepoPath(absPath);
  const cwdNorm = normalizeRepoPath(cwd);
  // Cross-project reads (outside cwd) bypass the outline guard.
  if (absNorm !== cwdNorm && !absNorm.startsWith(`${cwdNorm}/`)) {
    return null;
  }

  const repos = (deps && deps.repos) || indexedRepos();
  const matched = resolveIndexedRepo(cwd, repos, null);
  if (!matched) {
    return null;
  }
  const rp = normalizeRepoPath(matched.path || matched.name);
  if (absNorm !== rp && !absNorm.startsWith(`${rp}/`)) {
    return null;
  }

  const rel = path.relative(matched.path || matched.name, absPath);
  return (
    `Blocked by LaPis read guard: ${rel} is indexed code in repo "${matched.path || matched.name}". ` +
    'Whole-file reads are discouraged — use mcp__lapis__memory_code with mode "outline" (or "search") ' +
    'for this file first; targeted reads with offset/limit are allowed for editing.'
  );
}

/** Decide what the hook should do for a payload. Returns null for no-op. */
function handlePayload(payload, deps = {}) {
  const event = payload.hook_event_name;
  const tool = payload.tool_name;
  if (event === 'pre_tool_call' && tool === 'read_file') {
    const reason = readGuardReason(payload, deps);
    if (reason) {
      return { block: reason };
    }
    return null;
  }
  if (event === 'post_tool_call' && (tool === 'write_file' || tool === 'patch')) {
    return { syncTrust: true };
  }
  if (event === 'on_session_end') {
    return { sessionEnd: true };
  }
  return null;
}

/** Fire-and-forget trust sync after an edit inside an indexed repo. */
function syncTrust(payload) {
  const cwd = payload.cwd || process.cwd();
  const repos = indexedRepos();
  const hit = repos.find((r) => cwd === r.path || cwd.startsWith(`${r.path}${path.sep}`));
  if (!hit) {
    return;
  }
  const child = spawn(process.execPath, [lapisEntry(), 'sync-code-trust', '--repo', hit.name || hit.path], {
    detached: true,
    stdio: 'ignore',
    cwd: hit.path || cwd,
  });
  child.unref();
}

/** Best-effort LaPis session close. Never throws. */
function closeSession(payload) {
  try {
    const args = [lapisEntry(), 'session-end'];
    if (payload.session_id) {
      args.push('--id', String(payload.session_id));
    }
    args.push('--memories', '0', '--auto', 'true');
    spawnSync(process.execPath, args, {
      cwd: payload.cwd || process.cwd(),
      timeout: 15000,
      stdio: 'ignore',
    });
  } catch {
    // best effort only
  }
}

/**
 * Entry point: read one JSON payload from stdin, act, and print any block
 * decision to stdout. `runHook` is testable via `io.input`/`io.log`.
 */
function runHook(io = {}) {
  const input = io.input !== undefined ? io.input : fs.readFileSync(0, 'utf8');
  let payload;
  try {
    payload = JSON.parse(input || '{}');
  } catch {
    return null;
  }
  const decision = handlePayload(payload, io);
  if (!decision) {
    return null;
  }
  if (decision.block) {
    process.stdout.write(JSON.stringify({ decision: 'block', reason: decision.block }));
    return decision;
  }
  if (decision.syncTrust) {
    syncTrust(payload);
  }
  if (decision.sessionEnd) {
    closeSession(payload);
  }
  return decision;
}

module.exports = {
  lapisEntry,
  indexedRepos,
  readGuardReason,
  handlePayload,
  syncTrust,
  closeSession,
  runHook,
};
