const { jsonOk, jsonCreated } = require('../errors');

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
    repo.updateMilestoneStatus(ctx.params.id, status);
    jsonOk(res, { ok: true });
  };
}

function listMilestonesForMission(repo) {
  return async (req, res, ctx) => {
    const rows = repo.listMilestonesForMission(ctx.params.missionId);
    jsonOk(res, rows);
  };
}

module.exports = { createMilestone, updateMilestoneStatus, listMilestonesForMission };
