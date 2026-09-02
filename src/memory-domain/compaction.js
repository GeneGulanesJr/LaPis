const { TRUST_DELTA, DEDUP, TIME_WINDOWS, RESULT_LIMITS } = require('../../constants');
const { createTrustSyncRepository } = require('../platform/storage/repositories/trust-sync');
const trustSync = require('../trust-sync');

// Cheap, lock-light cleanup: all the DELETEs + trust decay. No VACUUM, no FTS optimize.
// Safe to run on every session-end without blocking exit.
function runCompactCheap(deps) {
  const { sqlRun } = deps,
    startedAt = new Date().toISOString(),
    report = { startedAt, steps: {} };

  try {
    sqlRun("DELETE FROM observations WHERE expires_at IS NOT NULL AND expires_at < datetime('now')");
    report.steps.expiredPurged = true;

    sqlRun(
      'DELETE FROM symbol_links WHERE memory_id NOT IN (SELECT CAST(id AS TEXT) FROM observations WHERE deleted_at IS NULL)',
    );
    report.steps.deadLinksCleaned = true;

    sqlRun(
      `DELETE FROM observations WHERE deleted_at IS NOT NULL AND deleted_at < datetime('now', '-${TIME_WINDOWS.PURGE_SOFT_DELETED_DAYS} days')`,
    );
    report.steps.purgedSoftDeleted = true;

    sqlRun(`DELETE FROM observations WHERE id IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY project ORDER BY created_at DESC) AS rn
        FROM observations WHERE type = 'session_summary' AND deleted_at IS NULL
      ) WHERE rn > ${RESULT_LIMITS.SESSION_SUMMARY_FLOOR}
    )`);
    report.steps.oldSummariesPruned = true;

    sqlRun(`DELETE FROM user_prompts WHERE id IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY project ORDER BY created_at DESC) AS rn
        FROM user_prompts
      ) WHERE rn > ${RESULT_LIMITS.PROMPTS_PER_PROJECT}
    )`);
    report.steps.oldPromptsPruned = true;

    sqlRun(`DELETE FROM session_log WHERE id NOT IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY project ORDER BY started_at DESC) AS rn
        FROM session_log
      ) WHERE rn <= ${RESULT_LIMITS.SESSIONS_PER_PROJECT}
    )`);
    report.steps.sessionLogPruned = true;

    sqlRun(`DELETE FROM user_prompts WHERE session_id NOT IN (SELECT CAST(id AS TEXT) FROM session_log)`);
    report.steps.orphanPromptsCleaned = true;

    sqlRun(
      `DELETE FROM trust_adjustments WHERE timestamp < datetime('now', '-${TIME_WINDOWS.TRUST_ADJUSTMENTS_RETENTION_DAYS} days')`,
    );
    report.steps.trustAdjustmentsPruned = true;

    sqlRun('DELETE FROM session_recalls WHERE session_id NOT IN (SELECT id FROM session_log)');
    report.steps.recallsPruned = true;

    deps.sqlRun(`UPDATE symbol_links SET trust_score = MAX(${TRUST_DELTA.TRUST_FLOOR}, trust_score - ${Math.abs(TRUST_DELTA.STALE_TRUST_DECAY)})
      WHERE memory_id IN (
        SELECT CAST(id AS TEXT) FROM observations WHERE updated_at < datetime('now', '-${TIME_WINDOWS.ARCHIVE_INACTIVE_DAYS} days')
      ) AND trust_score > ${TRUST_DELTA.TRUST_FLOOR}`);
    report.steps.staleTrustDecayed = true;

    report.completedAt = new Date().toISOString();
    report.ok = true;
  } catch (e) {
    report.error = e.message;
    report.ok = false;
  }
  return report;
}

// Expensive: VACUUM rewrites the whole DB under an exclusive lock; FTS 'optimize'
// Rebuilds the index b-trees. Only run on a gated cadence (every N sessions),
// Never on every exit — otherwise quitting Pi blocks for seconds on large DBs.
function runVacuum(deps) {
  const { sqlRaw } = deps,
    startedAt = new Date().toISOString(),
    report = { startedAt, steps: {} };
  try {
    sqlRaw('VACUUM;');
    report.steps.vacuumed = true;

    sqlRaw("INSERT INTO observations_fts(observations_fts) VALUES('optimize')");
    sqlRaw("INSERT INTO prompts_fts(prompts_fts) VALUES('optimize')");
    report.steps.ftsOptimized = true;

    report.completedAt = new Date().toISOString();
    report.ok = true;
  } catch (e) {
    report.error = e.message;
    report.ok = false;
  }
  return report;
}

// Full compact = cheap deletes + expensive VACUUM/FTS optimize.
// Kept for backward compat (CLI `compact`, `dream`, tests).
function runCompact(deps) {
  const cheap = runCompactCheap(deps),
    vacuum = runVacuum(deps);
  return {
    startedAt: cheap.startedAt,
    ok: cheap.ok && vacuum.ok,
    steps: { ...cheap.steps, ...vacuum.steps },
    cheap,
    vacuum,
  };
}

function compact(deps) {
  return runCompact(deps);
}

function dream(deps, args = {}) {
  const startedAt = new Date().toISOString(),
    report = { startedAt, phases: {} };
  let totalCleaned = 0;
  const cleanedIds = [],
    // Pre-phase: hard-delete expired observations before any dream phases
    // so expired rows don't get soft-deleted or consolidated unnecessarily
    expiredCount = deps.sqlJson(
      "SELECT COUNT(*) as cnt FROM observations WHERE expires_at IS NOT NULL AND expires_at < datetime('now')",
    ),
  superseded = (() => {

    if (expiredCount[0]?.cnt > 0) {
      deps.sqlRun("DELETE FROM observations WHERE expires_at IS NOT NULL AND expires_at < datetime('now')");
      report.phases.preExpiredPurge = { count: expiredCount[0].cnt };
      totalCleaned += expiredCount[0].cnt;
    }
  
    // Phase 1: Superseded memories
    
  return (deps.sqlJson(`
    SELECT o.id, o.title, o.type, o.project,
           r.source_id AS newer_id, r.relation, r.confidence
    FROM observations o
    JOIN observation_relations r ON r.target_id = o.id
    WHERE r.relation IN ('duplicate', 'supersedes')
      AND o.deleted_at IS NULL
      AND r.confidence >= ${DEDUP.DREAM_SUPERSEDED_CONFIDENCE}
  `));
})();for (const row of superseded) {
    deps.softDeleteObservation(row.id);
    cleanedIds.push({
      id: row.id,
      title: row.title,
      reason: `superseded by #${row.newer_id} (${row.relation}, ${Math.round(row.confidence * 100)}%)`,
    });
  }
  report.phases.superseded = { count: superseded.length };
  totalCleaned += superseded.length;

  // Phase 2: Stale auto-progress memories
  const staleAutoTypes = ['progress', 'accomplished'],
  autoDetectedTypes = (() => {

    for (const type of staleAutoTypes) {
      const rows = deps.sqlJson(
        `
        SELECT o.id, o.title, o.project
        FROM observations o
        LEFT JOIN (
          SELECT memory_id, COUNT(*) as recall_count
          FROM recall_log
          WHERE was_useful = 1
          GROUP BY memory_id
        ) rl ON rl.memory_id = o.id
        WHERE o.type = ? AND o.deleted_at IS NULL
          AND (rl.recall_count IS NULL OR rl.recall_count = 0)
      `,
        [type],
      );
      for (const row of rows) {
        deps.softDeleteObservation(row.id);
        cleanedIds.push({ id: row.id, title: row.title, reason: `${type} type, never recalled` });
      }
      report.phases[`stale_${type}`] = { count: rows.length };
      totalCleaned += rows.length;
    }
  
    // Phase 3: Never-recalled auto-detected decisions with low trust
    
  return (['decision', 'bugfix', 'discovery']);
})();for (const type of autoDetectedTypes) {
    const rows = deps.sqlJson(
      `
      SELECT o.id, o.title, o.project
      FROM observations o
      LEFT JOIN (
        SELECT memory_id, COUNT(*) as recall_count
        FROM recall_log
        WHERE was_useful = 1
        GROUP BY memory_id
      ) rl ON rl.memory_id = o.id
      LEFT JOIN (
        SELECT memory_id, MAX(trust_score) as trust_score
        FROM symbol_links GROUP BY memory_id
      ) sl ON sl.memory_id = CAST(o.id AS TEXT)
      WHERE o.type = ? AND o.deleted_at IS NULL
        AND (rl.recall_count IS NULL OR rl.recall_count = 0)
        AND o.content LIKE '%Auto-detected%'
        AND (sl.trust_score IS NULL OR sl.trust_score < ${DEDUP.DREAM_LOW_TRUST_THRESHOLD})
        ${args.bypassAgeGates ? '' : `AND o.created_at < datetime('now', '-${TIME_WINDOWS.DREAM_AUTO_DETECTED_MIN_AGE_DAYS} days')`}
    `,
      [type],
    );
    for (const row of rows) {
      deps.softDeleteObservation(row.id);
      cleanedIds.push({ id: row.id, title: row.title, reason: `auto-detected ${type}, never recalled in 7+ days` });
    }
    report.phases[`staleAuto_${type}`] = { count: rows.length };
    totalCleaned += rows.length;
  }

  // Phase 4: Correction entry cleanup
  const corrections = deps.sqlJson(`
    SELECT id, title, content, project
    FROM observations
    WHERE (title LIKE 'CORRECTION:%' OR title LIKE 'Correction:%')
      AND deleted_at IS NULL
  `),
  obsoleteConfigs = (() => {

    for (const row of corrections) {
      const refMatch = row.content.match(/#(\d+)/),
        refNote = refMatch ? ` (referenced #${refMatch[1]} — ensure it was updated)` : '';
      deps.softDeleteObservation(row.id);
      cleanedIds.push({
        id: row.id,
        title: row.title,
        reason: `correction entry${refNote} — should use memory-update instead`,
      });
    }
    report.phases.staleCorrections = { count: corrections.length };
    totalCleaned += corrections.length;
  
    // Phase 5: Obsolete setup/config states (uses observation_relations for O(n) instead of self-join)
    
  return (deps.sqlJson(`
    SELECT o1.id, o1.title, o1.project, o1.type,
           r.source_id AS newer_id,
           o2.title AS newer_title
    FROM observations o1
    JOIN observation_relations r ON r.target_id = o1.id
    JOIN observations o2 ON o2.id = r.source_id
    WHERE r.relation IN ('duplicate', 'supersedes')
      AND o1.deleted_at IS NULL
      AND o2.deleted_at IS NULL
      AND o1.type IN ('decision', 'config', 'architecture')
      AND (
        o1.content LIKE '%replaced%' OR o1.content LIKE '%setup%'
        OR o1.title LIKE '%setup%'
      )
    UNION
    SELECT o1.id, o1.title, o1.project, o1.type,
           o2.id AS newer_id, o2.title AS newer_title
    FROM observations o1
    JOIN observations o2 ON o1.project = o2.project
      AND o1.id < o2.id
      AND o2.deleted_at IS NULL
      AND o1.type IN ('decision', 'config', 'architecture')
      AND o2.type IN ('decision', 'config', 'architecture')
    JOIN observation_relations r2 ON r2.target_id = o1.id AND r2.source_id = o2.id
      AND r2.relation IN ('duplicate', 'supersedes')
    WHERE o1.deleted_at IS NULL
      AND o1.topic_key IS NOT NULL AND o1.topic_key != ''
      AND o1.topic_key = o2.topic_key
      AND o1.created_at < o2.created_at
    LIMIT 500
  `));
})();for (const row of obsoleteConfigs) {
    deps.softDeleteObservation(row.id);
    cleanedIds.push({
      id: row.id,
      title: row.title,
      reason: `replaced config — superseded by #${row.newer_id} "${row.newer_title}"`,
    });
  }
  report.phases.replacedConfigs = { count: obsoleteConfigs.length };
  totalCleaned += obsoleteConfigs.length;

  // Phase 6: Low-value titled decisions (noise cleanup)
  const noiseTitlePatterns = [
      /^Architecture choice:\s*(Done!|OK|Now I|Here's what|All \d+ |The complex|The symlink|Good concern|You're right|Approved)/i,
      /^Constraint identified:\s*(Here's my review|Two issues|All errors)/i,
    ],
    allDecisions = deps.sqlJson(`
    SELECT id, title, type, project, content, created_at
    FROM observations
    WHERE type = 'decision' AND deleted_at IS NULL
    ORDER BY created_at DESC
  `);
  let noiseCleaned = 0;
  for (const row of allDecisions) {
    if (noiseTitlePatterns.some((p) => p.test(row.title))) {
      deps.softDeleteObservation(row.id);
      cleanedIds.push({
        id: row.id,
        title: row.title,
        reason: 'low-value noise title — session progress, not a real decision',
      });
      noiseCleaned++;
    }
  }
  report.phases.noiseTitles = { count: noiseCleaned };
  totalCleaned += noiseCleaned;

  // Phase 7: Consolidate related memories on the same topic
  const topicGroups = deps.sqlJson(`
    SELECT topic_key, project, COUNT(*) as cnt, MIN(id) as keep_id,
           GROUP_CONCAT(id) as ids, GROUP_CONCAT(title, '\n') as titles
    FROM observations
    WHERE topic_key IS NOT NULL AND topic_key != ''
      AND deleted_at IS NULL
      AND type NOT IN ('skill', 'session_summary')
    GROUP BY topic_key, project
    HAVING COUNT(*) >= 3
  `);
  let consolidated = 0;
  for (const group of topicGroups) {
    const ids = group.ids.split(',').map(Number),
      keepId = Math.min(...ids),
      otherIds = ids.filter((id) => id !== keepId),
      entries = deps.sqlJson(
        `SELECT id, title, content, type, created_at FROM observations WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at ASC`,
        ids,
      );

    if (entries.length >= 3) {
      const mergedContent = entries.map((e) => `**${e.title}** (${e.created_at}):\n${e.content}`).join('\n\n---\n\n'),
        mergedTitle = `${group.topic_key} — consolidated (${entries.length} entries)`;

      deps.sqlRun('UPDATE observations SET content = ?, title = ?, type = ? WHERE id = ?', [
        mergedContent,
        mergedTitle,
        'decision',
        keepId,
      ]);

      for (const otherId of otherIds) {
        deps.softDeleteObservation(otherId);
        cleanedIds.push({
          id: otherId,
          title: entries.find((e) => e.id === otherId)?.title || '',
          reason: `consolidated into #${keepId} (topic: ${group.topic_key})`,
        });
      }
      consolidated += otherIds.length;
    }
  }
  report.phases.consolidated = { count: consolidated };
  totalCleaned += consolidated;

  // Phase 8: Maintain single session_summary per project
  const summariesPerProject = deps.sqlJson(`
    SELECT id, project, content, created_at,
           ROW_NUMBER() OVER (PARTITION BY project ORDER BY created_at DESC) as rn,
           COUNT(*) OVER (PARTITION BY project) as total
    FROM observations
    WHERE type = 'session_summary' AND deleted_at IS NULL
  `);
  let summariesConsolidated = 0;
  for (const row of summariesPerProject) {
    if (row.total > 1 && row.rn > 1) {
      deps.softDeleteObservation(row.id);
      cleanedIds.push({
        id: row.id,
        title: 'Session Summary',
        reason: `consolidated into newer project summary for ${row.project}`,
      });
      summariesConsolidated++;
    }
  }
  report.phases.projectSummaryConsolidation = { count: summariesConsolidated };
  totalCleaned += summariesConsolidated;

  // Phase 9: Session compaction — clean old empty sessions
  const sessionStats = deps.sqlJson(`
    SELECT project,
           COUNT(*) as total_sessions,
           SUM(CASE WHEN memories_saved = 0 THEN 1 ELSE 0 END) as empty_sessions,
           SUM(CASE WHEN ended_at IS NULL THEN 1 ELSE 0 END) as orphan_sessions
    FROM session_log
    GROUP BY project
  `);
  let sessionsCompacted = 0;
  for (const stat of sessionStats) {
    const total = stat.total_sessions;
    if (total <= 5) {
      continue;
    } // Hard floor

    const oldEmptySessions = deps.sqlJson(
      `SELECT id FROM session_log
       WHERE project = ? AND memories_saved = 0
       AND ended_at IS NOT NULL
       ORDER BY started_at DESC
       LIMIT -1 OFFSET 5`,
      [stat.project],
    );

    for (const session of oldEmptySessions) {
      deps.sqlRun('DELETE FROM user_prompts WHERE session_id = ?', [String(session.id)]);
      deps.sqlRun('DELETE FROM session_log WHERE id = ?', [session.id]);
      sessionsCompacted++;
    }
  }
  report.phases.sessionCompaction = {
    projects: sessionStats.length,
    sessionsCompacted,
  };
  totalCleaned += sessionsCompacted;

  // Run cheap compact only — dream may run mid-session; skip VACUUM/FTS optimize.
  const compactResult = runCompactCheap(deps);
  report.phases.compact = compactResult;

  report.completedAt = new Date().toISOString();
  report.ok = compactResult.ok !== false;
  report.totalCleaned = totalCleaned;
  report.cleaned = cleanedIds;

  // Persist dream cycle stats to settings (guarded on success)
  if (report.ok) {
    try {
      const currentTotal = parseInt(
          deps.sqlJson("SELECT value FROM settings WHERE key = 'dream_total_cleaned'")[0]?.value || '0',
          10,
        ),
        currentCount = parseInt(
          deps.sqlJson("SELECT value FROM settings WHERE key = 'dream_run_count'")[0]?.value || '0',
          10,
        );
      deps.sqlRun("INSERT OR REPLACE INTO settings (key, value) VALUES ('dream_last_run', ?)", [report.completedAt]);
      deps.sqlRun("INSERT OR REPLACE INTO settings (key, value) VALUES ('dream_total_cleaned', ?)", [
        String(currentTotal + totalCleaned),
      ]);
      deps.sqlRun("INSERT OR REPLACE INTO settings (key, value) VALUES ('dream_run_count', ?)", [
        String(currentCount + 1),
      ]);
    } catch (e) {
      // Log instead of swallowing silently — the report still advertises
      // TotalCleaned > 0 to the caller, so users would see inconsistent
      // Dashboard stats (in-memory says cleaned, settings says no data) with
      // No way to reconcile without a log line.
      console.error(`[dream] failed to persist dream-cycle stats: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return report;
}

function trustRecovery(deps, args) {
  const trustSyncRepository = deps.trustSyncRepository || createTrustSyncRepository(deps);
  return trustSync.trustRecovery({ jsonErrNoExit: deps.jsonErrNoExit, trustSyncRepository }, args);
}

module.exports = { runCompact, runCompactCheap, runVacuum, compact, dream, trustRecovery };
