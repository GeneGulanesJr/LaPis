const { jsonOk, jsonCreated, jsonError } = require('../errors');

function createWorkingUnit(repo) {
  return async (req, res, ctx) => {
    const { description, declaredPaths, declaredModules } = ctx.body,
      id = `wu-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      rows = repo.createWorkingUnit({
        id,
        milestoneId: ctx.params.milestoneId,
        description,
        declaredPaths,
        declaredModules,
      });
    jsonCreated(
      res,
      rows[0] || {
        id,
        milestoneId: ctx.params.milestoneId,
        description,
        declaredPaths,
        declaredModules,
        status: 'spawned',
      },
    );
  };
}

function getWorkingUnitsForMilestone(repo) {
  return async (req, res, ctx) => {
    const rows = repo.getWorkingUnitsForMilestone(ctx.params.milestoneId);
    jsonOk(res, rows);
  };
}

function updateWorkingUnitStatus(repo) {
  return async (req, res, ctx) => {
    const { status } = ctx.body;
    if (typeof status !== 'string' || status.trim().length === 0) {
      return jsonError(res, 400, 'invalid_status', 'status is required and must be a non-empty string');
    }
    const rows = repo.updateWorkingUnitStatus(ctx.params.id, status);
    if (!rows || rows.length === 0) {
      return jsonError(res, 404, 'not_found', 'Working unit not found');
    }
    jsonOk(res, rows[0]);
  };
}

module.exports = { createWorkingUnit, getWorkingUnitsForMilestone, updateWorkingUnitStatus };
