// src/memory-domain/search-decision.js
// Slice A: semantic rerank of lexical search results — opt-in, advisory.
// Takes the already-ranked rows from rankObservations and re-orders the top-N
// by a Decision grade judgment ('central' > 'related' > 'irrelevant'). Never throws;
// any judgment failure returns the input order unchanged.
//
// Runs on every `search` dispatch when on (CLI `search`, the Claude Code and Pi
// `memory-search` tools): ONE request for the default top 10, capped at
// judgment.surface_timeout_ms with no retries (src/judgment/surface.js).

// Judgment modules load lazily inside decisionRerank(): this file is required on
// EVERY search dispatch (the enabled check lives here), and the default config
// has decision disabled — eagerly requiring the judgment layer made every
// fresh-process search dispatch pay ~10ms for an opt-in feature it never used.
const { surfaceEnabled, buildSurfaceJudge } = require('../judgment/surface');

const LEVELS = ['irrelevant', 'related', 'central'];
const BATCH = 10;

function searchDecisionEnabled() {
  return surfaceEnabled('recall');
}

/**
 * decisionRerank(rows, query, args) — async. rows: lexically-ranked observations
 * (each has id, title, snippet or content). Returns {rows, reranked, unavailable?}
 * where rows are re-ordered ONLY by level (stable within equal levels) and each
 * reranked row carries `decision: {level, confidence}`.
 */
async function decisionRerank(rows, query, args = {}) {
  const { chunk, capText } = require('../judgment/internal');
  const { logSurfaceCall, capReason } = require('../judgment/log');
  const topN = Number(args.topN ?? 10);
  const head = (rows || []).slice(0, topN);
  const tail = (rows || []).slice(topN);
  if (head.length === 0) return { rows: rows || [], reranked: false };
  const started = Date.now();
  const unchanged = (status, reason) => {
    logSurfaceCall('recall', started, { status, n: head.length, reason: capReason(reason) });
    return { rows: rows || [], reranked: false, unavailable: true };
  };
  // The wire takes ONE merged state per request, so each row lives under its
  // own key — a shared `memory` key let the last row overwrite the rest and
  // every question graded the same memory.
  const questions = head.map((row, i) => ({
    id: `rr-${i}`,
    judgment: { kind: 'grade', levels: LEVELS },
    instructions: `Rate how relevant the memory \`memory_${i}\` is to \`query\`. central = directly answers or is about the query; related = touches the topic; irrelevant = unrelated.`,
    state: {
      query,
      [`memory_${i}`]: { id: row.id, title: row.title, snippet: capText(row.snippet || row.content || '', 400) },
    },
  }));
  const byId = new Map();
  try {
    const judge = buildSurfaceJudge(args);
    for (const batch of chunk(questions, BATCH)) {
      const result = await judge(batch, { surface: 'recall' });
      if (!result || result.status !== 'ok') {
        return unchanged((result && result.status) || 'unavailable', result && result.reason);
      }
      for (const a of result.answers) byId.set(a.id, a);
    }
  } catch (e) {
    return unchanged('error', e && e.message);
  }
  const graded = head.map((row, i) => {
    const a = byId.get(`rr-${i}`);
    const level = a && typeof a.level === 'number' ? a.level : 0;
    return { ...row, decision: { level, confidence: a ? a.confidence : 0, relevance: LEVELS[level] } };
  });
  // Stable sort: central first, then related, then irrelevant; ties keep lexical order.
  graded.sort((x, y) => y.decision.level - x.decision.level);
  logSurfaceCall('recall', started, {
    status: 'ok',
    n: head.length,
    levels: graded.map((r) => ({ id: r.id, level: r.decision.level })),
    moved: graded.some((r, i) => r.id !== head[i].id),
  });
  return { rows: [...graded, ...tail], reranked: true };
}

module.exports = { decisionRerank, searchDecisionEnabled, LEVELS };
