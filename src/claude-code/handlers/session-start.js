'use strict';

/**
 * Claude Code SessionStart handler.
 *
 * Branches on the payload `source` field (startup|resume|clear vs compact):
 *  - startup|resume|clear → sweep stale state files, call `session-start`,
 *    store the returned numeric sessionId, then inject context.
 *  - compact → do NOT call `session-start` (would INSERT a spurious row);
 *    reuse the stored sessionId and re-inject context only.
 *
 * Mirrors extensions/.../hooks/session-lifecycle.ts registerSessionStart +
 * registerSessionCompact.
 */

const { resolveCwd, projectFromCwd } = require('../../hooks-engine/project');
const { buildInjectedContext } = require('../context-inject');

/**
 * Run SessionStart.
 *
 * @param {object} ctx
 * @param {object} ctx.payload           stdin JSON: { session_id, source, cwd, ... }
 * @param {Function} ctx.dispatch        injected dispatch (direct mode)
 * @param {Function} ctx.getKnownRepos   known code repos (direct mode read)
 * @param {object} ctx.stateStore        { loadState, saveState, sweepStaleSessions }
 * @returns {Promise<object|null>}       Claude Code JSON or null
 */
async function handleSessionStart({ payload, dispatch, getKnownRepos, stateStore }) {
  const source = payload.source || 'startup';
  const cwd = resolveCwd(payload.cwd);
  const project = projectFromCwd(cwd);
  const claudeSessionId = payload.session_id;

  let state = stateStore.loadState(claudeSessionId);

  // compact re-uses the existing sessionId and skips session-start entirely.
  const isCompact = source === 'compact';

  if (!isCompact) {
    // GC orphaned state files from force-killed sessions before starting fresh.
    // The TTL honors LAPIS_SESSION_TTL_HOURS (default 24h); surface a sweep so
    // the user can correlate a missing state file (#233).
    try {
      const sweep = stateStore.sweepStaleSessions();
      if (sweep && sweep.swept > 0) {
        const ttl = typeof stateStore.defaultTtlHours === 'function' ? stateStore.defaultTtlHours() : 24;
        process.stderr.write(
          `claude-code: swept ${sweep.swept} stale session state file(s) older than ${ttl}h` +
            ` (set LAPIS_SESSION_TTL_HOURS to adjust).\n`,
        );
      }
    } catch {
      // GC is best-effort.
    }

    // Reset session-derived counters for a genuine start.
    state = {
      ...stateStore.defaultState(),
      nativeChecked: state.nativeChecked,
    };
    state.currentProject = project;
    state.turnCount = 0;
    state.lastMemoryToolCall = 0;
    state.lastAutoDecisionSave = 0;
    state.dreamTriggeredThisSession = false;
    state.hasInjectedContext = false;
    state.editedFiles = [];
    state.exploredFiles = [];

    const result = await dispatch('session-start', { project });
    // A nullish server value must NOT overwrite the default null — SessionEnd's
    // guard treats sessionId === null as "no session ever started" and skips the
    // summary. Only accept a concrete value so the two checks stay symmetric.
    if (result && result.sessionId !== undefined && result.sessionId !== null) {
      state.sessionId = result.sessionId;
      state.projectSessionCount = result.sessionCount || 0;
    }
    // Orphan recovery is automatic server-side; surface only if returned.
    stateStore.saveState(claudeSessionId, state);
  }

  // Inject (or re-inject after compact) context. sessionId may be null on a
  // failed session-start; context still loads without a session binding.
  const additionalContext = await buildInjectedContext({
    dispatch,
    getKnownRepos,
    project,
    cwd,
    query: null,
    sessionId: state.sessionId,
  }).catch(() => null);

  if (!additionalContext) {
    return null;
  }

  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  };
}

module.exports = { handleSessionStart };
