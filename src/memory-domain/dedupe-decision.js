// src/memory-domain/dedupe-decision.js
// Slice D: semantic dedup verification — opt-in, advisory, READ-ONLY. Takes the
// trigram candidates of a save that stopped at `potential_duplicate` and
// judge-verifies 'same decision?' per pair; the probabilities are attached to
// the save result as `decisionVerified`. Nothing reads them to merge, retire or
// delete: the save path never auto-merges (see observations.js save).
//
// Runs once per save that returns potential_duplicate (at most 3 matches → ONE
// request), capped at judgment.surface_timeout_ms with no retries.

// Lazy judgment modules: commands/observation.js requires this on every save.
const { surfaceEnabled, buildSurfaceJudge } = require('../judgment/surface');

const BATCH = 10;

function dedupeDecisionEnabled() {
  return surfaceEnabled('dedupe');
}

// checkDuplicate() returns id/title/similarity only; the existing memory's
// content is looked up (best-effort, read-only) so the judge compares content,
// not titles alone. Any error → no content (the question still carries titles).
function lookupContents(deps, ids) {
  try {
    const unique = [...new Set(ids.filter((n) => n !== undefined && n !== null))];
    if (!deps || typeof deps.sqlJson !== 'function' || unique.length === 0) return new Map();
    const placeholders = unique.map(() => '?').join(',');
    const rows = deps.sqlJson(`SELECT id, content FROM observations WHERE id IN (${placeholders})`, unique) || [];
    return new Map(rows.map((r) => [String(r.id), typeof r.content === 'string' ? r.content : '']));
  } catch {
    return new Map();
  }
}

/**
 * decisionVerifyDuplicates(deps, candidates, args) — async, READ-ONLY (never writes).
 * candidates: [{id, title, content?}] from checkDuplicate. Returns
 * {verified: [{id, title, p, confidence, same: boolean}], unavailable?}.
 */
async function decisionVerifyDuplicates(deps, candidates, args = {}) {
  const { chunk, capText } = require('../judgment/internal');
  const { logSurfaceCall, capReason, round3 } = require('../judgment/log');
  const verified = [];
  const rows = candidates || [];
  if (rows.length === 0) return { verified };
  const started = Date.now();
  const fail = (status, reason) => {
    logSurfaceCall('dedupe', started, { status, n: rows.length, reason: capReason(reason) });
    return { verified, unavailable: true };
  };
  try {
    const contents = lookupContents(
      deps,
      rows.filter((c) => !c.content).map((c) => c.id),
    );
    // The wire merges per-question states: each existing memory gets its own
    // key (`existing_i`); `incoming` is the same for every question.
    const questions = rows.map((c, i) => ({
      id: `dup-${i}`,
      judgment: { kind: 'probability', claim: `The new memory duplicates memory #${c.id} (${capText(c.title, 60)})` },
      instructions: `Decide whether \`incoming\` records the SAME decision/content as the existing memory \`existing_${i}\` — nothing semantically new. p = probability of duplication.`,
      state: {
        [`existing_${i}`]: {
          id: c.id,
          title: c.title,
          content: capText(c.content || contents.get(String(c.id)) || '', 400),
        },
        incoming: { title: args.incomingTitle || '', content: capText(args.incomingContent || '', 400) },
      },
    }));
    const judge = buildSurfaceJudge(args);
    for (const batch of chunk(questions, BATCH)) {
      const result = await judge(batch, { surface: 'dedupe' });
      if (!result || result.status !== 'ok') {
        return fail((result && result.status) || 'unavailable', result && result.reason);
      }
      for (const a of result.answers) {
        const row = rows[Number(a.id.split('-')[1])];
        verified.push({ id: row.id, title: row.title, p: a.p, confidence: a.confidence, same: a.p >= 0.5 });
      }
    }
  } catch (e) {
    return fail('error', e && e.message);
  }
  logSurfaceCall('dedupe', started, {
    status: 'ok',
    n: rows.length,
    p: verified.map((v) => ({ id: v.id, p: round3(v.p) })),
  });
  return { verified };
}

module.exports = { decisionVerifyDuplicates, dedupeDecisionEnabled };
