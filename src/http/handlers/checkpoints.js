const { jsonOk, jsonCreated, jsonError } = require('../errors');

function createCheckpoint(repo) {
  return async (req, res, ctx) => {
    const { missionId, trigger, milestoneId, summary } = ctx.body,
      id = !(!missionId || !trigger || !milestoneId)
        ? `cp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        : undefined,
      rows = !(!missionId || !trigger || !milestoneId)
        ? repo.createCheckpoint({ id, missionId, trigger, milestoneId, summary: summary || '' })
        : undefined;
    if (!missionId || !trigger || !milestoneId) {
      return jsonError(res, 400, 'bad_request', 'missionId, trigger, and milestoneId are required');
    }
    jsonCreated(res, rows[0] || { id });
  };
}

function getCheckpoint(repo) {
  return async (req, res, ctx) => {
    const rows = repo.getCheckpoint(ctx.params.id);
    if (!rows || rows.length === 0) {
      return jsonError(res, 404, 'not_found', 'Checkpoint not found');
    }
    jsonOk(res, rows[0]);
  };
}

function resolveCheckpoint(repo) {
  return async (req, res, ctx) => {
    const { decision, guidance, reason, rescopeGuidance } = ctx.body,
      existing = decision ? repo.getCheckpoint(ctx.params.id) : undefined,
      rows =
        decision && !(!existing || existing.length === 0) && !(existing[0].status === 'resolved')
          ? repo.resolveCheckpoint(ctx.params.id, decision, guidance, reason, rescopeGuidance)
          : undefined;
    if (!decision) {
      return jsonError(res, 400, 'bad_request', 'decision is required');
    }
    if (!existing || existing.length === 0) {
      return jsonError(res, 404, 'not_found', 'Checkpoint not found');
    }
    if (existing[0].status === 'resolved') {
      return jsonOk(res, existing[0]);
    }
    jsonOk(res, rows[0]);
  };
}

function getPendingCheckpoints(repo) {
  return async (req, res, ctx) => {
    const missionId = ctx.params.missionId,
      rows = repo.getPendingCheckpoints(missionId);
    jsonOk(res, rows);
  };
}

module.exports = { createCheckpoint, getCheckpoint, resolveCheckpoint, getPendingCheckpoints };
