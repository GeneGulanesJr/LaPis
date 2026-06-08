const { getConfig } = require('../../config');
const { TIME_WINDOWS, RESULT_LIMITS, RANKING } = require('../../constants');
const { insertRecallLog } = require('./recall');

const TYPE_PRIORITY_CASE = `CASE o.type
  WHEN 'decision' THEN 3 WHEN 'architecture' THEN 3
  WHEN 'bugfix' THEN 2 WHEN 'pattern' THEN 2
  WHEN 'preference' THEN 2 WHEN 'config' THEN 1
  WHEN 'discovery' THEN 1 WHEN 'learning' THEN 1
  ELSE 0
END`;

const TRUST_RECALL_JOINS = `
LEFT JOIN (
  SELECT memory_id, MAX(trust_score) as trust_score
  FROM symbol_links GROUP BY memory_id
) sl ON sl.memory_id = CAST(o.id AS TEXT)
LEFT JOIN (
  SELECT memory_id,
         COUNT(*) as recall_count,
         SUM(CASE WHEN was_useful = 1 THEN 1 ELSE 0 END) as useful_count
  FROM recall_log GROUP BY memory_id
) rl ON rl.memory_id = o.id`;

function rankObservations(rows, query = '') {
  const now = Date.now();
  const queryWords = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1);

  // Detect navigation-style queries (where, module, hook, etc.)
  const isNavigationQuery = RANKING.NAVIGATION_QUERY_SIGNALS.some((signal) => query.toLowerCase().includes(signal));
  const pathPattern = RANKING.NAVIGATION_BOOST.path_pattern;

  return rows
    .map((row) => {
      let ftsScore = 0;
      if (row.rank !== undefined && row.rank !== null && row.rank !== 0) {
        ftsScore = -row.rank;
      } else if (queryWords.length > 0) {
        const title = (row.title || '').toLowerCase();
        const hits = queryWords.filter((w) => title.includes(w)).length;
        ftsScore = queryWords.length > 0 ? (hits / queryWords.length) * 2 : 0;
      }
      const ageMs = now - new Date(`${row.created_at}Z`).getTime();
      const recencyScore = Math.exp(-ageMs / TIME_WINDOWS.RECENCY_HALF_LIFE_MS);
      const trustScore =
        row.trust_score !== undefined && row.trust_score !== null ? row.trust_score : RANKING.DEFAULT_TRUST_SCORE;
      const recallCount = row.recall_count || 0;
      const usefulCount = row.useful_count || 0;
      const usefulRatio = recallCount > 0 ? usefulCount / recallCount : 0.5;
      const recallScore =
        Math.log(1 + recallCount) * RANKING.RECALL_LOG_MULTIPLIER * usefulRatio +
        usefulRatio * RANKING.USEFULNESS_MULTIPLIER;
      const typeBoost = RANKING.TYPE_BOOST[row.type] || 1.0;

      // Boost memories containing file paths for navigation queries
      let navBoost = 1.0;
      if (isNavigationQuery) {
        const text = `${row.title || ''} ${row.snippet || ''}`;
        if (pathPattern.test(text)) {
          navBoost = RANKING.NAVIGATION_BOOST.path_multiplier;
        }
      }

      const ranking = getConfig().ranking;
      const composite =
        (ftsScore * ranking.fts_relevance +
          recencyScore * ranking.recency +
          trustScore * ranking.trust +
          recallScore * ranking.recall) *
        typeBoost *
        navBoost;
      return { ...row, _score: composite };
    })
    .sort((a, b) => b._score - a._score);
}

function _extractFtsTerms(query) {
  // FTS5 stopwords — common words that don't help search
  const STOP_WORDS = new Set([
    'a',
    'an',
    'the',
    'is',
    'are',
    'was',
    'were',
    'be',
    'been',
    'being',
    'have',
    'has',
    'had',
    'do',
    'does',
    'did',
    'will',
    'would',
    'could',
    'should',
    'may',
    'might',
    'shall',
    'can',
    'need',
    'dare',
    'ought',
    'used',
    'to',
    'of',
    'in',
    'for',
    'on',
    'with',
    'at',
    'by',
    'from',
    'as',
    'into',
    'through',
    'during',
    'before',
    'after',
    'above',
    'below',
    'between',
    'out',
    'off',
    'over',
    'under',
    'again',
    'further',
    'then',
    'once',
    'and',
    'but',
    'or',
    'nor',
    'not',
    'so',
    'yet',
    'both',
    'either',
    'neither',
    'each',
    'every',
    'all',
    'any',
    'few',
    'more',
    'most',
    'other',
    'some',
    'such',
    'no',
    'only',
    'own',
    'same',
    'than',
    'too',
    'very',
    'just',
    'because',
    'if',
    'when',
    'where',
    'how',
    'what',
    'which',
    'who',
    'whom',
    'this',
    'that',
    'these',
    'those',
    'it',
    'its',
    'name',
    'also',
    'known',
    'keep',
    'answer',
    'concise',
    'mention',
    'explain',
    'file',
    'lives',
    'implemented',
  ]);
  const unique = [
    ...new Set(
      query
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
    ),
  ];
  // Use up to 5 most meaningful terms to avoid FTS5 implicit AND over-constraining
  return unique.slice(0, 5).join(' ');
}

function search(deps, args) {
  const { sqlJson, sqlRun, jsonErrNoExit } = deps;
  const query = args.query;
  const project = args.project || null;
  const type = args.type || null;
  const scope = args.scope || null;
  const limit = parseInt(args.limit || '10', 10);
  const sessionId = args['session-id'] ? parseInt(args['session-id'], 10) : null;
  const includeCode = args['include-code'] === 'true' || args['include-code'] === true;
  if (!query) {
    return jsonErrNoExit('Missing --query');
  }

  const isFtsSpecial = /[*"\-]|\b(AND|OR|NOT)\b/i.test(query);
  const needsFallback = query === '*' || query === '' || isFtsSpecial;

  let rows;
  if (!needsFallback) {
    try {
      let q = `
        SELECT o.id, o.title, o.type, o.project, o.scope, o.topic_key, o.created_at,
               snippet(observations_fts, 0, '»', '«', '…', 32) as snippet,
               rank,
               sl.trust_score,
               COALESCE(rl.recall_count, 0) as recall_count
        FROM observations o
        JOIN observations_fts fts ON o.id = fts.rowid
        ${TRUST_RECALL_JOINS}
        WHERE observations_fts MATCH ?
          AND o.deleted_at IS NULL
          AND (o.expires_at IS NULL OR o.expires_at > datetime('now'))
      `;
      const params = [_extractFtsTerms(query)];
      if (project) {
        q += ' AND o.project = ?';
        params.push(project);
      }
      if (type) {
        q += ' AND o.type = ?';
        params.push(type);
      }
      if (scope) {
        q += ' AND o.scope = ?';
        params.push(scope);
      }
      q += ' ORDER BY rank LIMIT ?';
      params.push(Math.min(limit * RESULT_LIMITS.SEARCH_MULTIPLIER, RESULT_LIMITS.SEARCH_MAX_ROWS));
      rows = sqlJson(q, params);
    } catch {
      rows = null;
    }
  }

  if (!rows || rows.length === 0) {
    let q = `
      SELECT o.id, o.title, o.type, o.project, o.scope, o.topic_key, o.created_at,
             '' as snippet, 0 as rank,
             sl.trust_score,
             COALESCE(rl.recall_count, 0) as recall_count,
             COALESCE(rl.useful_count, 0) as useful_count
      FROM observations o
      ${TRUST_RECALL_JOINS}
      WHERE (o.title LIKE ? OR o.content LIKE ?)
        AND o.deleted_at IS NULL
        AND (o.expires_at IS NULL OR o.expires_at > datetime('now'))
    `;
    const like = `%${query.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
    const params = [like, like];
    if (project) {
      q += ' AND o.project = ?';
      params.push(project);
    }
    if (type) {
      q += ' AND o.type = ?';
      params.push(type);
    }
    if (scope) {
      q += ' AND o.scope = ?';
      params.push(scope);
    }
    q += ' ORDER BY o.created_at DESC LIMIT ?';
    params.push(Math.min(limit * RESULT_LIMITS.SEARCH_MULTIPLIER, RESULT_LIMITS.SEARCH_MAX_ROWS));
    rows = sqlJson(q, params);
  }

  const ranked = rankObservations(rows, query).slice(0, limit);

  if (ranked.length > 0) {
    const rankedIds = ranked.map((r) => r.id);
    const placeholders = rankedIds.map(() => '?').join(',');
    const allRelations = sqlJson(
      `SELECT source_id, target_id, relation, confidence
       FROM observation_relations
       WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`,
      [...rankedIds, ...rankedIds],
    );
    const rankedIdSet = new Set(rankedIds);
    const relMap = new Map();
    for (const rel of allRelations) {
      for (const id of [rel.source_id, rel.target_id]) {
        if (rankedIdSet.has(id)) {
          if (!relMap.has(id)) {
            relMap.set(id, []);
          }
          relMap.get(id).push(rel);
        }
      }
    }
    for (const r of ranked) {
      r._relations = relMap.get(r.id) || [];
    }
  }

  if (sessionId && ranked.length > 0) {
    insertRecallLog(
      { sqlRun },
      ranked.map((r) => ({
        memoryId: r.id,
        sessionId,
        query,
      })),
    );
  }

  let codeResults = null;
  if (includeCode && deps.searchCode) {
    codeResults = deps.searchCode(query, null, null, limit);
  }

  return { results: ranked, code_results: codeResults };
}

function symbolCluster(deps, args) {
  const { sqlJson, jsonErrNoExit } = deps;
  const symbolId = args.symbol;
  const repo = args.repo || null;
  if (!symbolId) {
    return jsonErrNoExit('Missing --symbol');
  }

  let q = `
    SELECT o.id, o.title, o.type, o.project, o.scope, o.topic_key, o.created_at,
           sl.trust_score
    FROM observations o
    JOIN symbol_links sl ON sl.memory_id = CAST(o.id AS TEXT)
    WHERE sl.symbol_id = ?
      AND o.deleted_at IS NULL
  `;
  const params = [symbolId];
  if (repo) {
    q += ' AND sl.repo = ?';
    params.push(repo);
  }
  q += ' ORDER BY o.created_at DESC';

  return { symbol: symbolId, memories: sqlJson(q, params) };
}

function related(deps, args) {
  const { sqlJson, jsonErrNoExit } = deps;
  const id = parseInt(args.id);
  if (isNaN(id)) {
    return jsonErrNoExit('Missing --id');
  }

  const symbols = sqlJson('SELECT symbol_id, repo FROM symbol_links WHERE memory_id = ? AND symbol_id != ?', [
    String(id),
    '__unlinked__',
  ]);
  if (symbols.length === 0) {
    return { memory_id: id, related: [] };
  }

  const result = [];
  const symbolIds = symbols.map((s) => s.symbol_id);
  const placeholders = symbolIds.map(() => '?').join(',');
  const clusters = sqlJson(
    `
    SELECT sl.symbol_id, o.id, o.title, o.type, o.project, o.created_at
    FROM observations o
    JOIN symbol_links sl ON sl.memory_id = CAST(o.id AS TEXT)
    WHERE sl.symbol_id IN (${placeholders})
      AND o.id != ?
      AND o.deleted_at IS NULL
    ORDER BY o.created_at DESC
  `,
    [...symbolIds, id],
  );
  const grouped = new Map();
  for (const row of clusters) {
    if (!grouped.has(row.symbol_id)) {
      grouped.set(row.symbol_id, []);
    }
    if (grouped.get(row.symbol_id).length < RESULT_LIMITS.RELATED_PER_SYMBOL) {
      grouped.get(row.symbol_id).push(row);
    }
  }
  for (const sym of symbols) {
    const cluster = grouped.get(sym.symbol_id);
    if (cluster && cluster.length > 0) {
      result.push({ symbol: sym.symbol_id, repo: sym.repo, memories: cluster });
    }
  }

  return { memory_id: id, related: result };
}

module.exports = { rankObservations, search, symbolCluster, related, _extractFtsTerms, TRUST_RECALL_JOINS, TYPE_PRIORITY_CASE };
