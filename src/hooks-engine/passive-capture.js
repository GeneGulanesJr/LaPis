'use strict';

/**
 * Hooks-engine: passive-capture
 *
 * Pure payload builder + gating helpers extracted from
 * extensions/memory-layer/hooks/passive-capture.ts. Thresholds are passed as
 * parameters (no state.ts import) so both the Pi extension and the future
 * Claude Code bridge can reuse them.
 */

/**
 * Build the auto-decision save payload from a matched capture.
 * Mirrors passive-capture.ts:71-84.
 *
 * @param {object} input
 * @param {string} input.text
 * @param {{match:boolean,confidence:string,pattern?:object}} input.capture
 * @param {string} input.project
 * @param {number|string|null} input.sessionId
 * @returns {{title:string,type:string,project:string,scope:string,content:string}|null}
 */
function buildAutoDecisionPayload({ text, capture, project, sessionId }) {
  if (!capture || !capture.match || capture.confidence === 'low' || !capture.pattern) {
    return null;
  }

  const lastLine =
      text
        .split('\n')
        .filter((l) => l.trim())
        .pop()
        ?.slice(0, 120) || text.slice(0, 120),
    title = `${capture.pattern.label}: ${lastLine.slice(0, 80)}`;

  return {
    title,
    type: capture.pattern.type,
    project: project || 'unknown',
    scope: 'project',
    content: [
      `**What**: Auto-detected ${capture.pattern.label.toLowerCase()} (confidence: ${capture.confidence})`,
      `**Where**: Session ${sessionId || 'unknown'}`,
      `**Learned**: ${text.slice(0, 300)}`,
    ].join('\n'),
  };
}

/**
 * Whether a progress checkpoint should fire this turn.
 * Mirrors passive-capture.ts:119 (turnCount % CHECKPOINT_INTERVAL === 0 && turnCount !== 0).
 */
function shouldCheckpoint(turn, interval = 10) {
  return turn % interval === 0 && turn !== 0;
}

/**
 * Whether the Dream Cycle should trigger this turn.
 * Mirrors passive-capture.ts:92 (turn === 50 && !already).
 */
function shouldDream(turn, already, threshold = 50) {
  return turn === threshold && !already;
}

/**
 * Whether auto-decision capture is cooling down.
 * Mirrors passive-capture.ts:59 (Date.now() - lastSave < AUTO_DECISION_COOLDOWN).
 */
function isAutoDecisionCoolingDown(lastSave, now = Date.now(), cooldown = 60000) {
  return now - lastSave < cooldown;
}

module.exports = {
  buildAutoDecisionPayload,
  shouldCheckpoint,
  shouldDream,
  isAutoDecisionCoolingDown,
};
