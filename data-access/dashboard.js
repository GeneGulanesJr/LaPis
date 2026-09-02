'use strict';

/**
 * Dashboard aggregation queries — read-only stats from memory DB.
 * All queries use sqlJson; no mutation.
 */
function getDashboard(deps) {
  const { sqlJson } = deps,
    one = (query, params) => sqlJson(query, params)[0],
    // ── Overview ──────────────────────────────────────────────
    totalMemories = one('SELECT COUNT(*) as cnt FROM observations WHERE deleted_at IS NULL').cnt,
    totalProjects = one('SELECT COUNT(DISTINCT project) as cnt FROM observations WHERE deleted_at IS NULL').cnt,
    thisWeekSaved = one(
      "SELECT COUNT(*) as cnt FROM observations WHERE deleted_at IS NULL AND created_at >= datetime('now', '-7 days')",
    ).cnt,
    thisWeekCleaned = one(
      "SELECT COUNT(*) as cnt FROM observations WHERE deleted_at IS NOT NULL AND deleted_at >= datetime('now', '-7 days')",
    ).cnt,
    avgTrustRow = one('SELECT AVG(trust_score) as avg FROM symbol_links'),
    avgTrust = avgTrustRow.avg ?? null,
    neverRecalled = one(
      `SELECT COUNT(*) as cnt FROM observations o
     LEFT JOIN (SELECT DISTINCT memory_id FROM recall_log) rl ON rl.memory_id = o.id
     WHERE o.deleted_at IS NULL AND rl.memory_id IS NULL`,
    ).cnt;

  let expiringSoon = 0;
  try {
    expiringSoon = one(
      "SELECT COUNT(*) as cnt FROM observations WHERE expires_at IS NOT NULL AND expires_at < datetime('now', '+7 days') AND deleted_at IS NULL",
    ).cnt;
  } catch (_e) {
    // Column may not exist in older DBs
  }

  // ── By Type ───────────────────────────────────────────────
  const byTypeRaw = sqlJson(
      `SELECT type, COUNT(*) as cnt FROM observations
     WHERE deleted_at IS NULL AND type != 'skill'
     GROUP BY type ORDER BY cnt DESC`,
    ),
    byType = byTypeRaw.map((r) => ({ type: r.type, count: r.cnt })),
    // ── Trust ─────────────────────────────────────────────────
    trustRow = one(
      `SELECT
       SUM(CASE WHEN trust_score >= 0.8 THEN 1 ELSE 0 END) as high,
       SUM(CASE WHEN trust_score >= 0.5 AND trust_score < 0.8 THEN 1 ELSE 0 END) as medium,
       SUM(CASE WHEN trust_score > 0 AND trust_score < 0.5 THEN 1 ELSE 0 END) as low,
       COUNT(*) as total
     FROM symbol_links`,
    ),
    trust = {
      avg: avgTrust,
      lowTrustCount: trustRow.low || 0,
      distribution: {
        high: trustRow.high || 0,
        medium: trustRow.medium || 0,
        low: trustRow.low || 0,
        none: totalMemories - (trustRow.total || 0),
      },
    },
    // ── Recall ────────────────────────────────────────────────
    recallRow = one(
      `SELECT
       COUNT(*) as totalRecalls,
       AVG(CASE WHEN was_useful IS NOT NULL THEN was_useful END) as usefulRate,
       COUNT(DISTINCT memory_id) as uniqueMemoriesHit
     FROM recall_log`,
    ),
    recall = {
      totalRecalls: recallRow.totalRecalls || 0,
      usefulRate: recallRow.usefulRate ?? null,
      uniqueMemoriesHit: recallRow.uniqueMemoriesHit || 0,
    };

  // ── Dream Cycle ───────────────────────────────────────────
  let dream = { lastRun: null, totalCleaned: null, runCount: null };
  try {
    const dreamLastRun = sqlJson("SELECT value FROM settings WHERE key = 'dream_last_run'"),
      dreamTotalCleaned = sqlJson("SELECT value FROM settings WHERE key = 'dream_total_cleaned'"),
      dreamRunCount = sqlJson("SELECT value FROM settings WHERE key = 'dream_run_count'");
    dream = {
      lastRun: dreamLastRun[0]?.value || null,
      totalCleaned: dreamTotalCleaned[0]?.value || null,
      runCount: dreamRunCount[0]?.value || null,
    };
  } catch (_e) {
    // Settings table may not exist in older DBs — dream stats unavailable
  }

  // ── Code Index ────────────────────────────────────────────
  const codeIndexRaw = sqlJson('SELECT name, path, file_count, symbol_count, indexed_at, base_head FROM code_repos'),
    codeIndex = codeIndexRaw.map((r) => ({
      name: r.name,
      path: r.path,
      fileCount: r.file_count,
      symbolCount: r.symbol_count,
      indexedAt: r.indexed_at,
      base_head: r.base_head,
      // IsStale is set by the extension command handler (requires git rev-parse)
    }));

  return {
    overview: {
      totalMemories,
      totalProjects,
      thisWeekSaved,
      thisWeekCleaned,
      avgTrust,
      neverRecalled,
      expiringSoon,
    },
    byType,
    trust,
    recall,
    dream,
    codeIndex,
  };
}

module.exports = { getDashboard };
