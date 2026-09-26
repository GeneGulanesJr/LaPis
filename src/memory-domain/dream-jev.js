// src/memory-domain/dream-jev.js
// Slice 1: Dream Cycle Jev review — ADVISORY ANNOTATION ONLY (spec §10).
// Re-runs the dream() Phase-1 (superseded) and Phase-4 (corrections) candidate
// queries and judge-verifies each pair. NEVER deletes: the report annotates
// which candidates the judgment would keep. All failures degrade to an
// ok/unavailable report — the dream pipeline never depends on this module.

const { DEDUP } = require('../../constants');
const { createJudge } = require('../judgment');
const { createJevAdapter } = require('../judgment/adapters/jev');
const { getConfig } = require('../../config');
const { chunk, capText } = require('../judgment/internal');

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

function buildJudge(args) {
  if (args && args._judge) return args._judge;
  const cfg = getConfig().judgment || {};
  const adapters = cfg.provider === 'jev' ? { jev: createJevAdapter({ apiKey: process.env.TYPESAFE_API_KEY }) } : {};
  return createJudge({ config: getConfig(), adapters });
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
    instructions:
      kind === 'sup'
        ? 'Decide whether the first memory is FULLY superseded — nothing unique remains — by the second. p = probability of full supersession.'
        : 'Decide whether this correction entry has been fully absorbed (its fix applied) into the referenced memory, so the entry itself can be retired. p = probability of full absorption.',
    state:
      kind === 'sup'
        ? {
            memory_a: { id: row.id, title: row.title, content: capText(row.content || '', 400) },
            memory_b: { id: row.newer_id, title: row.newer_title, content: capText(row.newer_content || '', 400) },
          }
        : { correction: { id: row.id, title: row.title, content: capText(row.content || '', 400) } },
  }));
  const verified = [];
  for (const batch of chunk(questions, BATCH)) {
    const result = await judge(batch, { surface: 'dream' });
    if (!result || result.status !== 'ok') return { verified, unavailable: true };
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
 * dreamJevReview(deps, args) — async, advisory.
 * deps: { sqlJson } (same handle style as compaction domain). args._judge: test injection.
 * Returns { ok, provider, unavailable?, superseded: {candidates, verified}, corrections: {candidates, verified} }.
 */
async function dreamJevReview(deps, args = {}) {
  const report = { ok: true, provider: 'heuristic' };
  try {
    const judge = buildJudge(args);
    report.provider = judge.provider;
    const supRows = deps.sqlJson(SUPERSEDED_SQL);
    const corRows = deps.sqlJson(CORRECTIONS_SQL);
    const sup = await verifyBatch(judge, 'sup', supRows || []);
    const cor = await verifyBatch(judge, 'cor', corRows || []);
    if (sup.unavailable || cor.unavailable) report.unavailable = true;
    report.superseded = { candidates: (supRows || []).length, verified: sup.verified };
    report.corrections = { candidates: (corRows || []).length, verified: cor.verified };
  } catch (e) {
    report.ok = true; // advisory: even our own errors never fail the caller
    report.unavailable = true;
    report.reason = e.message;
  }
  return report;
}

module.exports = { dreamJevReview };
