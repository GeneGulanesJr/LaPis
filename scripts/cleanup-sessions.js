#!/usr/bin/env node
/**
 * Cleanup-sessions.js — One-shot retroactive session cleanup
 *
 * Usage: node cli.js cleanup-sessions [--project X] [--dry-run] [--yes] [--keep-last N] [--include-dream] [--bypass-age-gates] [--json]
 */

const SESSION_FLOOR = 5;

function triageReport(deps) {
  const projects = deps.sqlJson(`
    SELECT project,
           COUNT(*) as session_count,
           SUM(memories_saved) as total_memories,
           MIN(started_at) as first_activity,
           MAX(started_at) as last_activity,
           SUM(CASE WHEN ended_at IS NULL THEN 1 ELSE 0 END) as orphan_sessions,
           SUM(CASE WHEN memories_saved = 0 THEN 1 ELSE 0 END) as empty_sessions
    FROM session_log
    GROUP BY project
    ORDER BY session_count DESC
  `),
    orphanPrompts = deps.sqlJson(`
    SELECT COUNT(*) as cnt
    FROM user_prompts
    WHERE session_id NOT IN (SELECT CAST(id AS TEXT) FROM session_log)
  `),
    observations = deps.sqlJson(`
    SELECT type, COUNT(*) as cnt
    FROM observations
    WHERE deleted_at IS NULL
    GROUP BY type
  `);

  let estimatedReclaimKB = 0;
  try {
    const pageInfo = deps.sqlJson('SELECT page_count FROM pragma_page_count()') || [],
      sizeInfo = deps.sqlJson('SELECT page_size FROM pragma_page_size()') || [],
      pageCount = pageInfo[0]?.page_count || 0,
      pageSize = sizeInfo[0]?.page_size || 0;
    estimatedReclaimKB = Math.round((pageCount * pageSize) / 1024);
  } catch {
    // Best-effort
  }

  return {
    projects: projects.map((p) => ({
      name: p.project,
      sessionCount: p.session_count,
      totalMemories: p.total_memories,
      firstActivity: p.first_activity,
      lastActivity: p.last_activity,
      orphanSessions: p.orphan_sessions,
      emptySessions: p.empty_sessions,
      sessionsToPrune: Math.max(0, p.session_count - 5),
    })),
    orphanPrompts: orphanPrompts[0]?.cnt || 0,
    observations,
    estimatedReclaimKB,
  };
}

function cleanupSessions(deps, opts = {}) {
  const { keepLast = 10, project = null, yes = false, includeDream = false, bypassAgeGates = false } = opts,
    report = { ok: true, phases: {} },
    // Phase 0: Triage (always runs)
    triage = triageReport(deps),
    projects = project ? triage.projects.filter((p) => p.name === project) : triage.projects;
  report.triage = triage;

  if (!yes) {
    report.message = 'Dry run — use --yes to apply changes. Triage report above.';
    return report;
  }

  // Phase 1: Prune sessions

  let sessionsCompacted = 0,
    promptsCleaned = 0;

  {
    const txFn = deps.withTransaction || ((fn) => fn());

    txFn(() => {
      for (const proj of projects) {
        if (proj.sessionCount <= SESSION_FLOOR) {
          continue;
        }

        const effectiveKeep = Math.max(keepLast, SESSION_FLOOR),
          offset = effectiveKeep,
          toDelete = deps.sqlJson(
            `SELECT id FROM session_log
         WHERE project = ?
         ORDER BY started_at DESC
         LIMIT -1 OFFSET ?`,
            [proj.name, offset],
          );

        if (toDelete.length === 0) {
          continue;
        }

        // Hard assertion: never go below floor
        {
          const remaining = deps.sqlJson('SELECT COUNT(*) as cnt FROM session_log WHERE project = ?', [proj.name]);
          if (remaining[0].cnt - toDelete.length < SESSION_FLOOR) {
            continue; // Safety: skip if floor would be breached
          }

          for (const session of toDelete) {
            // Delete user_prompts explicitly (no FK cascade)
            const promptResult = deps.sqlRun('DELETE FROM user_prompts WHERE session_id = ?', [String(session.id)]);
            promptsCleaned += promptResult?.changes || 0;
            // Delete session_log (cascades to session_recalls)
            deps.sqlRun('DELETE FROM session_log WHERE id = ?', [session.id]);
            sessionsCompacted++;
          }
        }
      }
    });

    report.phases.sessionPrune = { sessionsCompacted, promptsCleaned };

    // Phase 2: Optional dream with bypass
    if (includeDream) {
      const dreamService = require('../services/dream'),
        dreamResult = dreamService.dream(
          {
            sqlJson: deps.sqlJson,
            sqlRun: deps.sqlRun,
            softDeleteObservation: deps.softDeleteObservation,
          },
          { bypassAgeGates },
        );
      report.phases.dream = dreamResult;
    }

    // Phase 3: Vacuum + FTS
    const dreamService = require('../services/dream'),
      compactResult = dreamService.runCompact();
    report.phases.vacuum = compactResult;

    return report;
  }
}

// CLI entry point
if (require.main === module) {
  const { ensureDb, sqlJson, sqlRun, sqlRaw, parseArgs, withTransaction } = require('../db'),
    obsDA = require('../data-access/observations');

  ensureDb();

  (async () => {
    const args = parseArgs(process.argv),
      softDeleteObservation = (id) => obsDA.softDeleteObservation({ sqlJson, sqlRun, sqlRaw }, id),
      deps = { sqlJson, sqlRun, sqlRaw, withTransaction, softDeleteObservation },
      opts = {
        keepLast: (() => {
          const raw = args['keep-last'];
          if (!raw) {
            return 10;
          }
          const parsed = parseInt(raw, 10);
          // NaN used to flow into LIMIT ?/OFFSET ? and crash mid-transaction
          // With a datatype mismatch (#304).
          if (Number.isNaN(parsed) || parsed < 0) {
            console.error(`cleanup-sessions: --keep-last must be a non-negative integer, got "${raw}"`);
            process.exit(1);
          }
          return parsed;
        })(),
        project: args.project || null,
        yes: args.yes === true,
        includeDream: args['include-dream'] === true,
        bypassAgeGates: args['bypass-age-gates'] === true,
      },
      result = (() => {
        if (!args.json && !args.yes) {
          const report = triageReport(deps);
          console.log(JSON.stringify(report, null, 2));
          process.exit(0);
        }

        return cleanupSessions(deps, opts);
      })();

    // Slice 1 (judgment): advisory dreamJevReview — annotates the report and
    // continues; never blocks or alters the dream result. Default config
    // (provider=heuristic / no TYPESAFE_API_KEY) skips this entirely, so the
    // default CLI path is unchanged.
    try {
      const judgment = require('../config').getConfig().judgment || {};
      if (
        judgment.provider === 'jev' &&
        process.env.TYPESAFE_API_KEY &&
        !(judgment.disables && judgment.disables.dream)
      ) {
        const { dreamJevReview } = require('../src/memory-domain/dream-jev');
        result.phases.dreamJevReview = await dreamJevReview({ sqlJson }, {});
      }
    } catch (e) {
      result.phases.dreamJevReview = { ok: false, reason: (e && e.message) || String(e) };
    }

    console.log(JSON.stringify(result, null, 2));

    // Compact advisory summary (only printed when the phase actually ran).
    const rev = result.phases.dreamJevReview;
    if (rev) {
      if (rev.unavailable || rev.ok === false) {
        console.log(`cleanup-sessions: dreamJevReview — unavailable${rev.reason ? ` (${rev.reason})` : ''}`);
      } else {
        for (const [label, section] of [
          ['superseded', rev.superseded],
          ['corrections', rev.corrections],
        ]) {
          console.log(`cleanup-sessions: dreamJevReview ${label}: ${(section && section.candidates) || 0} candidates`);
          for (const v of (section && section.verified) || []) {
            if (v.verdict === 'keep') {
              console.log(`  #${v.id} ${v.title} — keep (p=${typeof v.p === 'number' ? v.p.toFixed(2) : 'n/a'})`);
            }
          }
        }
      }
    }
  })();
}

module.exports = { triageReport, cleanupSessions };
