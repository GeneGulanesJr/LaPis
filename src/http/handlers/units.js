const { jsonOk, jsonCreated } = require('../errors');

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
    repo.updateWorkingUnitStatus(ctx.params.id, status);
    jsonOk(res, { ok: true });
  };
}

module.exports = { createWorkingUnit, getWorkingUnitsForMilestone, updateWorkingUnitStatus };
