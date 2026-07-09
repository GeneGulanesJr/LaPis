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
    const { query, limit } = ctx.body;
    const searchDeps = { sqlJson: deps.sqlJson, sqlRun: deps.sqlRun, jsonErrNoExit: (msg) => ({ error: msg }) };
    const search = require('../../memory-domain/search').search;
    const result = search(searchDeps, { query, limit: String(limit || 10) });
    if (result?.error) {
      return jsonError(res, 400, 'invalid_search', result.error);
    }
    jsonOk(res, mapSearchRows(result?.results));
  };
}

module.exports = { searchMemory, mapSearchRows };
