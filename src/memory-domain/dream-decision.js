// src/memory-domain/dream-decision.js
// Slice 1: Dream Cycle Decision review — ADVISORY ANNOTATION ONLY (spec §10).
// Re-runs the dream() Phase-1 (superseded) and Phase-4 (corrections) candidate
// queries and judge-verifies each pair. NEVER deletes: the report annotates
// which candidates the judgment would keep. All failures degrade to an
// ok/unavailable report — the dream pipeline never depends on this module.
//
// Runs inside the gateway `dream` command (and scripts/cleanup-sessions.js;
// Pi triggers `dream` once per session at turn 50): one request per 10
// candidates, each capped at judgment.surface_timeout_ms with no retries; the
// createJudge() breaker stops after 3 consecutive failures.

const { DEDUP } = require('../../constants');
const { getConfig } = require('../../config');
const { surfaceEnabled, buildSurfaceJudge } = require('../judgment/surface');
const { chunk, capText } = require('../judgment/internal');
const { logSurfaceCall, capReason, round3 } = require('../judgment/log');

const BATCH = 10;
// Source of truth: constants.js DEDUP.DREAM_SUPERSEDED_CONFIDENCE, interpolated
// exactly like compaction.js dream() Phase-1/Phase-4 candidate queries.
const SUPERSEDED_SQL = `
  SELECT o.id, o.title, o.type, o.project, o.content,
         r.source_id AS newer_id, r.relation, r.confidence,
         newer.title AS newer_title, newer.content AS newer_content
  FROM observations o
  JOIN observation_relations r ON r.target_id = o.id
  JOIN observations newer ON newer.id = r.source_id
  WHERE r.relation IN ('duplicate', 'supersedes')
    AND o.deleted_at IS NULL AND newer.deleted_at IS NULL
    AND r.confidence >= ${DEDUP.DREAM_SUPERSEDED_CONFIDENCE}
`;
const CORRECTIONS_SQL = `
  SELECT id, title, content, project FROM observations
  WHERE (title LIKE 'CORRECTION:%' OR title LIKE 'Correction:%') AND deleted_at IS NULL
`;

// verifyBatch calls judge(batch, ...) as a plain function — the shared seam
// returns the judge FUNCTION, not the { provider, probe, judge } object.
function buildJudge(args) {
  return buildSurfaceJudge(args);
}

function verdictOf(answer) {
  if (!answer || typeof answer.p !== 'number') return { verdict: 'unknown' };
  return { verdict: answer.p >= 0.5 ? 'superseded' : 'keep', p: answer.p, confidence: answer.confidence };
}

async function verifyBatch(judge, kind, rows) {
  const questions = rows.map((row, i) => ({
    id: `${kind}-${i}`,
    judgment: {
      kind: 'probability',
      claim:
        kind === 'sup'
          ? `Memory #${row.id} (${capText(row.title, 60)}) is fully superseded by memory #${row.newer_id} (${capText(row.newer_title, 60)})`
          : `Correction entry #${row.id} (${capText(row.title, 60)}) is fully absorbed into the memory it references`,
    },
    // Own keys per pair: the wire merges per-question states, so shared
    // memory_a/memory_b keys let the last pair overwrite the rest.
    instructions:
      kind === 'sup'
        ? `Decide whether \`memory_a_${i}\` is FULLY superseded — nothing unique remains — by \`memory_b_${i}\`. p = probability of full supersession.`
        : `Decide whether the correction entry \`correction_${i}\` has been fully absorbed (its fix applied) into the memory it references, so the entry itself can be retired. p = probability of full absorption.`,
    state:
      kind === 'sup'
        ? {
            [`memory_a_${i}`]: { id: row.id, title: row.title, content: capText(row.content || '', 400) },
            [`memory_b_${i}`]: {
              id: row.newer_id,
              title: row.newer_title,
              content: capText(row.newer_content || '', 400),
            },
          }
        : { [`correction_${i}`]: { id: row.id, title: row.title, content: capText(row.content || '', 400) } },
  }));
  const verified = [];
  for (const batch of chunk(questions, BATCH)) {
    const result = await judge(batch, { surface: 'dream' });
    if (!result || result.status !== 'ok') {
      return {
        verified,
        unavailable: true,
        status: (result && result.status) || 'unavailable',
        reason: result && result.reason,
      };
    }
    for (const q of batch) {
      const answer = result.answers.find((a) => a.id === q.id);
      const row = rows[Number(q.id.split('-')[1])];
      verified.push(
        kind === 'sup'
          ? { id: row.id, newer_id: row.newer_id, title: row.title, ...verdictOf(answer) }
          : { id: row.id, title: row.title, ...verdictOf(answer) },
      );
    }
  }
  return { verified, unavailable: false };
}

/**
 * dreamDecisionReview(deps, args) — async, advisory.
 * deps: { sqlJson } (same handle style as compaction domain). args._judge: test injection.
 * Returns { ok, provider, unavailable?, superseded: {candidates, verified}, corrections: {candidates, verified} }.
 */
async function dreamDecisionReview(deps, args = {}) {
  const report = { ok: true, provider: 'heuristic' };
  const started = Date.now();
  try {
    const judge = buildJudge(args);
    report.provider = judge.provider || (getConfig().judgment || {}).provider || 'heuristic';
    const supRows = deps.sqlJson(SUPERSEDED_SQL);
    const corRows = deps.sqlJson(CORRECTIONS_SQL);
    const sup = await verifyBatch(judge, 'sup', supRows || []);
    const cor = await verifyBatch(judge, 'cor', corRows || []);
    if (sup.unavailable || cor.unavailable) report.unavailable = true;
    report.superseded = { candidates: (supRows || []).length, verified: sup.verified };
    report.corrections = { candidates: (corRows || []).length, verified: cor.verified };
    const failed = sup.unavailable ? sup : cor.unavailable ? cor : null;
    const n = report.superseded.candidates + report.corrections.candidates;
    if (n > 0) {
      logSurfaceCall('dream', started, {
        status: failed ? failed.status : 'ok',
        ...(failed ? { reason: capReason(failed.reason) } : {}),
        superseded: report.superseded.candidates,
        corrections: report.corrections.candidates,
        p: [...sup.verified, ...cor.verified]
          .filter((v) => typeof v.p === 'number')
          .map((v) => ({ id: v.id, p: round3(v.p) })),
      });
    }
  } catch (e) {
    report.ok = true; // advisory: even our own errors never fail the caller
    report.unavailable = true;
    report.reason = e.message;
    logSurfaceCall('dream', started, { status: 'error', reason: capReason(e.message) });
  }
  return report;
}

/**
 * Guard: should the current process annotate dreams with Decision? Default-off —
 * requires provider=decision + machine-scoped key + surface not disabled.
 */
function dreamDecisionEnabled() {
  return surfaceEnabled('dream');
}

/**
 * maybeDreamDecisionReview(deps, args) — the ONE guarded entry point for callers
 * (gateway dream command, cleanup-sessions CLI). Returns null when disabled
 * (callers then annotate nothing — identical to pre-judgment behavior),
 * otherwise the dreamDecisionReview report (all failures already contained).
 * args._judge passes through for tests.
 */
async function maybeDreamDecisionReview(deps, args = {}) {
  if (!dreamDecisionEnabled()) return null;
  return dreamDecisionReview(deps, args);
}

module.exports = { dreamDecisionReview, maybeDreamDecisionReview, dreamDecisionEnabled };
