const { sqlJson, jsonErrNoExit, withTransaction } = require('../../db');
const { TIME_WINDOWS } = require('../../constants');
const { getConfig } = require('../../config');

function findLatestSession(project) {
  const q = project
    ? 'SELECT id FROM session_log WHERE project = ? ORDER BY started_at DESC LIMIT 1'
    : 'SELECT id FROM session_log ORDER BY started_at DESC LIMIT 1';
  const rows = sqlJson(q, project ? [project] : []);
  return rows.length > 0 ? String(rows[0].id) : 'legacy';
}

function sessionStart(deps, args) {
  const { autoRecoverInternal } = deps;
  const project = args.project;
  if (!project) {
    return jsonErrNoExit('Missing --project');
  }

  const txFn = deps.withTransaction || withTransaction;
  const { sessionId, sessionCount, consolidateDue, archiveCandidates, incompleteSession } = txFn(() => {
    const sessionRows = deps.sqlJson('INSERT INTO session_log (project) VALUES (?) RETURNING id, started_at', [
      project,
    ]);
    const sid = sessionRows[0].id;

    const countRows = deps.sqlJson('SELECT COUNT(*) as cnt FROM session_log WHERE project = ?', [project]);
    const sCnt = countRows[0].cnt;
    const compactInterval = getConfig().compact_every_n_sessions || 5;
    const cDue = sCnt > 0 && sCnt % compactInterval === 0;

    const aCandidates = deps.sqlJson(
      `
      SELECT project, MAX(started_at) as last_active
      FROM session_log
      WHERE project != ?
      GROUP BY project
      HAVING last_active < datetime('now', '-${TIME_WINDOWS.ARCHIVE_INACTIVE_DAYS} days')
    `,
      [project],
    );

    const incomplete = deps.sqlJson(
      `
      SELECT id FROM session_log
      WHERE project = ? AND ended_at IS NULL AND id != ?
      ORDER BY started_at DESC LIMIT 1
    `,
      [project, sid],
    );

    return {
      sessionId: sid,
      sessionCount: sCnt,
      consolidateDue: cDue,
      archiveCandidates: aCandidates,
      incompleteSession: incomplete,
    };
  });

  let recoveredSession = null;
  if (incompleteSession.length > 0) {
    recoveredSession = autoRecoverInternal(String(incompleteSession[0].id));
  }

  const tierConfig = deps._readTierConfig ? deps._readTierConfig() : { tier: 'full' };
  const tier = tierConfig.tier || 'full';
  const TOOL_TIERS = deps.TOOL_TIERS;
  const tierSet = TOOL_TIERS[tier];
  const commands = deps.commands;
  const availableCommands = tierSet ? Object.keys(commands).filter((c) => tierSet.has(c)) : Object.keys(commands);
  const extra = tierConfig.extra_commands || [];
  const hidden = tierConfig.hidden_commands || [];
  const finalCommands = [...new Set([...availableCommands, ...extra])].filter((c) => !hidden.includes(c)).sort();

  return {
    sessionId,
    sessionCount,
    consolidateDue,
    archiveCandidates,
    recoveredSession,
    hasIncompletePreviousSession: incompleteSession.length > 0,
    incompleteSessionId: incompleteSession.length > 0 ? incompleteSession[0].id : null,
    tool_tier: tier,
    available_commands: finalCommands,
    available_commands_count: finalCommands.length,
  };
}

function sessionEnd(deps, args) {
  const id = args.id;
  const memories = parseInt(args.memories || '0', 10);
  const auto = args.auto === 'true' || args.auto === true;
  if (!id) {
    return jsonErrNoExit('Missing --id');
  }

  let trustRecoveryResult = null;
  if (auto) {
    trustRecoveryResult = deps.trustRecovery({ session: id });
  }

  deps.sqlRun("UPDATE session_log SET ended_at = datetime('now'), memories_saved = ? WHERE id = ?", [
    memories,
    parseInt(id, 10),
  ]);

  // Always run the cheap, lock-light cleanup (DELETEs + trust decay).
  // The expensive VACUUM + FTS 'optimize' is gated by session count so quitting
  // Pi doesn't block for seconds on large DBs. The gate matches sessionStart's
  // compact_every_n_sessions so the heavy work lands on the same cadence.
  const cheapResult = deps.runCompactCheap ? deps.runCompactCheap() : null;

  let vacuumResult = null;
  if (deps.runVacuum) {
    let vacuumDue = true;
    try {
      const compactInterval = getConfig().compact_every_n_sessions || 5;
      const row = deps.sqlJson('SELECT COUNT(*) as cnt FROM session_log WHERE ended_at IS NOT NULL');
      const ended = row && row[0] ? parseInt(row[0].cnt, 10) : 0;
      vacuumDue = ended > 0 && ended % compactInterval === 0;
    } catch (_e) {
      // If the count query fails, skip vacuum rather than block exit.
      vacuumDue = false;
    }
    if (vacuumDue) {
      vacuumResult = deps.runVacuum();
    }
  }

  const result = { ok: true, sessionId: parseInt(id, 10) };
  if (trustRecoveryResult) {
    result.trustRecovery = trustRecoveryResult;
  }
  if (cheapResult) {
    result.compacted = vacuumResult
      ? { startedAt: cheapResult.startedAt, ok: cheapResult.ok && vacuumResult.ok, steps: { ...cheapResult.steps, ...vacuumResult.steps } }
      : cheapResult;
  }
  return result;
}

function sessionSummary(deps, args) {
  const content = args.content;
  const project = args.project || null;
  const sessionId = args['session-id'] || findLatestSession(project);
  if (!content) {
    return deps.jsonErrNoExit('Missing --content');
  }

  const rows = deps.sqlJson(
    `
    INSERT INTO observations (session_id, type, title, content, project, scope)
    VALUES (?, ?, ?, ?, ?, ?)
    RETURNING id, created_at
  `,
    [String(sessionId), 'session_summary', 'Session Summary', content, project, 'project'],
  );
  return { id: rows[0].id, title: 'Session Summary', created_at: rows[0].created_at };
}

module.exports = { findLatestSession, sessionStart, sessionEnd, sessionSummary };
