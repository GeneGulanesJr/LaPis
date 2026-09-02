const { jsonOk } = require('../errors');

function logCost(repo) {
  return async (req, res, ctx) => {
    const entry = ctx.body,
      id = entry.id || `ce-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    repo.logCost({ id, ...entry });
    jsonOk(res, { ok: true });
  };
}

function getMissionCost(repo) {
  return async (req, res, ctx) => {
    const summary = repo.getMissionCost(ctx.params.missionId);
    jsonOk(res, summary);
  };
}

module.exports = { logCost, getMissionCost };
