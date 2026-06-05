const { getConfig } = require('../../config');
const { RESULT_LIMITS, RANKING, CONTEXT } = require('../../constants');
const { estimateTokens } = require('../../utils');
const { TRUST_RECALL_JOINS, TYPE_PRIORITY_CASE } = require('./search');

const TOPIC_QUERY_STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'what',
  'where',
  'when',
  'why',
  'how',
  'did',
  'does',
  'into',
  'instead',
  'keep',
  'answer',
  'concise',
]);

function topicQueryNeedles(query) {
  const normalized = String(query || '')
    .toLowerCase()
    .trim();
  if (!normalized) {
    return [];
  }

  const phrase = normalized.length <= 120 ? [normalized] : [];
  const terms = normalized
    .match(/[a-z0-9_.\/-]+/g)
    ?.filter((term) => term.length >= 3 && !TOPIC_QUERY_STOP_WORDS.has(term))
    .slice(0, 16);

  const needles = [...new Set([...phrase, ...(terms || [])])];
  return needles.length > 0 ? needles : [normalized.slice(0, 120)];
}

function buildTopicQueryMatch(needles) {
  const fields = ["lower(coalesce(o.topic_key, ''))", "lower(coalesce(o.title, ''))", "lower(coalesce(o.content, ''))"];
  const whereParts = [];
  const whereParams = [];
  const scoreParts = [];
  const scoreParams = [];

  for (const needle of needles) {
    const like = `%${needle.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
    whereParts.push(`(${fields.map((field) => `${field} LIKE ?`).join(' OR ')})`);
    whereParams.push(...fields.map(() => like));
    for (const field of fields) {
      scoreParts.push(`CASE WHEN ${field} LIKE ? THEN 1 ELSE 0 END`);
      scoreParams.push(like);
    }
  }

  return {
    whereSql: whereParts.join(' OR '),
    scoreSql: scoreParts.length > 0 ? scoreParts.join(' + ') : '0',
    whereParams,
    scoreParams,
  };
}

function context(deps, args) {
  const { sqlJson, jsonErrNoExit } = deps;
  const insertRecallLog = deps.insertRecallLog || (() => {});
  const countObservationsByProjectAndType = deps.countObservationsByProjectAndType || (() => 0);

  const project = args.project || null;
  const limit = parseInt(args.limit || String(getConfig().context_limit), 10);
  const rawBudget = parseInt(args['token-budget'], 10);
  const tokenBudget = Number.isFinite(rawBudget) && rawBudget > 0 ? rawBudget : 0;
  const fetchCeiling = tokenBudget > 0 ? Math.max(limit, limit * 3) : limit;
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
    SELECT id, title, type, scope, topic_key, expires_at, created_at
    FROM observations
    WHERE scope = 'personal' AND deleted_at IS NULL
      AND (expires_at IS NULL OR expires_at > datetime('now'))
    ORDER BY created_at DESC
    LIMIT ${RESULT_LIMITS.PERSONAL_OBSERVATIONS}
  `);

  let obsQuery, obsParams;
  if (crossProject) {
    const crossLimit = deep
      ? Math.min(fetchCeiling * CONTEXT.CROSS_PROJECT_DEEP_MULTIPLIER, CONTEXT.CROSS_PROJECT_DEEP_MAX)
      : fetchCeiling;
    obsQuery = `
      SELECT o.id, o.title, o.content, o.type, o.scope, o.topic_key, o.project, o.created_at,
             COALESCE(sl.trust_score, ${RANKING.DEFAULT_TRUST_SCORE}) as trust_score,
             COALESCE(rl.recall_count, 0) as recall_count,
             ${TYPE_PRIORITY_CASE} as type_priority
      FROM observations o
      ${TRUST_RECALL_JOINS}
      WHERE o.deleted_at IS NULL AND o.type != 'skill' AND o.scope = 'project'
        AND (o.expires_at IS NULL OR o.expires_at > datetime('now'))
      ORDER BY recall_count DESC, trust_score DESC, type_priority DESC, o.created_at DESC
      LIMIT ?
    `;
    obsParams = [crossLimit];
  } else if (topicKey || topicQuery) {
    const topicLimit = deep
      ? Math.min(fetchCeiling * CONTEXT.CROSS_PROJECT_DEEP_MULTIPLIER, CONTEXT.CROSS_PROJECT_DEEP_MAX)
      : fetchCeiling;
    if (topicQuery) {
      const match = buildTopicQueryMatch(topicQueryNeedles(topicQuery));
      obsQuery = `
        WITH topic_matches AS (
          SELECT id, ${match.scoreSql} as match_score
          FROM observations o
          WHERE project = ? AND deleted_at IS NULL AND type != 'skill'
            AND (expires_at IS NULL OR expires_at > datetime('now'))
            AND (${match.whereSql})
          ORDER BY match_score DESC, created_at DESC
          LIMIT ?
        )
        SELECT o.id, o.title, o.content, o.type, o.scope, o.topic_key, o.created_at,
               COALESCE(sl.trust_score, ${RANKING.DEFAULT_TRUST_SCORE}) as trust_score,
               COALESCE(rl.recall_count, 0) as recall_count,
               ${TYPE_PRIORITY_CASE} as type_priority
        FROM observations o
        JOIN topic_matches tm ON o.id = tm.id
        ${TRUST_RECALL_JOINS}
        ORDER BY tm.match_score DESC, recall_count DESC, trust_score DESC, type_priority DESC, o.created_at DESC
      `;
      obsParams = [...match.scoreParams, project, ...match.whereParams, topicLimit];
    } else {
      obsQuery = `
        SELECT o.id, o.title, o.content, o.type, o.scope, o.topic_key, o.created_at,
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
          AND (o.expires_at IS NULL OR o.expires_at > datetime('now'))
        ORDER BY recall_count DESC, CASE WHEN o.topic_key = ? THEN ${CONTEXT.TOPIC_MATCH_BOOST} ELSE type_priority END DESC, trust_score DESC, o.created_at DESC
        LIMIT ?
      `;
      obsParams = [topicKey, project, topicKey, topicLimit];
    }
  } else {
    obsQuery = `
      SELECT o.id, o.title, o.content, o.type, o.scope, o.topic_key, o.created_at,
             COALESCE(sl.trust_score, ${RANKING.DEFAULT_TRUST_SCORE}) as trust_score,
             COALESCE(rl.recall_count, 0) as recall_count,
             ${TYPE_PRIORITY_CASE} as type_priority
      FROM observations o
      ${TRUST_RECALL_JOINS}
      WHERE o.project = ? AND o.deleted_at IS NULL AND o.type != 'skill'
        AND (o.expires_at IS NULL OR o.expires_at > datetime('now'))
      ORDER BY recall_count DESC, type_priority DESC, trust_score DESC, o.created_at DESC
      LIMIT ?
    `;
    obsParams = [project, fetchCeiling];
  }
  const observations = sqlJson(obsQuery, obsParams);

  const excludedSet = new Set(CONTEXT.EXCLUDED_TYPES);
  const filtered = observations.filter((o) => !excludedSet.has(o.type));

  const budgeted = tokenBudget > 0 ? applyTokenBudget(filtered, tokenBudget) : filtered;
  const truncatedCount = budgeted.filter((o) => o._truncated).length;

  if (sessionId && budgeted.length > 0) {
    const recallQuery = topicQuery || topicKey || 'context-auto';
    const entries = budgeted.map((o) => ({
      memoryId: o.id,
      sessionId: String(sessionId),
      query: recallQuery,
    }));
    insertRecallLog(entries);
  }

  // Supplemental cross-project suggestions: when project-scoped, also find
  // relevant memories from other projects so insights transfer across projects.
  let crossProjectSuggestions = [];
  if (!crossProject && project && filtered.length > 0 && topicQuery) {
    const supplementLimit = CONTEXT.CROSS_PROJECT_SUPPLEMENT_LIMIT || 3;
    const match = buildTopicQueryMatch(topicQueryNeedles(topicQuery));
    crossProjectSuggestions = sqlJson(
      `
        SELECT o.id, o.title, o.type, o.project, o.created_at,
               COALESCE(sl.trust_score, ${RANKING.DEFAULT_TRUST_SCORE}) as trust_score,
               ${match.scoreSql} as match_score
        FROM observations o
        LEFT JOIN symbol_links sl ON sl.memory_id = o.id
        WHERE o.deleted_at IS NULL AND o.type != 'skill'
          AND o.scope = 'project' AND o.project != ?
          AND (o.expires_at IS NULL OR o.expires_at > datetime('now'))
          AND (${match.whereSql})
        GROUP BY o.id
        ORDER BY match_score DESC, trust_score DESC, o.created_at DESC
        LIMIT ?`,
      [...match.scoreParams, project, ...match.whereParams, supplementLimit],
    );
  }

  const totalAll = countObservationsByProjectAndType(crossProject ? null : project);

  return {
    sessions,
    personal,
    observations: budgeted,
    cross_project_suggestions: crossProjectSuggestions,
    project: project || null,
    cross_project: crossProject,
    topic: topicKey || topicQuery || null,
    stats: {
      total_memories: totalAll,
      total_personal: personal.length,
      cross_project_suggestions: crossProjectSuggestions.length,
      ...(tokenBudget > 0
        ? {
            budget_used: budgeted.reduce((sum, o) => sum + (o._tokens || 0), 0),
            budget_tokens: tokenBudget,
            truncated_count: truncatedCount,
            total_count: filtered.length,
          }
        : {}),
    },
  };
}

function applyTokenBudget(observations, budget) {
  const neverTruncate = new Set(CONTEXT.NEVER_TRUNCATE_TYPES || []);
  const result = [];
  let used = 0;

  if (budget < (CONTEXT.TOKEN_BUDGET_MIN || 500)) {
    const limit = CONTEXT.HEADERS_ONLY_LIMIT || 3;
    for (const obs of observations.slice(0, limit)) {
      const header = `[#${obs.id}] [${obs.type}] ${obs.title} trust=${obs.trust_score}`;
      const tokens = estimateTokens(header);
      if (used + tokens > budget) {
        break;
      }
      result.push({ ...obs, content: '', _truncated: true, _tokens: tokens });
      used += tokens;
    }
    return result;
  }

  for (const obs of observations) {
    const fullText = `${obs.title}\n${obs.content || ''}`;
    const fullTokens = estimateTokens(fullText);

    if (used + fullTokens <= budget || neverTruncate.has(obs.type)) {
      result.push(neverTruncate.has(obs.type) && used + fullTokens > budget
        ? { ...obs, _tokens: fullTokens, _truncated: false }
        : { ...obs, _tokens: fullTokens });
      used += fullTokens;
      // oxlint-disable-next-line no-continue
      continue;
    }

    const truncChars = CONTEXT.TRUNCATE_CONTENT_CHARS || 100;
    const truncContent = (obs.content || '').slice(0, truncChars);
    const truncText = `${obs.title}\n${truncContent}…`;
    const truncTokens = estimateTokens(truncText);

    if (used + truncTokens <= budget) {
      result.push({ ...obs, content: `${truncContent}…`, _truncated: true, _tokens: truncTokens });
      used += truncTokens;
      // oxlint-disable-next-line no-continue
      continue;
    }

    const header = `[#${obs.id}] [${obs.type}] ${obs.title} trust=${obs.trust_score}`;
    const headerTokens = estimateTokens(header);
    if (used + headerTokens <= budget) {
      result.push({ ...obs, content: '', _truncated: true, _tokens: headerTokens });
      used += headerTokens;
      // oxlint-disable-next-line no-continue
      continue;
    }

    break;
  }

  return result;
}

module.exports = { context };
