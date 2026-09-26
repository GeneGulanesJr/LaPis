// src/judgment/contract.js
// LaPis-owned judgment vocabulary (spec §6). Provider names (choice/noul/score)
// NEVER appear outside adapters/jev.js (rule R1).
//
// Question = {
//   id: string,
//   judgment: { kind: 'classify', enum: string[], dangerous?: string }   // dangerous = the enum value meaning "unsafe/bad"
//            | { kind: 'probability', claim: string }                    // claim true ≈ p > 0.5
//            | { kind: 'grade', levels: string[] },                      // ordered low → high
//   instructions: string,       // self-contained meaning
//   state: object,              // named fields; sent to provider as JSON state
// }
// Answer = { id, pick?|p?|level?, confidence }   // confidence ∈ [0,1]
// Result = { status: 'ok', answers } | { status: 'unavailable', reason } | { status: 'invalid', reason }

/** Surfaces that will consume judgments (docs/JUDGMENT.md flag matrix keys). */
const SURFACES = ['dream', 'autosave', 'dedupe', 'guard', 'recall', 'trust', 'context'];

/** Throws with a precise message when q is not a well-formed Question. */
function assertValidQuestion(q) {
  if (!q || typeof q !== 'object') throw new Error('question must be an object');
  if (typeof q.id !== 'string' || q.id.length === 0) throw new Error('question.id must be a non-empty string');
  const j = q.judgment;
  if (!j || typeof j !== 'object') throw new Error('question.judgment is required');
  if (j.kind === 'classify') {
    if (!Array.isArray(j.enum) || j.enum.length === 0) throw new Error('classify judgment requires non-empty enum');
    if (j.dangerous !== undefined && !j.enum.includes(j.dangerous))
      throw new Error('classify.dangerous must be one of enum');
  } else if (j.kind === 'probability') {
    if (typeof j.claim !== 'string' || j.claim.length === 0) throw new Error('probability judgment requires claim');
  } else if (j.kind === 'grade') {
    if (!Array.isArray(j.levels) || j.levels.length < 2) throw new Error('grade judgment requires 2+ levels');
  } else {
    throw new Error(`unknown judgment kind: ${j.kind}`);
  }
  if (typeof q.instructions !== 'string' || q.instructions.length === 0)
    throw new Error('question.instructions must be a non-empty string');
  if (!q.state || typeof q.state !== 'object' || Array.isArray(q.state) || Object.keys(q.state).length === 0) {
    throw new Error('question.state must be a non-empty object');
  }
}

function _isFinite01(x) {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;
}

/** Boundary validation (rule R3): throws when answers don't satisfy the questions. */
function assertValidAnswers(questions, answers) {
  if (!Array.isArray(answers)) throw new Error('answers must be an array');
  const byId = new Map(questions.map((q) => [q.id, q]));
  for (const a of answers) {
    const q = byId.get(a.id);
    if (!q) throw new Error(`unknown answer id: ${a.id}`);
    if (!_isFinite01(a.confidence)) throw new Error(`answer ${a.id}: confidence must be a number in [0,1]`);
    const kind = q.judgment.kind;
    if (kind === 'classify') {
      if (typeof a.pick !== 'string' || !q.judgment.enum.includes(a.pick)) {
        throw new Error(`answer ${a.id}: pick must be one of enum`);
      }
    } else if (kind === 'probability') {
      if (!_isFinite01(a.p)) throw new Error(`answer ${a.id}: p must be a number in [0,1]`);
    } else if (kind === 'grade') {
      if (!Number.isInteger(a.level) || a.level < 0 || a.level >= q.judgment.levels.length) {
        throw new Error(`answer ${a.id}: level must index levels`);
      }
    }
  }
}

module.exports = { assertValidQuestion, assertValidAnswers, SURFACES };
