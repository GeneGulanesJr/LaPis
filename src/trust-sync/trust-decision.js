// src/trust-sync/trust-decision.js
// Slice E: trust invalidation review — opt-in, ADVISORY (never writes).
// For symbol-linked memories whose trust would DECAY, judge-verify whether the
// code changes actually invalidate the memory's content. High-p = the decay is
// justified; low-p = the memory survived semantically (candidate for recovery).

// No production caller yet (docs/JUDGMENT.md: "caller wiring pending"): turning
// the surface on changes nothing until a caller is wired. When one is, each
// call is ONE request per 10 links, capped at judgment.surface_timeout_ms with
// no retries (src/judgment/surface.js).
const { surfaceEnabled, buildSurfaceJudge } = require('../judgment/surface');
const { chunk, capText } = require('../judgment/internal');
const { logSurfaceCall, capReason, round3 } = require('../judgment/log');

const BATCH = 10;
// Prompt-state bounds: the claim names the decisive symbol; the changed list is
// context only, so it is truncated to keep questions cheap.
const MAX_CHANGED_SYMBOLS = 20;
const MAX_TITLE_LEN = 120;

/**
 * Guard: should the current process annotate trust sync with Decision? Default-off —
 * requires provider=decision + machine-scoped key + the trust surface not disabled
 * (LAPIS_JUDGE_DISABLE_TRUST=1). Mirrors dreamDecisionEnabled()/dedupeDecisionEnabled().
 */
function trustDecisionEnabled() {
  return surfaceEnabled('trust');
}

// Best-effort title enrichment — an advisory module must never let a DB hiccup
// become a caller-facing failure. Any error → no titles (state omits `title`).
function lookupTitles(deps, memoryIds) {
  try {
    const ids = [...new Set(memoryIds.filter((n) => Number.isFinite(n)))];
    if (!deps || typeof deps.sqlJson !== 'function' || ids.length === 0) return new Map();
    const placeholders = ids.map(() => '?').join(',');
    const rows = deps.sqlJson(`SELECT id, title FROM observations WHERE id IN (${placeholders})`, ids) || [];
    return new Map(rows.map((r) => [Number(r.id), typeof r.title === 'string' ? r.title : undefined]));
  } catch {
    return new Map();
  }
}

/**
 * decisionInvalidationReview(links, changedSymbols, args) — async, READ-ONLY.
 * links: DECAY candidates from evaluateTrustSync — the `adjusted` entries
 * ({memory_id, symbol_id, old_trust, new_trust}); raw symbol links carrying
 * trust_score are accepted too (shape tolerated, trust values unused by the
 * question itself). changedSymbols: array or Set of changed symbol names.
 * args._judge: test injection. args.deps ({sqlJson}): best-effort title lookup.
 * Returns {verified: [{memory_id, symbol_id, p, confidence, invalidated}]};
 * ANY failure → {verified: [], unavailable: true}. Never throws. Never writes.
 */
async function decisionInvalidationReview(links, changedSymbols, args = {}) {
  const started = Date.now();
  const rows = Array.isArray(links) ? links : [];
  const fail = (status, reason) => {
    logSurfaceCall('trust', started, { status, n: rows.length, reason: capReason(reason) });
    return { verified: [], unavailable: true, reason };
  };
  try {
    if (rows.length === 0) return { verified: [] };
    const judge = buildSurfaceJudge(args);
    const titles = lookupTitles(
      args.deps,
      rows.map((r) => Number(r.memory_id)),
    );
    const changed = [...(changedSymbols || [])].slice(0, MAX_CHANGED_SYMBOLS).map(String);
    const questions = rows.map((row, i) => {
      const title = titles.get(Number(row.memory_id));
      return {
        id: `trust-${i}`,
        judgment: {
          kind: 'probability',
          claim: `Memory #${row.memory_id} is invalidated by changes to ${row.symbol_id}`,
        },
        instructions: `\`memory_${i}\` is a saved memory linked to the code symbol named in the claim; \`changed_symbols\` lists the symbols that changed. p = probability the memory's content is now WRONG or misleading because of these code changes.`,
        // Own key per memory: the wire merges per-question states, so a shared
        // `memory` key let the last link overwrite the rest.
        state: {
          [`memory_${i}`]: { id: row.memory_id, ...(title ? { title: capText(title, MAX_TITLE_LEN) } : {}) },
          changed_symbols: changed,
        },
      };
    });
    const verified = [];
    for (const batch of chunk(questions, BATCH)) {
      const result = await judge(batch, { surface: 'trust' });
      if (!result || result.status !== 'ok') {
        return fail((result && result.status) || 'unavailable', result ? result.reason : 'no judge result');
      }
      for (const q of batch) {
        const answer = result.answers.find((a) => a.id === q.id);
        if (!answer || typeof answer.p !== 'number') continue;
        const row = rows[Number(q.id.split('-')[1])];
        verified.push({
          memory_id: row.memory_id,
          symbol_id: row.symbol_id,
          p: answer.p,
          confidence: answer.confidence,
          invalidated: answer.p >= 0.5,
        });
      }
    }
    logSurfaceCall('trust', started, {
      status: 'ok',
      n: rows.length,
      p: verified.map((v) => ({ id: v.memory_id, p: round3(v.p) })),
    });
    return { verified };
  } catch (e) {
    return fail('error', e && e.message);
  }
}

/**
 * maybeTrustDecisionReview(links, changedSymbols, deps, args) — the ONE guarded
 * entry point for callers. Returns null when disabled (callers annotate
 * nothing — identical to pre-slice behavior), otherwise the review report
 * (all failures already contained). args._judge passes through for tests;
 * deps (e.g. {sqlJson}) enables best-effort memory-title enrichment.
 */
async function maybeTrustDecisionReview(links, changedSymbols, deps, args = {}) {
  if (!trustDecisionEnabled()) return null;
  return decisionInvalidationReview(links, changedSymbols, deps ? { ...args, deps } : args);
}

module.exports = { trustDecisionEnabled, decisionInvalidationReview, maybeTrustDecisionReview };
