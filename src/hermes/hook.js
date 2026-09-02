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
 *   pre_tool_call  + read_file|search_files → block whole-file reads of
 *                                          indexed code (outline-first
 *                                          guardrail) and broad search
 *                                          scans (memory-code redirect)
 *   post_tool_call + write_file|patch    → fire-and-forget sync-code-trust
 *   pre_llm_call                         → inject recalled memory context
 *                                          into the user message
 *   on_session_start                     → start a LaPis session + persist
 *                                          the Hermes→LaPis id mapping
 *   on_session_end                       → best-effort session-end
 *
 * Hooks fail open: any error, timeout, or ambiguity lets the tool proceed.
 * Block responses use the Hermes wire format `{"decision":"block","reason":…}`
 * (the `{"action":"block","message":…}` alias is accepted too).
 */

const fs = require('node:fs'), path = require('node:path'), { spawn, spawnSync } = require('node:child_process'), { isCodeFile } = require('../code-index/scanner'), { resolveIndexedRepo, normalizeRepoPath } = require('../hooks-engine/project'), { CONFIG_FILENAMES, isTargetedGrepLookup } = require('../hooks-engine/guardrail-utils'), { loadState, saveState, sessionStateDir } = require('./state-store'), { CONTEXT } = require('../../constants'), { capInjectedContext, buildContextBlock } = require('../hooks-engine/context-builder');










/** Absolute path to this repo's `memory-store.js` entry point. */
function lapisEntry() {
  return path.resolve(__dirname, '..', '..', 'memory-store.js');
}

/** Indexed code repos (rows from code_repos: {name, path, …}). Never throws. */
function indexedRepos() {
  try {
    const { listCodeReposInternal } = require('../../services/code-search'),
      result = listCodeReposInternal();
    return Array.isArray(result && result.repos) ? result.repos : [];
  } catch {
    return [];
  }
}

/**
 * Count memories recorded for a session, mirroring the Claude bridge
 * (dispatch-client countSessionMemories, per #207): the DB is authoritative,
 * not an in-process counter. Never throws.
 */
function countSessionMemories(sessionId) {
  if (sessionId === undefined || sessionId === null || sessionId === '') {
    return 0;
  }
  try {
    const { getDb } = require('../../db'),
      row = getDb().prepare('SELECT COUNT(*) AS n FROM observations WHERE session_id = ?').get(String(sessionId));
    return Number(row && row.n) || 0;
  } catch {
    return 0;
  }
}

/**
 * The read guardrail: null when the read should proceed, otherwise a block
 * reason string. Mirrors src/claude-code/handlers/pre-tool-use.js readGuardrail
 * minus the exploredFiles session state (Hermes has no per-session state here).
 */
function readGuardReason(payload, deps) {
  const input = payload.tool_input || {},
    filePath = typeof input.file_path === 'string' ? input.file_path : input.path;
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

  const cwd = payload.cwd || process.cwd(),
    absPath = path.resolve(cwd, filePath),
    absNorm = normalizeRepoPath(absPath),
    cwdNorm = normalizeRepoPath(cwd);
  // Cross-project reads (outside cwd) bypass the outline guard.
  if (absNorm !== cwdNorm && !absNorm.startsWith(`${cwdNorm}/`)) {
    return null;
  }

  const repos = (deps && deps.repos) || indexedRepos(),
    matched = resolveIndexedRepo(cwd, repos, null),
  rp = matched ? (normalizeRepoPath(matched.path || matched.name)) : undefined;
  if (!matched) {
    return null;
  }
  if (absNorm !== rp && !absNorm.startsWith(`${rp}/`)) {
    return null;
  }

  {
const rel = path.relative(matched.path || matched.name, absPath);
  return (
    `Blocked by LaPis read guard: ${rel} is indexed code in repo "${matched.path || matched.name}". ` +
    'Whole-file reads are discouraged — use mcp__lapis__memory_code with mode "outline" (or "search") ' +
    'for this file first; targeted reads with offset/limit are allowed for editing.'
  );
}
}

/** Tool-aware guard dispatcher: read_file → read guard, search_files → search guard. */
function guardReason(payload, deps) {
  const tool = payload.tool_name;
  if (tool === 'search_files') {
    return searchGuardReason(payload, deps);
  }
  return readGuardReason(payload, deps);
}

/** Mirror claude pre-tool-use searchGuardrail: block broad scans in indexed repos. */
function searchGuardReason(payload, deps) {
  const input = payload.tool_input || {},
    pattern = input.pattern,
    searchPath = typeof input.path === 'string' ? input.path : '';
  if (typeof pattern !== 'string' || !pattern) {
    return null;
  }
  if (isTargetedGrepLookup({ pattern, path: searchPath })) {
    return null;
  }
  const cwd = payload.cwd || process.cwd(),
    repos = (deps && deps.repos) || indexedRepos(),
    matched = resolveIndexedRepo(cwd, repos, null),
  absPath = matched ? (path.resolve(cwd, searchPath || cwd)) : undefined,
  rp = matched ? (normalizeRepoPath(matched.path || matched.name)) : undefined,
  absNorm = matched ? (normalizeRepoPath(absPath)) : undefined;
  if (!matched) {
    return null;
  }
  if (absNorm !== rp && !absNorm.startsWith(`${rp}/`)) {
    return null;
  }
  {
const name = matched.name || matched.path;
  return (
    `Blocked by LaPis search guard: broad code search in indexed repo "${name}". ` +
    'Use mcp__lapis__memory_code instead: mode "search" for semantic queries, ' +
    '"outline" for file structure, "callers"/"callees" for hierarchy. ' +
    'For a single-symbol lookup, use a plain symbol pattern (no regex) or scope to one file.'
  );
}
}

/** Decide what the hook should do for a payload. Returns null for no-op. */
function handlePayload(payload, deps = {}) {
  const event = payload.hook_event_name,
    tool = payload.tool_name;
  if (event === 'pre_tool_call' && (tool === 'read_file' || tool === 'search_files')) {
    const reason = guardReason(payload, deps);
    if (reason) {
      return { block: reason };
    }
    return null;
  }
  if (event === 'post_tool_call' && (tool === 'write_file' || tool === 'patch')) {
    return { syncTrust: true };
  }
  if (event === 'on_session_start') {
    return { sessionStart: true };
  }
  if (event === 'pre_llm_call') {
    return { injectContext: true };
  }
  if (event === 'on_session_end') {
    return { sessionEnd: true };
  }
  return null;
}

/** Fire-and-forget trust sync after an edit inside an indexed repo. */
function syncTrust(payload) {
  const cwd = payload.cwd || process.cwd(),
    repos = indexedRepos(),
    hit = repos.find((r) => cwd === r.path || cwd.startsWith(`${r.path}${path.sep}`)),
  child = !(!hit || !hit.name) ? (spawn(process.execPath, [lapisEntry(), 'sync-code-trust', '--repo', hit.name], {
    detached: true,
    stdio: 'ignore',
    cwd: hit.path || cwd,
  })) : undefined;
  if (!hit || !hit.name) {
    return;
  }
  // Sync-code-trust resolves the repo by name (code_repos.name is NOT NULL),
  // So a path fallback would never match — bail out instead of spawning a
  // Doomed process.
  child.unref();
}

/**
 * Start a LaPis session for a new Hermes session and persist the id mapping.
 * Fire-and-forget style (never blocks session start); fail-open.
 */
function startSession(payload) {
  try {
    const args = [lapisEntry(), 'session-start', '--project', payload.cwd || process.cwd()],
      res = spawnSync(process.execPath, args, { timeout: 15000, encoding: 'utf8' });
    if (res.status !== 0 || !res.stdout) {
      return;
    }
    const parsed = JSON.parse(res.stdout),
      id = parsed && (parsed.id ?? parsed.sessionId);
    if (id !== undefined && id !== null && payload.session_id) {
      saveState(sessionStateDir(), payload.session_id, { lapisSessionId: Number(id) });
    }
  } catch {
    // Best effort only
  }
}

/**
 * Query LaPis context for the current user message and return a capped
 * {"context": "…"} block. Returns null (silent) on any failure/absence so the
 * turn proceeds untouched. Runs synchronously with a hard timeout.
 */
function injectContext(payload) {
  try {
    const userMessage = (payload.extra && payload.extra.user_message) || '',
    st = !(!userMessage || !payload.cwd) ? (loadState(sessionStateDir(), payload.session_id)) : undefined,
    args = !(!userMessage || !payload.cwd) ? ([
        lapisEntry(),
        'context',
        '--query',
        userMessage.slice(0, 500),
        '--project',
        payload.cwd,
        '--token-budget',
        String(CONTEXT.TOKEN_BUDGET_DEFAULT || 2000),
      ]) : undefined;
    if (!userMessage || !payload.cwd) {
      return null;
    }
    if (st.lapisSessionId) {
      args.push('--session-id', String(st.lapisSessionId));
    }
    const res = spawnSync(process.execPath, args, { timeout: 15000, encoding: 'utf8' }),
    parsed = !(res.status !== 0 || !res.stdout) ? (JSON.parse(res.stdout)) : undefined,
    repos = !(res.status !== 0 || !res.stdout) ? (indexedRepos()) : undefined,
    cwdRepo = !(res.status !== 0 || !res.stdout) ? (resolveIndexedRepo(payload.cwd, repos, null)) : undefined,
    lines = !(res.status !== 0 || !res.stdout) ? (buildContextBlock({
        promptQuery: userMessage.slice(0, 500),
        currentProject: parsed.project || payload.cwd,
        projectDir: payload.cwd,
        cwdRepo,
        isStale: false,
        isNewProject: false,
        observations: (parsed.observations || []).filter(Boolean),
        effectiveObservations: (parsed.observations || []).filter(Boolean),
        personal: (parsed.personal || []).filter(Boolean),
        stats: parsed.stats || {},
        effectiveStats: parsed.stats || {},
        topic: parsed.topic || null,
        crossProjectSuggestions: parsed.cross_project_suggestions || [],
      })) : undefined;
    if (res.status !== 0 || !res.stdout) {
      return null;
    }
    if (!Array.isArray(lines) || lines.length === 0) {
      return null;
    }
    {
const block = capInjectedContext(lines.join('\n'));
    return { context: block };
  }
} catch {
    return null;
  }
}

/** Build session-end args: prefer the mapped numeric LaPis id (Task 2). */
function buildSessionEndArgs(payload, state) {
  const args = [lapisEntry(), 'session-end'],
    id = state && state.lapisSessionId ? String(state.lapisSessionId) : payload.session_id;
  if (id) {
    args.push('--id', id);
  }
  args.push('--memories', String(countSessionMemories(id)), '--auto', 'true');
  return args;
}

/** Best-effort LaPis session close. Never throws. */
function closeSession(payload) {
  try {
    const st = loadState(sessionStateDir(), payload.session_id);
    spawnSync(process.execPath, buildSessionEndArgs(payload, st), {
      cwd: payload.cwd || process.cwd(),
      timeout: 15000,
      stdio: 'ignore',
    });
  } catch {
    // Best effort only
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
  {
const decision = handlePayload(payload, io);
  if (!decision) {
    return null;
  }
  if (decision.injectContext) {
    // Pre_llm_call: the result IS the output (a {"context": ...} block); no side effect.
    const ctx = injectContext(payload);
    if (ctx && ctx.context) {
      process.stdout.write(JSON.stringify(ctx));
    }
    return decision;
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
  if (decision.sessionStart) {
    startSession(payload);
  }
  return decision;
}
}

module.exports = {
  lapisEntry,
  indexedRepos,
  countSessionMemories,
  readGuardReason,
  searchGuardReason,
  guardReason,
  startSession,
  injectContext,
  buildSessionEndArgs,
  handlePayload,
  syncTrust,
  closeSession,
  runHook,
};
