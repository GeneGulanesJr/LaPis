const { jsonOk, jsonError } = require('../errors');

function mapSearchRows(rows) {
  return (rows || []).map((r) => ({
    id: r.id,
    title: r.title || '',
    content: r.snippet || r.content || '',
    type: r.type || '',
    scope: r.scope || '',
    topicKey: r.topic_key || null,
  }));
}

function searchMemory(deps) {
  return async (req, res, ctx) => {
    const { query, limit, project, type, scope } = ctx.body,
      searchDeps = { sqlJson: deps.sqlJson, sqlRun: deps.sqlRun, jsonErrNoExit: (msg) => ({ error: msg }) },
      search = require('../../memory-domain/search').search,
      // Non-numeric limits used to bind NaN into LIMIT ? and 500 (#304).
      parsedLimit = Number.parseInt(limit, 10),
      safeLimit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? String(Math.min(parsedLimit, 100)) : '10',
      result = search(searchDeps, {
        query,
        limit: safeLimit,
        // The underlying search supports these filters; dropping them made
        // Every route search cross-project silently (#304).
        ...(project ? { project: String(project) } : {}),
        ...(type ? { type: String(type) } : {}),
        ...(scope ? { scope: String(scope) } : {}),
      });
    if (result?.error) {
      return jsonError(res, 400, 'invalid_search', result.error);
    }
    jsonOk(res, mapSearchRows(result?.results));
  };
}

module.exports = { searchMemory, mapSearchRows };
