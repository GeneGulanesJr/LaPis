// src/memory-domain/context-decision.js
// Slice G: budget-constrained context selection — opt-in, advisory. Takes the
// context builder's candidate list and judge-grades each candidate's relevance
// to the session task ('filler' | 'relevant' | 'essential'); the selection keeps
// essential/relevant candidates, level-descending (stable), while the cumulative
// estimated size fits the budget. Failures degrade to today's selection exactly:
// { selected: candidates, dropped: [], unavailable: true }.
//
// judgePromptRelevance() is the second consumer of this surface: the Claude
// Code UserPromptSubmit hook (src/claude-code/prompt-filter.js) asks, in ONE
// request, how likely each injected candidate (prompt-matched memory,
// cross-project suggestion, preflight code entry) is relevant to the prompt.

// Judgment modules load lazily inside buildJudge()/decisionSelectContext(): this
// file is required on EVERY context dispatch (the enabled check lives here),
// and the default config has decision disabled — eagerly requiring the judgment
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

function contextDecisionEnabled() {
  const cfg = getConfig().judgment || {};
  return cfg.provider === 'decision' && !!process.env.LIQUID_API_KEY && !(cfg.disables && cfg.disables.context);
}

// Prompt-path wire settings: a tight cap and no retries, so a hook process
// never waits on (or is kept alive by) a slow provider.
const PROMPT_FILTER_DEFAULTS = { threshold: 0.5, timeoutMs: 2000 };

function promptFilterSettings() {
  const cfg = getConfig().judgment || {};
  const threshold = Number(cfg.prompt_filter_threshold);
  const timeoutMs = Number(cfg.prompt_filter_timeout_ms);
  return {
    threshold:
      Number.isFinite(threshold) && threshold >= 0 && threshold <= 1 ? threshold : PROMPT_FILTER_DEFAULTS.threshold,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : PROMPT_FILTER_DEFAULTS.timeoutMs,
  };
}

/**
 * Returns the judge FUNCTION (judge(questions, {surface})). createJudge()
 * returns {provider, probe, judge}; returning that object made every call
 * here throw "judge is not a function", so the selection silently fell back
 * on every run. args.timeoutMs (prompt path) caps both the contract race and
 * the wire, with no retries.
 */
function buildJudge(args) {
  if (args && args._judge) return args._judge;
  const { createJudge } = require('../judgment');
  const { createDecisionAdapter } = require('../judgment/adapters/decision');
  const config = getConfig();
  const timeoutMs = args && Number(args.timeoutMs) > 0 ? Number(args.timeoutMs) : null;
  const judgment = timeoutMs ? { ...(config.judgment || {}), timeout_ms: timeoutMs } : config.judgment || {};
  const adapters =
    judgment.provider === 'decision'
      ? {
          decision: createDecisionAdapter({
            apiKey: process.env.LIQUID_API_KEY,
            ...(timeoutMs ? { timeoutMs, maxRetries: 0 } : {}),
          }),
        }
      : {};
  return createJudge({ config: { ...config, judgment }, adapters }).judge;
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
 * decisionSelectContext(candidates, queryOrTask, args) — async, READ-ONLY.
 * candidates: the context builder's observation list
 * ({id, title, content, type, ... [, _tokens]}).
 * Returns {selected, dropped} partitioning the candidates (selected in original
 * order), or {selected: candidates, dropped: [], unavailable: true} when the
 * judgment layer is unavailable/throws (today's selection, unchanged).
 */
async function decisionSelectContext(candidates, queryOrTask, args = {}) {
  const { chunk, capText } = require('../judgment/internal');
  const rows = Array.isArray(candidates) ? candidates : [];
  if (rows.length === 0) return { selected: [], dropped: [] };
  const judge = buildJudge(args);
  // The wire takes ONE merged state per request, so each candidate lives
  // under its own key — a shared `candidate` key let the last one overwrite
  // the rest and every question saw the same candidate.
  const questions = rows.map((c, i) => ({
    id: `ctx-${i}`,
    judgment: { kind: 'grade', levels: LEVELS },
    instructions: `Memory \`candidate_${i}\` [#${c && c.id}] "${capText((c && c.title) || '', 80)}" — grade its relevance to \`task\`: filler = noise for this task, relevant = useful background, essential = directly needed.`,
    state: {
      task: capText(String(queryOrTask || ''), 400),
      [`candidate_${i}`]: {
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
 * maybeContextDecisionSelection(candidates, queryOrTask, deps, args) — guarded
 * wrapper: null when the slice is disabled (caller keeps today's selection);
 * otherwise delegates to decisionSelectContext, which never throws.
 */
async function maybeContextDecisionSelection(candidates, queryOrTask, deps, args = {}) {
  if (!contextDecisionEnabled()) return null;
  try {
    // Same tight cap as the prompt filter: this runs on per-prompt context too.
    return await decisionSelectContext(candidates, queryOrTask, {
      timeoutMs: promptFilterSettings().timeoutMs,
      ...args,
    });
  } catch {
    return null;
  }
}

const PROMPT_CANDIDATE_LABELS = {
  memory: 'a saved memory from the current project',
  suggestion: 'a saved memory from another project (its `project` field names it)',
  code: 'an existing code symbol a code-index search matched to the prompt',
  file: 'a file path a code-index search matched to the prompt',
};
// Liquid takes at most 128 questions per request; the hook sends ~5–15.
const MAX_PROMPT_QUESTIONS = 128;

/**
 * judgePromptRelevance(prompt, candidates, args) — async, READ-ONLY, ONE request.
 * candidates: [{ kind: 'memory'|'suggestion'|'code'|'file', fields: {...} }]
 *   (fields are already capped by the caller; they are sent as state).
 * Returns { status: 'ok', p: number[] } — p[i] = probability candidate i is
 * relevant to the prompt (candidates past the request cap get p = 1, i.e.
 * kept) — or { status: 'unavailable', reason } on any failure. Never throws.
 * args: { _judge?, timeoutMs? } (default timeout: judgment.prompt_filter_timeout_ms).
 */
async function judgePromptRelevance(prompt, candidates, args = {}) {
  try {
    const { capText } = require('../judgment/internal');
    const rows = Array.isArray(candidates) ? candidates : [];
    if (rows.length === 0) return { status: 'ok', p: [] };
    const judge = buildJudge({ timeoutMs: promptFilterSettings().timeoutMs, ...args });
    const promptText = capText(String(prompt || ''), 2000);
    const questions = rows.slice(0, MAX_PROMPT_QUESTIONS).map((c, i) => {
      const key = `candidate_${i}`;
      return {
        id: `p-${i}`,
        judgment: {
          kind: 'probability',
          claim: `\`${key}\` is about the same subject as \`prompt\` and would help answer it.`,
        },
        instructions: `The user just typed \`prompt\` to a coding assistant. \`${key}\` is ${
          PROMPT_CANDIDATE_LABELS[c.kind] || PROMPT_CANDIDATE_LABELS.memory
        } that the assistant may be shown before answering.`,
        state: { prompt: promptText, [key]: c.fields || {} },
      };
    });
    const result = await judge(questions, { surface: 'context' });
    if (!result || result.status !== 'ok' || !Array.isArray(result.answers)) {
      return { status: 'unavailable', reason: (result && result.reason) || 'no result' };
    }
    const byId = new Map(result.answers.map((a) => [a.id, a]));
    const p = rows.map((_, i) => {
      if (i >= MAX_PROMPT_QUESTIONS) return 1;
      const a = byId.get(`p-${i}`);
      return a && typeof a.p === 'number' && Number.isFinite(a.p) ? a.p : null;
    });
    if (p.some((x) => x === null)) return { status: 'unavailable', reason: 'missing answer' };
    return { status: 'ok', p };
  } catch (e) {
    return { status: 'unavailable', reason: `prompt relevance error contained: ${e && e.message}` };
  }
}

module.exports = {
  contextDecisionEnabled,
  decisionSelectContext,
  maybeContextDecisionSelection,
  judgePromptRelevance,
  promptFilterSettings,
  PROMPT_FILTER_DEFAULTS,
};
