// src/judgment/evaluate.js
// Pure policy evaluation (spec §6 rule R4). The ONLY place dangerous-answer
// polarity is interpreted. Call sites never compare raw answers (RetellMCP
// P1 #1: polarity inversion happened when call sites did their own ===).
// Unit-tested without HTTP fakes by design.

/**
 * evaluate({ questions, answers, threshold, strictConfidence })
 *   questions: Question[] (as sent)
 *   answers:   Answer[] (from a status:'ok' Result)
 *   threshold: confidence floor for blocking (default from internal.CONFIDENT_THRESHOLD)
 *   strictConfidence: when true, sub-floor dangerous picks ESCALATE instead of warn
 * Returns { ok, blocked:[{id,reason}], warned:[...], escalated:[...] }
 * ok === blocked.length === 0 — warned/escalated never block (advisory rule).
 */
function evaluate({ questions, answers, threshold, strictConfidence = false }) {
  const floor = typeof threshold === 'number' ? threshold : require('./internal').CONFIDENT_THRESHOLD;
  const qById = new Map(questions.map((q) => [q.id, q]));
  const blocked = [];
  const warned = [];
  const escalated = [];

  for (const a of answers) {
    const q = qById.get(a.id);
    if (!q) continue; // validated upstream (R3); ignore silently here
    const j = q.judgment;

    let dangerous = false;
    let confidence = a.confidence;
    if (j.kind === 'classify' && j.dangerous !== undefined) {
      dangerous = a.pick === j.dangerous;
    } else if (j.kind === 'probability') {
      // claim true (p > 0.5) is the dangerous condition for probability questions
      dangerous = typeof a.p === 'number' && a.p > 0.5;
      if (dangerous && (confidence === undefined || confidence === null)) confidence = a.p; // use p when confidence absent
    }
    if (!dangerous) continue;

    const conf = typeof confidence === 'number' && Number.isFinite(confidence) ? confidence : null;
    if (conf === null || conf < floor) {
      if (strictConfidence) {
        escalated.push({
          id: a.id,
          reason: `dangerous answer with ${conf === null ? 'missing' : 'sub-floor'} confidence ${conf}`,
        });
      } else {
        warned.push({ id: a.id, reason: `dangerous answer below confidence floor (${conf})` });
      }
    } else {
      blocked.push({ id: a.id, reason: `dangerous answer at confidence ${conf}` });
    }
  }

  return { ok: blocked.length === 0, blocked, warned, escalated };
}

module.exports = { evaluate };
