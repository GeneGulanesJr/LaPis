const { jsonOk, jsonError } = require('../errors');

function incrementRetry(repo) {
  return async (req, res, ctx) => {
    const result = repo.incrementRetry(ctx.params.milestoneId);
    if (!result) {
      return jsonError(res, 404, 'not_found', 'Milestone not found');
    }
    jsonOk(res, result);
  };
}

function logRescope(repo) {
  return async (req, res, ctx) => {
    const created = repo.logRescope(ctx.params.milestoneId, ctx.body);
    if (created === false) {
      return jsonError(res, 404, 'not_found', 'Milestone not found');
    }
    jsonOk(res, { ok: true });
  };
}

module.exports = { incrementRetry, logRescope };
