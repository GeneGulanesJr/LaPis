const { jsonOk, jsonCreated, jsonError } = require('../errors');

function createMilestone(repo) {
  return async (req, res, ctx) => {
    const { title, description, orderIndex } = ctx.body,
      id = `ms-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      rows = repo.createMilestone({ id, missionId: ctx.params.missionId, title, description, orderIndex });
    jsonCreated(
      res,
      rows[0] || { id, missionId: ctx.params.missionId, title, description, orderIndex, status: 'planned' },
    );
  };
}

function updateMilestoneStatus(repo) {
  return async (req, res, ctx) => {
    const { status } = ctx.body;
    if (typeof status !== 'string' || status.trim().length === 0) {
      return jsonError(res, 400, 'invalid_status', 'status is required and must be a non-empty string');
    }
    const rows = repo.updateMilestoneStatus(ctx.params.id, status);
    if (!rows || rows.length === 0) {
      return jsonError(res, 404, 'not_found', 'Milestone not found');
    }
    jsonOk(res, rows[0]);
  };
}

function listMilestonesForMission(repo) {
  return async (req, res, ctx) => {
    const rows = repo.listMilestonesForMission(ctx.params.missionId);
    jsonOk(res, rows);
  };
}

module.exports = { createMilestone, updateMilestoneStatus, listMilestonesForMission };
