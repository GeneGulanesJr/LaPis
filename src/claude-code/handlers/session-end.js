'use strict';

/**
 * Claude Code SessionEnd handler.
 *
 * Awaited (Claude Code awaits SessionEnd before exit). Reads the transcript
 * via transcript-reader, builds a session summary, then runs `session-summary`
 * + `session-end`. The memory count passed to session-end is DB-derived
 * (SELECT COUNT(*) FROM observations WHERE session_id = ?), NOT the fragile
 * in-process counter, per #207. Clears the state file on the way out.
 *
 * Mirrors extensions/.../hooks/session-lifecycle.ts registerSessionShutdown.
 */

const { resolveCwd } = require('../../hooks-engine/project'),
  { resolveProjectForCwd } = require('../project-resolve'),
  { buildSessionSummary } = require('../../hooks-engine/session-summary'),
  { readTranscript } = require('../hooks-engine/transcript-reader');

async function handleSessionEnd({ payload, dispatch, dispatchClient, stateStore, getKnownRepos, getKnownProjects }) {
  const cwd = resolveCwd(payload.cwd),
    { project } = resolveProjectForCwd(cwd, getKnownRepos, getKnownProjects),
    claudeSessionId = payload.session_id,
    state = stateStore.loadState(claudeSessionId);

  // No session ever started (e.g. SessionStart failed) — nothing to close.
  if (state.sessionId === null || state.sessionId === undefined) {
    await stateStore.clearStateLocked(claudeSessionId);
    return null;
  }

  {
    const transcript = readTranscript(payload.transcript_path),
      // DB-derived count is authoritative for both summary text and session-end.
      memories = dispatchClient.countSessionMemories(state.sessionId),
      summaryContent = buildSessionSummary({
        userMessages: transcript.userMessages,
        assistantCount: transcript.assistantMessageCount,
        turnCount: state.turnCount,
        memoriesSaved: memories,
        editedFiles: state.editedFiles,
        cwd,
      });

    try {
      await dispatch('session-summary', { content: summaryContent, project });
      await dispatch('session-end', {
        id: String(state.sessionId),
        memories: String(memories),
        auto: 'true',
      });
    } catch (e) {
      // Best-effort on shutdown; never throw out of the handler. Still clear state.
      process.stderr.write(`claude-code session-end failed: ${e instanceof Error ? e.message : String(e)}\n`);
    }

    await stateStore.clearStateLocked(claudeSessionId);
    return null; // Silent — no stdout for SessionEnd
  }
}

module.exports = { handleSessionEnd };
