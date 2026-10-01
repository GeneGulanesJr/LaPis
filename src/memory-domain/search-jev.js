// src/memory-domain/search-jev.js
// Slice A: semantic rerank of lexical search results — opt-in, advisory.
// Takes the already-ranked rows from rankObservations and re-orders the top-N
// by a Jev grade judgment ('central' > 'related' > 'irrelevant'). Never throws;
// any judgment failure returns the input order unchanged.

// Judgment modules load lazily inside buildJudge()/jevRerank(): this file is
// required on EVERY search dispatch (the enabled check lives here), and the
// default config has jev disabled — eagerly requiring the judgment layer made
// every fresh-process search dispatch pay ~10ms for an opt-in feature it
// never used.
const { getConfig } = require('../../config');

const LEVELS = ['irrelevant', 'related', 'central'];
const BATCH = 10;

function searchJevEnabled() {
  const cfg = getConfig().judgment || {};
  return cfg.provider === 'jev' && !!process.env.TYPESAFE_API_KEY && !(cfg.disables && cfg.disables.recall);
}

function buildJudge(args) {
  if (args && args._judge) return args._judge;
  const { createJudge } = require('../judgment');
  const { createJevAdapter } = require('../judgment/adapters/jev');
  const adapters =
    (getConfig().judgment || {}).provider === 'jev'
      ? { jev: createJevAdapter({ apiKey: process.env.TYPESAFE_API_KEY }) }
      : {};
  return createJudge({ config: getConfig(), adapters });
}

/**
 * jevRerank(rows, query, args) — async. rows: lexically-ranked observations
 * (each has id, title, snippet or content). Returns {rows, reranked, unavailable?}
 * where rows are re-ordered ONLY by level (stable within equal levels) and each
 * reranked row carries `jev: {level, confidence}`.
 */
async function jevRerank(rows, query, args = {}) {
  const { chunk, capText } = require('../judgment/internal');
  const topN = Number(args.topN ?? 10);
  const head = (rows || []).slice(0, topN);
  const tail = (rows || []).slice(topN);
  if (head.length === 0) return { rows: rows || [], reranked: false };
  const judge = buildJudge(args);
  const questions = head.map((row, i) => ({
    id: `rr-${i}`,
    judgment: { kind: 'grade', levels: LEVELS },
    instructions:
      'Rate how relevant this memory is to the query. central = directly answers or is about the query; related = touches the topic; irrelevant = unrelated.',
    state: { query, memory: { id: row.id, title: row.title, snippet: capText(row.snippet || row.content || '', 400) } },
  }));
  const byId = new Map();
  try {
    for (const batch of chunk(questions, BATCH)) {
      const result = await judge(batch, { surface: 'recall' });
      if (!result || result.status !== 'ok') return { rows: rows || [], reranked: false, unavailable: true };
      for (const a of result.answers) byId.set(a.id, a);
    }
  } catch {
    return { rows: rows || [], reranked: false, unavailable: true };
  }
  const graded = head.map((row, i) => {
    const a = byId.get(`rr-${i}`);
    const level = a && typeof a.level === 'number' ? a.level : 0;
    return { ...row, jev: { level, confidence: a ? a.confidence : 0, relevance: LEVELS[level] } };
  });
  // Stable sort: central first, then related, then irrelevant; ties keep lexical order.
  graded.sort((x, y) => y.jev.level - x.jev.level);
  return { rows: [...graded, ...tail], reranked: true };
}

module.exports = { jevRerank, searchJevEnabled, LEVELS };
