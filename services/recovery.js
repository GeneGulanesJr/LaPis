const { TIME_WINDOWS } = require('../constants');

function autoRecoverInternal(deps, sessionId) {
  const { sqlJson, sqlRun } = deps,
    session = sqlJson('SELECT * FROM session_log WHERE id = ?', [parseInt(sessionId)]);
  if (session.length === 0) {
    return null;
  }

  const obs = sqlJson(
    `
    SELECT id, title, type, content, created_at
    FROM observations
    WHERE session_id = ? AND deleted_at IS NULL AND type NOT IN ('skill', 'session_summary', 'progress', 'accomplished')
    ORDER BY created_at ASC
  `,
    [sessionId],
  );

  if (obs.length === 0) {
    sqlRun("UPDATE session_log SET ended_at = datetime('now') WHERE id = ?", [parseInt(sessionId)]);
    return null;
  }

  const types = {},
  lines = (() => {

    for (const o of obs) {
      if (!types[o.type]) {
        types[o.type] = [];
      }
      types[o.type].push(o.title);
    }
  
    
  return (['## Auto-Recovered Session Summary', '']);
})(),
  summary = (() => {
lines.push(`**Session:** ${sessionId}`);
    lines.push(`**Started:** ${session[0].started_at}`);
    lines.push(`**Observations:** ${obs.length}`);
    lines.push('');
    for (const [type, titles] of Object.entries(types)) {
      lines.push(`### ${type}`);
      for (const t of titles) {
        lines.push(`- ${t}`);
      }
      lines.push('');
    }
    
  return (lines.join('\n'));
})(); sqlJson(
    `
    INSERT INTO observations (session_id, type, title, content, project, scope)
    VALUES (?, 'session_summary', 'Auto-Recovered Session Summary', ?, ?, 'project')
    RETURNING id
  `,
    [sessionId, summary, session[0].project],
  );

  sqlRun("UPDATE session_log SET ended_at = datetime('now') WHERE id = ?", [parseInt(sessionId)]);

  return {
    status: 'recovered',
    observations_processed: obs.length,
    types: Object.fromEntries(Object.entries(types).map(([k, v]) => [k, v.length])),
  };
}

function autoRecover(deps, args) {
  const { jsonErrNoExit } = deps,
    sessionId = args.session,
  result = sessionId ? (autoRecoverInternal(deps, sessionId)) : undefined;
  if (!sessionId) {
    return jsonErrNoExit('Missing --session');
  }
  if (!result) {
    return { status: 'nothing_to_recover' };
  }
  return result;
}

function recoverOrphans(deps) {
  const { sqlJson, softDeleteObservation } = deps,
    orphans = sqlJson('SELECT id, project FROM session_log WHERE ended_at IS NULL ORDER BY started_at DESC'),
  recovered = !(orphans.length === 0) ? ([]) : undefined,
  allObservations = !(orphans.length === 0) ? ([]) : undefined;
  if (orphans.length === 0) {
    return { recovered: [], total: 0 };
  }

  for (const o of orphans) {
    const r = autoRecoverInternal(deps, String(o.id));
    if (r) {
      recovered.push(o.project);
      allObservations.push(r.observations_processed);
    }
  }

  if (recovered.length > 1) {
    const recentSummaries = sqlJson(
      `SELECT id, content FROM observations
       WHERE type = 'session_summary'
       AND title = 'Auto-Recovered Session Summary'
        AND created_at > datetime('now', '-${TIME_WINDOWS.RECOVERY_RECENT_MINUTES} minutes')
       AND deleted_at IS NULL
       ORDER BY id ASC`,
    );

    if (recentSummaries.length > 1) {
      const lines = ['## Consolidated Recovery Summary', ''],
      projects = (() => {

        lines.push(`**Sessions recovered:** ${recentSummaries.length}`);
        lines.push(`**Total observations:** ${allObservations.reduce((a, b) => a + b, 0)}`);
        lines.push('');
  
        
  return ([...new Set(recovered)]);
})(),
      consolidatedContent = (() => {
lines.push(`**Projects:** ${projects.join(', ')}`);
        lines.push('');
  
        for (const s of recentSummaries) {
          softDeleteObservation(s.id);
        }
  
        
  return (lines.join('\n'));
})();sqlJson(
        `INSERT INTO observations (session_id, type, title, content, project, scope)
         VALUES (?, 'session_summary', 'Consolidated Recovery Summary', ?, ?, 'project')
         RETURNING id`,
        [orphans[0].id, consolidatedContent, orphans[0].project],
      );
    }
  }

  return { recovered, total: orphans.length };
}

module.exports = { autoRecoverInternal, autoRecover, recoverOrphans };
