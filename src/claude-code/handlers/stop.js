'use strict';

/**
 * Claude Code Stop handler.
 *
 * SILENT + ASYNC-ONLY. Emits no stdout (returns null) so Claude Code does not
 * continue the turn / loop. Ports passive-capture.ts message_end + turn_end:
 * passive-capture on the last assistant message, progress checkpoint at
 * turn % 10, dream at turn 50, negative-recall flush. All fire-and-forget.
 *
 * Defensive: if payload.stop_hook_active is truthy, return immediately to avoid
 * re-entrancy loops.
 *
 * State writes route through mutateState so parallel PostToolUse hooks cannot
 * be clobbered by a stale snapshot (#228). Slow gateway dispatches run OUTSIDE
 * the file lock so PostToolUse hooks are not blocked for the dispatch duration.
 */

const path = require('node:path');
const { uniqueEditedPaths } = require('../file-keys');
const { makeMutate } = require('../state-mutate');
const { resolveCwd, projectFromCwd } = require('../../hooks-engine/project');
const { extractMessageText } = require('../../hooks-engine/prompt-classifiers');
const { shouldAutoCapture } = require('../../hooks-engine/pattern-matcher');
const { readTranscriptStream } = require('../hooks-engine/transcript-reader');
const {
  buildAutoDecisionPayload,
  shouldCheckpoint,
  shouldDream,
  isAutoDecisionCoolingDown,
} = require('../../hooks-engine/passive-capture');

// Thresholds mirror extensions/memory-layer/state.ts (CHECKPOINT_INTERVAL /
// AUTO_DECISION_COOLDOWN) and the hooks-engine passive-capture defaults.
const CHECKPOINT_EVERY = 10;
const COOLDOWN_MS = 60000;

function extractInlineAssistantText(payload) {
  // Preferred inline field (#207). Newer Claude Code builds may ship the last
  // assistant message directly; older builds only send transcript_path, which
  // is resolved asynchronously inside runStopCapture (see resolveAssistantText)
  // so the file read never blocks handleStop's synchronous return.
  const inline = payload?.last_assistant_message || payload?.assistant_message;
  const inlineText = extractMessageText(inline);
  if (typeof inlineText === 'string' && inlineText.trim()) {
    return inlineText;
  }
  return '';
}

/**
 * Resolve the last assistant message text for capture. The inline payload
 * field is read synchronously (cheap); only when it is absent does this read
 * the transcript_path via the async streaming reader. Called from runStopCapture
 * (the fire-and-forget async path) so any file I/O happens after handleStop has
 * already returned and Claude Code can proceed with its turn.
 */
async function resolveAssistantText(lastText, transcriptPath) {
  if (typeof lastText === 'string' && lastText.trim()) {
    return lastText;
  }
  if (transcriptPath) {
    try {
      const { lastAssistantText } = await readTranscriptStream(transcriptPath);
      if (typeof lastAssistantText === 'string' && lastAssistantText.trim()) {
        return lastAssistantText;
      }
    } catch {
      // Transcript read is best-effort.
    }
  }
  return '';
}

/**
 * Progress checkpoint at turn % CHECKPOINT_INTERVAL.
 */
async function checkpoint({ dispatch, state, project }) {
  if (!project) {
    return;
  }

  const editedPaths = uniqueEditedPaths(state.editedFiles).slice(0, 20);
  const summaryFiles = editedPaths
    .slice(0, 10)
    .map((f) => `- ${path.basename(f)}`)
    .join('\n');

  let auditNote = '';
  try {
    if (editedPaths.length > 0) {
      const auditResult = await dispatch('audit-diff', {
        repo: project,
        files: editedPaths.join(','),
        task: `checkpoint turn ${state.turnCount}`,
      });
      if (auditResult && !auditResult.error && auditResult.violations?.length > 0) {
        auditNote = `\n\n**Post-edit audit**: ${auditResult.risk} risk, ${auditResult.violations.length} violation(s): ${auditResult.violations
          .slice(0, 3)
          .map((v) => v.message)
          .join('; ')}`;
      }
    }
  } catch {
    // audit-diff is optional.
  }

  await dispatch('save', {
    title: `Progress checkpoint (turn ${state.turnCount})`,
    type: 'progress',
    project,
    scope: 'project',
    force: 'true',
    content: [
      `**What**: Auto-checkpoint at turn ${state.turnCount}`,
      `**Where**: Session ${state.sessionId}`,
      `**Learned**: ${state.memoriesSavedThisSession} explicit memories saved, ${editedPaths.length} files edited`,
      summaryFiles ? `Files touched:\n${summaryFiles}` : '',
      auditNote,
    ].join('\n'),
  });
}

async function handleStop({ payload, dispatch, stateStore }) {
  // Avoid re-entrancy: Claude Code sets stop_hook_active when already inside a
  // stop continuation. Bail out so we never create a feedback loop.
  if (payload?.stop_hook_active) {
    return null;
  }

  const cwd = resolveCwd(payload.cwd);
  const project = projectFromCwd(cwd);
  const claudeSessionId = payload.session_id;
  const now = Date.now();
  const mutate = makeMutate(stateStore, claudeSessionId);

  const turnCount = await mutate((state) => {
    state.turnCount += 1;
    return state.turnCount;
  });

  const lastText = extractInlineAssistantText(payload);

  // All capture work is fire-and-forget: Stop must not block Claude Code.
  void runStopCapture({
    dispatch,
    stateStore,
    claudeSessionId,
    turnCount,
    project,
    now,
    lastText,
    transcriptPath: payload?.transcript_path,
  }).catch(() => {});

  return null; // silent — no stdout, no turn continuation
}

/**
 * The awaited capture work. handleStop runs this fire-and-forget so the host
 * never blocks on it; tests call it directly to assert dispatch behavior.
 */
async function runStopCapture({
  dispatch,
  stateStore,
  claudeSessionId,
  turnCount,
  project,
  now,
  lastText,
  transcriptPath,
}) {
  const mutate = makeMutate(stateStore, claudeSessionId);

  try {
    const text = await resolveAssistantText(lastText, transcriptPath);

    // Passive capture: locked read → dispatch (unlocked) → locked cooldown stamp.
    const autoPayload = await mutate((state) => {
      if (!text || text.length < 100) {
        return null;
      }
      if (isAutoDecisionCoolingDown(state.lastAutoDecisionSave, now, COOLDOWN_MS)) {
        return null;
      }
      if (text.includes('memory-save') || text.includes('memory-search') || text.includes('memory-get')) {
        return null;
      }
      const capture = shouldAutoCapture(text);
      return buildAutoDecisionPayload({ text, capture, project, sessionId: state.sessionId });
    });
    if (autoPayload) {
      try {
        await dispatch('save', autoPayload);
        await mutate((state) => {
          state.lastAutoDecisionSave = now;
        });
      } catch {
        // Passive capture is best-effort; cooldown not stamped on failure.
      }
    }

    // Dream: claim the once-per-session flag under lock, dispatch outside it.
    const runDream = await mutate((state) => {
      if (!shouldDream(turnCount, state.dreamTriggeredThisSession)) {
        return false;
      }
      state.dreamTriggeredThisSession = true;
      return true;
    });
    if (runDream) {
      try {
        await dispatch('dream', {});
      } catch {
        // Auto-dream is best-effort.
      }
    }

    // Negative recall: drain the queue under lock, dispatch outside it.
    const recallEntries = await mutate((state) => {
      if (!state.pendingRecallFeedback || state.pendingRecallFeedback.length === 0) {
        return null;
      }
      const entries = state.pendingRecallFeedback.map(([memoryId, meta]) => ({
        memoryId,
        sessionId: meta?.sessionId,
        query: meta?.query,
        wasUseful: false,
      }));
      state.pendingRecallFeedback = [];
      return entries;
    });
    if (recallEntries) {
      try {
        await dispatch('log-negative-recall', { entries: JSON.stringify(recallEntries) });
      } catch {
        // Negative-recall flush is best-effort.
      }
    }

    if (shouldCheckpoint(turnCount, CHECKPOINT_EVERY)) {
      const state = stateStore.loadState(claudeSessionId);
      await checkpoint({ dispatch, state, project });
    }
  } catch {
    // Never throw out of a Stop handler.
  }
}

module.exports = { handleStop, runStopCapture };
