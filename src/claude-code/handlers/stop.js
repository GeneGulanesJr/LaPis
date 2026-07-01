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
 */

const path = require('node:path');
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
 * Passive-capture an auto-decision from the last assistant message.
 */
async function passiveCapture({ dispatch, text, project, sessionId, state, now }) {
  if (!text || text.length < 100) {
    return;
  }
  if (isAutoDecisionCoolingDown(state.lastAutoDecisionSave, now, COOLDOWN_MS)) {
    return;
  }
  if (text.includes('memory-save') || text.includes('memory-search') || text.includes('memory-get')) {
    return;
  }

  const capture = shouldAutoCapture(text);
  const payload = buildAutoDecisionPayload({ text, capture, project, sessionId: state.sessionId });
  if (payload) {
    state.lastAutoDecisionSave = now;
    await dispatch('save', payload);
  }
}

/**
 * Progress checkpoint at turn % CHECKPOINT_INTERVAL.
 */
async function checkpoint({ dispatch, state, project }) {
  if (!project) {
    return;
  }

  const summaryFiles = state.editedFiles
    .slice(0, 10)
    .map((f) => `- ${path.basename(f)}`)
    .join('\n');

  let auditNote = '';
  try {
    const editedPaths = state.editedFiles.slice(0, 20);
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
      `**Learned**: ${state.memoriesSavedThisSession} explicit memories saved, ${state.editedFiles.length} files edited`,
      summaryFiles ? `Files touched:\n${summaryFiles}` : '',
      auditNote,
    ].join('\n'),
  });
}

/**
 * Flush pending negative-recall feedback.
 */
async function flushNegativeRecall({ dispatch, state }) {
  if (!state.pendingRecallFeedback || state.pendingRecallFeedback.length === 0) {
    return;
  }
  const entries = state.pendingRecallFeedback.map(([memoryId, meta]) => ({
    memoryId,
    sessionId: meta?.sessionId,
    query: meta?.query,
    wasUseful: false,
  }));
  await dispatch('log-negative-recall', { entries: JSON.stringify(entries) });
  state.pendingRecallFeedback = [];
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

  const state = stateStore.loadState(claudeSessionId);
  state.turnCount += 1;
  const now = Date.now();

  // Only the cheap inline field read happens synchronously; the transcript
  // fallback (async stream read) runs inside runStopCapture, after we return, so
  // Stop never blocks Claude Code's turn progression.
  const lastText = extractInlineAssistantText(payload);

  // All capture work is fire-and-forget: Stop must not block Claude Code.
  // Exposed as runStopCapture for deterministic testing.
  void runStopCapture({
    dispatch,
    stateStore,
    claudeSessionId,
    state,
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
  state,
  project,
  now,
  lastText,
  transcriptPath,
}) {
  try {
    // Transcript fallback is resolved here (async stream read), off the
    // synchronous hook path; passive capture uses the resulting text.
    const text = await resolveAssistantText(lastText, transcriptPath);
    await passiveCapture({ dispatch, text, project, state, now });

    if (shouldDream(state.turnCount, state.dreamTriggeredThisSession)) {
      state.dreamTriggeredThisSession = true;
      try {
        await dispatch('dream', {});
      } catch {
        // Auto-dream is best-effort.
      }
    }

    await flushNegativeRecall({ dispatch, state });

    if (shouldCheckpoint(state.turnCount, CHECKPOINT_EVERY)) {
      await checkpoint({ dispatch, state, project });
    }

    stateStore.saveState(claudeSessionId, state);
  } catch {
    // Never throw out of a Stop handler; persist best-effort.
    try {
      stateStore.saveState(claudeSessionId, state);
    } catch {}
  }
}

module.exports = { handleStop, runStopCapture };
