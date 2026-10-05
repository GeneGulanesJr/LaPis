#!/usr/bin/env node
/**
 * judgment-usability.js — One-off hygiene triage: USABLE vs NOT-USABLE memories,
 * classified through the repo's provider-agnostic judgment layer (src/judgment).
 *
 * SAFETY:
 *   - Default is DRY-RUN: report only, zero DB writes.
 *   - --judge-off forces the heuristic provider: structurally zero network
 *     (no remote adapters registered, and the heuristic adapter never touches
 *     the wire — see src/judgment/adapters/heuristic.js).
 *   - --apply only soft-deletes (deleted_at = datetime('now')) and ONLY rows
 *     passing BOTH gates: p >= 0.7 AND confidence >= 0.5, excluding the
 *     protected types ('preference', 'architecture'). Protected types are
 *     never touched, with or without --apply.
 *
 * Flags:
 *   --judge-off    Heuristic provider only (zero network).
 *   --limit N      Cap the candidate count.
 *   --project X    Scope candidates to one project.
 *   --apply        Soft-delete confident retire candidates (gated, see above).
 *   --allow-network
 *                  Explicit opt-in for a remote provider (e.g. jev). Without
 *                  it, a remote provider config degrades to unavailable —
 *                  a one-off hygiene script must never spend API calls by
 *                  accident.
 *
 * Output: human-readable report on stderr; machine JSON on stdout:
 *   { total_candidates, judged, keep, retire_candidates, unavailable,
 *     retire_list: [{ id, title, project, p, confidence, type }] }
 *
 * Usage: node scripts/judgment-usability.js --judge-off --limit 20
 */

const { getConfig } = require('../config');
const { chunk, capText } = require('../src/judgment/internal');

const BATCH = 10; // same batch size as dream-jev.js verifyBatch

// --apply gates: BOTH thresholds must hold, and the type must not be protected.
const APPLY_P_MIN = 0.7;
const APPLY_CONFIDENCE_MIN = 0.5;
const PROTECTED_TYPES = ['preference', 'architecture'];

/**
 * Read-only candidate query: live memories that have NEVER been recalled,
 * minus obvious test junk and the types the Dream Cycle already owns
 * (session_summary, progress).
 */
function candidateSql(project) {
  return `
  SELECT o.id, o.title, o.type, o.project,
         substr(o.created_at, 1, 10) AS created,
         o.content
  FROM observations o
  WHERE o.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM recall_log r WHERE r.memory_id = o.id)
    AND o.project NOT LIKE 'test-mem-%'
    AND o.title NOT LIKE 'Context test%'
    AND o.title NOT LIKE 'Cross-project pref%'
    AND o.type NOT IN ('session_summary', 'progress')
    ${project ? 'AND o.project = ?' : ''}
  ORDER BY o.id
`;
}

/**
 * Mirror of dream-jev.js buildJudge, plus the --judge-off override: a judge
 * pinned to the heuristic provider. Returns the full judgment seam
 * { provider, probe, judge } — the judge() member is the total function:
 * { status: 'ok', answers } or { status: 'unavailable', reason }, never throws.
 */
function buildJudge(opts = {}) {
  const { createJudge } = require('../src/judgment');
  if (opts.judgeOff) {
    return createJudge({ config: { judgment: { provider: 'heuristic' } } });
  }
  const cfg = getConfig().judgment || {},
    provider = cfg.provider || 'heuristic';
  // Network opt-in: anything beyond the local heuristic adapter requires an
  // explicit flag. Otherwise degrade to unavailable (judge() stays total).
  if (provider !== 'heuristic' && !opts.allowNetwork) {
    return createJudge({ config: { judgment: { provider: 'off' } } });
  }
  const { createJevAdapter } = require('../src/judgment/adapters/jev');
  const adapters = provider === 'jev' ? { jev: createJevAdapter({ apiKey: process.env.TYPESAFE_API_KEY }) } : {};
  return createJudge({ config: getConfig(), adapters });
}

/** Question shape copied from src/memory-domain/dream-jev.js verifyBatch. */
function buildQuestion(row, i) {
  return {
    id: `q${i}`,
    judgment: {
      kind: 'probability',
      claim: `Memory #${row.id} (${capText(row.title, 60)}) is stale or no longer useful and can be retired`,
    },
    instructions:
      'Judge whether this memory is superseded, obsolete (references dead state), or test/boilerplate residue — ' +
      'versus durable knowledge that still earns its place. Decisions, architecture notes, and preferences are ' +
      'usually KEEP. p = probability the memory CAN be retired (p >= 0.5 means retire candidate).',
    state: {
      memory: {
        id: row.id,
        title: row.title,
        type: row.type,
        project: row.project,
        created: row.created,
        content: capText(row.content || '', 400),
      },
    },
  };
}

/** Same verdict convention as dream-jev.js: p >= 0.5 → retire candidate. */
function verdictOf(answer) {
  if (!answer || typeof answer.p !== 'number') return { verdict: 'unknown' };
  return { verdict: answer.p >= 0.5 ? 'retire' : 'keep', p: answer.p, confidence: answer.confidence };
}

/**
 * classifyMemories(deps, opts) — read-only classification pass.
 * deps: { sqlJson }. opts: { limit, project, judgeOff }.
 * judge() is total, so this never throws past chunk()/SQL — and SQL failure
 * is contained by the CLI catch. Returns the report structure below.
 */
async function classifyMemories(deps, opts = {}) {
  const { limit = null, project = null, judgeOff = false } = opts,
    report = {
      total_candidates: 0,
      judged: 0,
      keep: 0,
      retire_candidates: 0,
      unavailable: false,
      retire_list: [],
    };

  const rows = deps.sqlJson(candidateSql(project), project ? [project] : []) || [],
    capped = limit != null ? rows.slice(0, limit) : rows;
  report.total_candidates = capped.length;
  if (capped.length === 0) return report;

  // Judgment seam: { provider, probe, judge } — call the judge member.
  const { provider, judge } = buildJudge(opts);
  report.provider = provider;

  const questions = capped.map(buildQuestion);
  for (const batch of chunk(questions, BATCH)) {
    const result = await judge(batch, { surface: 'dream' });
    if (!result || result.status !== 'ok') {
      // Unavailable (heuristic/off/breaker/timeout): report and stop. The
      // remaining candidates stay unjudged — never retry-loop here.
      report.unavailable = true;
      report.unavailable_reason = (result && result.reason) || 'unknown';
      break;
    }
    for (const q of batch) {
      const answer = (result.answers || []).find((a) => a.id === q.id),
        v = verdictOf(answer);
      if (v.verdict === 'unknown') continue;
      report.judged++;
      if (v.verdict === 'keep') {
        report.keep++;
        continue;
      }
      const row = capped[Number(q.id.slice(1))];
      report.retire_candidates++;
      report.retire_list.push({
        id: row.id,
        title: row.title,
        project: row.project,
        p: v.p,
        confidence: v.confidence,
        type: row.type,
      });
    }
  }
  return report;
}

/**
 * applyRetirements(deps, retireList) — gated soft-delete. Called ONLY with
 * opts.apply; every row must clear BOTH thresholds, and protected types are
 * skipped unconditionally. deps: { sqlRun }.
 */
function applyRetirements(deps, retireList) {
  const eligible = (retireList || []).filter(
      (r) => r.p >= APPLY_P_MIN && (typeof r.confidence === 'number' ? r.confidence : 0) >= APPLY_CONFIDENCE_MIN,
    ),
    toApply = eligible.filter((r) => !PROTECTED_TYPES.includes(r.type));
  let applied = 0;
  for (const group of chunk(
    toApply.map((r) => r.id),
    50,
  )) {
    const placeholders = group.map(() => '?').join(','),
      res = deps.sqlRun(
        `UPDATE observations SET deleted_at = datetime('now') WHERE deleted_at IS NULL AND id IN (${placeholders})`,
        group,
      );
    applied += (res && res.changes) || 0;
  }
  return {
    applied,
    gated_out: (retireList || []).length - eligible.length,
    protected_skipped: eligible.length - toApply.length,
    ids: toApply.map((r) => r.id),
  };
}

// CLI entry point (same handle pattern as scripts/cleanup-sessions.js)
if (require.main === module) {
  const { ensureDb, sqlJson, sqlRun, parseArgs } = require('../db');

  ensureDb();

  (async () => {
    const args = parseArgs(
        // db.js parseArgs slices argv from index 3 (built for `node cli.js
        // <command> <flags>`); as a standalone script our first real flag sits at
        // argv[2], so inject a dummy subcommand to keep every user flag.
        [process.argv[0], process.argv[1], '_', ...process.argv.slice(2)],
      ),
      opts = {
        judgeOff: args['judge-off'] === true,
        allowNetwork: args['allow-network'] === true,
        apply: args.apply === true,
        project: typeof args.project === 'string' ? args.project : null,
        limit: (() => {
          if (args.limit == null || args.limit === true) return null;
          const n = parseInt(args.limit, 10);
          if (Number.isNaN(n) || n < 1) {
            console.error(`judgment-usability: --limit must be a positive integer, got "${args.limit}"`);
            process.exit(1);
          }
          return n;
        })(),
      },
      report = await classifyMemories({ sqlJson }, opts);

    // --apply is still gated: unavailable runs and empty retire lists apply nothing.
    if (opts.apply) {
      report.apply =
        !report.unavailable && report.retire_list.length > 0
          ? applyRetirements({ sqlRun }, report.retire_list)
          : { applied: 0, gated_out: 0, protected_skipped: 0, ids: [], note: 'nothing to apply' };
    }
    report.dry_run = !opts.apply;

    // Human report → stderr; JSON → stdout (machine-parseable).
    const mode = opts.judgeOff ? 'judge-off (heuristic, zero network)' : `provider: ${report.provider || 'config'}`;
    console.error(`judgment-usability — ${mode} — ${opts.apply ? 'APPLY' : 'DRY-RUN'}`);
    console.error(
      `candidates: ${report.total_candidates}, judged: ${report.judged}, keep: ${report.keep}, ` +
        `retire candidates: ${report.retire_candidates}${report.unavailable ? `, UNAVAILABLE (${report.unavailable_reason || 'n/a'})` : ''}`,
    );
    for (const r of report.retire_list) {
      const fmt = (x) => (typeof x === 'number' ? x.toFixed(2) : 'n/a');
      console.error(`  #${r.id} [${r.project}] ${r.title} — p=${fmt(r.p)} conf=${fmt(r.confidence)}`);
    }

    console.log(JSON.stringify(report, null, 2));
  })().catch((e) => {
    console.error(`judgment-usability: fatal: ${(e && e.message) || e}`);
    process.exit(1);
  });
}

module.exports = { classifyMemories, applyRetirements, buildQuestion, candidateSql, verdictOf };
