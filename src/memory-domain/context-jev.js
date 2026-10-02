// src/memory-domain/context-jev.js
// Slice G: budget-constrained context selection — opt-in, advisory. Takes the
// context builder's candidate list and judge-grades each candidate's relevance
// to the session task ('filler' | 'relevant' | 'essential'); the selection keeps
// essential/relevant candidates, level-descending (stable), while the cumulative
// estimated size fits the budget. Failures degrade to today's selection exactly:
// { selected: candidates, dropped: [], unavailable: true }.

// Judgment modules load lazily inside buildJudge()/jevSelectContext(): this
// file is required on EVERY context dispatch (the enabled check lives here),
// and the default config has jev disabled — eagerly requiring the judgment
// layer made every fresh-process context dispatch pay ~10ms for an opt-in
// feature it never used.
const { getConfig } = require('../../config');

const BATCH = 10;
// Default selection budget in chars — used when the caller passes neither
// --budget nor the real context budget field --token-budget.
const DEFAULT_BUDGET = 4000;
const LEVELS = ['filler', 'relevant', 'essential'];
const LEVEL_RANK = { filler: 0, relevant: 1, essential: 2 };
const CONTENT_SNIPPET_CHARS = 300;

function contextJevEnabled() {
  const cfg = getConfig().judgment || {};
  return cfg.provider === 'jev' && !!process.env.TYPESAFE_API_KEY && !(cfg.disables && cfg.disables.context);
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

/** Estimated size of one candidate. The real shape carries `_tokens` when the
 * token budget was applied upstream; fall back to content length (chars). */
function candidateSize(c) {
  if (c && typeof c._tokens === 'number' && Number.isFinite(c._tokens) && c._tokens > 0) return c._tokens;
  return c && typeof c.content === 'string' ? c.content.length : 0;
}

/** Budget resolution: --budget (chars) > the real context field --token-budget > 4000. */
function resolveBudget(args) {
  const num = (v) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return num(args && args.budget) || num(args && args['token-budget']) || DEFAULT_BUDGET;
}

/**
 * jevSelectContext(candidates, queryOrTask, args) — async, READ-ONLY.
 * candidates: the context builder's observation list
 * ({id, title, content, type, ... [, _tokens]}).
 * Returns {selected, dropped} partitioning the candidates (selected in original
 * order), or {selected: candidates, dropped: [], unavailable: true} when the
 * judgment layer is unavailable/throws (today's selection, unchanged).
 */
async function jevSelectContext(candidates, queryOrTask, args = {}) {
  const { chunk, capText } = require('../judgment/internal');
  const rows = Array.isArray(candidates) ? candidates : [];
  if (rows.length === 0) return { selected: [], dropped: [] };
  const judge = buildJudge(args);
  const questions = rows.map((c, i) => ({
    id: `ctx-${i}`,
    judgment: { kind: 'grade', levels: LEVELS },
    instructions: `Memory [#${c && c.id}] "${capText((c && c.title) || '', 80)}" — grade its relevance to the task: filler = noise for this task, relevant = useful background, essential = directly needed.`,
    state: {
      task: capText(String(queryOrTask || ''), 400),
      candidate: {
        id: c && c.id,
        title: capText((c && c.title) || '', 80),
        type: (c && c.type) || '',
        content: capText((c && c.content) || '', CONTENT_SNIPPET_CHARS),
      },
    },
  }));

  const rankByIndex = new Map();
  try {
    for (const batch of chunk(questions, BATCH)) {
      const result = await judge(batch, { surface: 'context' });
      if (!result || result.status !== 'ok') {
        return { selected: rows, dropped: [], unavailable: true };
      }
      for (const a of result.answers) {
        // Grade answers carry the level as an INDEX into LEVELS (adapter-normalized).
        const idx = Number(String(a.id).split('-')[1]);
        const name = LEVELS[a.level];
        rankByIndex.set(idx, name === undefined ? LEVEL_RANK.filler : LEVEL_RANK[name]);
      }
    }
  } catch {
    return { selected: rows, dropped: [], unavailable: true };
  }

  // Select: sort level-desc (stable — original index breaks ties), then keep a
  // greedy prefix while the cumulative size fits the budget. 'filler' is never
  // selected (all-filler → empty selection), and a candidate that does not fit
  // stops the scan — everything after is dropped with it.
  const budget = resolveBudget(args);
  const order = rows
    .map((c, i) => ({ c, i, rank: rankByIndex.get(i) === undefined ? LEVEL_RANK.filler : rankByIndex.get(i) }))
    .sort((a, b) => b.rank - a.rank || a.i - b.i);

  const selectedSet = new Set();
  let used = 0;
  for (const { c, rank } of order) {
    if (rank <= LEVEL_RANK.filler) break;
    const size = candidateSize(c);
    if (used + size > budget) break;
    selectedSet.add(c);
    used += size;
  }

  const selected = rows.filter((c) => selectedSet.has(c));
  const dropped = rows.filter((c) => !selectedSet.has(c));
  return { selected, dropped };
}

/**
 * maybeContextJevSelection(candidates, queryOrTask, deps, args) — guarded
 * wrapper: null when the slice is disabled (caller keeps today's selection);
 * otherwise delegates to jevSelectContext, which never throws.
 */
async function maybeContextJevSelection(candidates, queryOrTask, deps, args = {}) {
  if (!contextJevEnabled()) return null;
  try {
    return await jevSelectContext(candidates, queryOrTask, args);
  } catch {
    return null;
  }
}

module.exports = { contextJevEnabled, jevSelectContext, maybeContextJevSelection };
