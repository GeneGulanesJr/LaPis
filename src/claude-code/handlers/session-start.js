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

const { resolveCwd } = require('../../hooks-engine/project'),
  { resolveProjectForCwd } = require('../project-resolve'),
  { buildInjectedContext } = require('../context-inject');

/**
 * Run SessionStart.
 *
 * @param {object} ctx
 * @param {object} ctx.payload           stdin JSON: { session_id, source, cwd, ... }
 * @param {Function} ctx.dispatch        injected dispatch (direct mode)
 * @param {Function} ctx.getKnownRepos   known code repos (direct mode read)
 * @param {Function} ctx.getKnownProjects known code+doc projects (direct mode read)
 * @param {object} ctx.stateStore        { mutateState, clearStateLocked, sweepStaleSessions }
 * @returns {Promise<object|null>}       Claude Code JSON or null
 */
async function handleSessionStart({ payload, dispatch, getKnownRepos, getKnownProjects, stateStore }) {
  const source = payload.source || 'startup',
    { project } = resolveProjectForCwd(payload.cwd, getKnownRepos, getKnownProjects),
    cwd = resolveCwd(payload.cwd),
    claudeSessionId = payload.session_id,
    isCompact = source === 'compact';

  let state;

  // Compact re-uses the existing sessionId and skips session-start entirely.
  // Both branches run through the locked mutateState: an unlocked full-file
  // write here could revert a concurrent PostToolUse/Stop hook's just-saved
  // state (Claude Code reuses session ids on resume/clear) (#296).

  if (!isCompact) {
    // GC orphaned state files from force-killed sessions before starting fresh.
    // The TTL honors LAPIS_SESSION_TTL_HOURS (default 24h); surface a sweep so
    // The user can correlate a missing state file (#233).
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

    const result = await dispatch('session-start', { project });
    // A nullish server value must NOT overwrite the default null — SessionEnd's
    // Guard treats sessionId === null as "no session ever started" and skips the
    // Summary. Only accept a concrete value so the two checks stay symmetric.
    state = await stateStore.mutateState(claudeSessionId, (current) => {
      // Reset session-derived counters for a genuine start. NOTE: mutateState
      // persists the state object it passed us — mutate it in place, never
      // return a fresh replacement.
      const next = {
        ...stateStore.defaultState(),
        nativeChecked: current.nativeChecked,
      };
      for (const key of Object.keys(current)) {
        delete current[key];
      }
      Object.assign(current, next);
      current.currentProject = project;
      if (result && result.sessionId !== undefined && result.sessionId !== null) {
        current.sessionId = result.sessionId;
        current.projectSessionCount = result.sessionCount || 0;
      }
      // Orphan recovery is automatic server-side; surface only if returned.
      return current;
    });
  } else {
    // Compact re-inject: refresh project when cwd moved (e.g. monorepo subdir).
    state = await stateStore.mutateState(claudeSessionId, (current) => {
      if (current.currentProject !== project) {
        current.currentProject = project;
      }
      return current;
    });
  }

  // Inject (or re-inject after compact) context. sessionId may be null on a
  // Failed session-start; context still loads without a session binding.
  {
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
}

module.exports = { handleSessionStart };
