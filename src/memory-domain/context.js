const { getConfig } = require('../../config');
const { RESULT_LIMITS, RANKING, CONTEXT } = require('../../constants');
const { TRUST_RECALL_JOINS, TYPE_PRIORITY_CASE } = require('./search');

function context(deps, args) {
  const { sqlJson, jsonErrNoExit } = deps;
  const insertRecallLog = deps.insertRecallLog || (() => {});
  const countObservationsByProjectAndType = deps.countObservationsByProjectAndType || (() => 0);

  const project = args.project || null;
  const limit = parseInt(args.limit || String(getConfig().context_limit), 10);
  const sessionId = args['session-id'] ? parseInt(args['session-id'], 10) : null;
  const topicKey = args['topic-key'] || null;
  const topicQuery = args.query || null;
  const deep = args.deep === 'true' || args.deep === true;
  const crossProject = !project || args['all-projects'] === 'true' || args['all-projects'] === true;
  if (!project && !crossProject) {
    return jsonErrNoExit('Missing --project');
  }

  const sessions = project
    ? sqlJson(
        `
    SELECT id, project, started_at, ended_at, memories_saved
    FROM session_log
    WHERE project = ?
    ORDER BY started_at DESC
    LIMIT ${RESULT_LIMITS.RECENT_SESSIONS}
  `,
        [project],
      )
    : [];

  const personal = sqlJson(`
    SELECT id, title, type, scope, topic_key, created_at
    FROM observations
    WHERE scope = 'personal' AND deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT ${RESULT_LIMITS.PERSONAL_OBSERVATIONS}
  `);

  let obsQuery, obsParams;
  if (crossProject) {
    const crossLimit = deep
      ? Math.min(limit * CONTEXT.CROSS_PROJECT_DEEP_MULTIPLIER, CONTEXT.CROSS_PROJECT_DEEP_MAX)
      : limit;
    obsQuery = `
      SELECT o.id, o.title, o.type, o.scope, o.topic_key, o.project, o.created_at,
             COALESCE(sl.trust_score, ${RANKING.DEFAULT_TRUST_SCORE}) as trust_score,
             COALESCE(rl.recall_count, 0) as recall_count,
             ${TYPE_PRIORITY_CASE} as type_priority
      FROM observations o
      ${TRUST_RECALL_JOINS}
      WHERE o.deleted_at IS NULL AND o.type != 'skill' AND o.scope = 'project'
      ORDER BY recall_count DESC, trust_score DESC, type_priority DESC, o.created_at DESC
      LIMIT ?
    `;
    obsParams = [crossLimit];
  } else if (topicKey || topicQuery) {
    const topicLimit = deep
      ? Math.min(limit * CONTEXT.CROSS_PROJECT_DEEP_MULTIPLIER, CONTEXT.CROSS_PROJECT_DEEP_MAX)
      : limit;
    if (topicQuery) {
      obsQuery = `
        WITH topic_matches AS (
          SELECT id FROM observations
          WHERE project = ? AND deleted_at IS NULL AND type != 'skill'
            AND (topic_key LIKE ? OR title LIKE ? OR content LIKE ?)
          ORDER BY created_at DESC
          LIMIT ?
        )
        SELECT o.id, o.title, o.type, o.scope, o.topic_key, o.created_at,
               COALESCE(sl.trust_score, ${RANKING.DEFAULT_TRUST_SCORE}) as trust_score,
               COALESCE(rl.recall_count, 0) as recall_count,
               ${TYPE_PRIORITY_CASE} as type_priority
        FROM observations o
        JOIN topic_matches tm ON o.id = tm.id
        ${TRUST_RECALL_JOINS}
        ORDER BY recall_count DESC, trust_score DESC, type_priority DESC, o.created_at DESC
      `;
      const like = `%${topicQuery.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
      obsParams = [project, like, like, like, topicLimit];
    } else {
      obsQuery = `
        SELECT o.id, o.title, o.type, o.scope, o.topic_key, o.created_at,
               COALESCE(sl.trust_score, ${RANKING.DEFAULT_TRUST_SCORE}) as trust_score,
               COALESCE(rl.recall_count, 0) as recall_count,
                 CASE
                   WHEN o.topic_key = ? THEN ${CONTEXT.TOPIC_MATCH_BOOST}
                   WHEN o.type = 'decision' THEN ${RANKING.TYPE_PRIORITY.decision} WHEN o.type = 'architecture' THEN ${RANKING.TYPE_PRIORITY.architecture}
                   WHEN o.type = 'bugfix' THEN ${RANKING.TYPE_PRIORITY.bugfix} WHEN o.type = 'pattern' THEN ${RANKING.TYPE_PRIORITY.pattern}
                   WHEN o.type = 'preference' THEN ${RANKING.TYPE_PRIORITY.preference} WHEN o.type = 'config' THEN ${RANKING.TYPE_PRIORITY.config}
                   WHEN o.type = 'discovery' THEN ${RANKING.TYPE_PRIORITY.discovery} WHEN o.type = 'learning' THEN ${RANKING.TYPE_PRIORITY.learning}
                   ELSE 0
                 END as type_priority
        FROM observations o
        ${TRUST_RECALL_JOINS}
        WHERE o.project = ? AND o.deleted_at IS NULL AND o.type != 'skill'
        ORDER BY recall_count DESC, CASE WHEN o.topic_key = ? THEN ${CONTEXT.TOPIC_MATCH_BOOST} ELSE type_priority END DESC, trust_score DESC, o.created_at DESC
        LIMIT ?
      `;
      obsParams = [topicKey, project, topicKey, topicLimit];
    }
  } else {
    obsQuery = `
      SELECT o.id, o.title, o.type, o.scope, o.topic_key, o.created_at,
             COALESCE(sl.trust_score, ${RANKING.DEFAULT_TRUST_SCORE}) as trust_score,
             COALESCE(rl.recall_count, 0) as recall_count,
             ${TYPE_PRIORITY_CASE} as type_priority
      FROM observations o
      ${TRUST_RECALL_JOINS}
      WHERE o.project = ? AND o.deleted_at IS NULL AND o.type != 'skill'
      ORDER BY recall_count DESC, type_priority DESC, trust_score DESC, o.created_at DESC
      LIMIT ?
    `;
    obsParams = [project, limit];
  }
  const observations = sqlJson(obsQuery, obsParams);

  const workflows = project
    ? sqlJson(
        `
    SELECT id, name, status, success, updated_at
    FROM procedural_memory
    WHERE (project = ? OR project IS NULL) AND status = 'active'
    ORDER BY updated_at DESC
    LIMIT ${RESULT_LIMITS.RECENT_SESSIONS}
  `,
        [project],
      )
    : [];

  if (sessionId && observations.length > 0) {
    const recallQuery = topicQuery || topicKey || 'context-auto';
    const entries = observations.map((o) => ({
      memoryId: o.id,
      sessionId: String(sessionId),
      query: recallQuery,
    }));
    insertRecallLog(entries);
  }

  const totalAll = countObservationsByProjectAndType(crossProject ? null : project);

  return {
    sessions,
    personal,
    observations,
    workflows,
    project: project || null,
    cross_project: crossProject,
    topic: topicKey || topicQuery || null,
    stats: {
      total_memories: totalAll,
      total_personal: personal.length,
      active_workflows: workflows.length,
    },
  };
}

module.exports = { context };
