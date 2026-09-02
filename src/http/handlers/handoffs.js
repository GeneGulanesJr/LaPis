const { jsonOk, jsonCreated, jsonError } = require('../errors');

function writeHandoff(repo) {
  return async (req, res, ctx) => {
    const body = ctx.body || {},
      errors = [];
    if (!body.featureName) {
      errors.push('featureName is required');
    }
    if (!body.description) {
      errors.push('description is required');
    }
    if (!body.gitCommitHash) {
      errors.push('gitCommitHash is required');
    }
    if (errors.length > 0) {
      return jsonError(res, 400, 'bad_request', errors.join('; '));
    }

    // Resolve the unit's milestone + mission so the handoff can be queried
    // By either dimension. Falls back to empty strings if the unit has been
    // Pruned (rare, but defensive — handoff data should never be lost).
    const unitId = ctx.params.unitId;
    let missionId = body.missionId || '',
      milestoneId = body.milestoneId || '';
    try {
      const unitRows = repo.getWorkingUnit ? repo.getWorkingUnit(unitId) : [];
      if (Array.isArray(unitRows) && unitRows.length > 0) {
        const u = unitRows[0];
        if (!milestoneId && u.milestone_id) {
          milestoneId = u.milestone_id;
        }
        // Look up the mission via the milestone if we still need it.
        if (!missionId && u.milestone_id && repo.getMilestone) {
          const ms = repo.getMilestone(u.milestone_id);
          if (Array.isArray(ms) && ms.length > 0 && ms[0].mission_id) {
            missionId = ms[0].mission_id;
          }
        }
      }
    } catch {
      // Best-effort resolution; persistence still works without them.
    }

    const id = `ho-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      commandsRun = Array.isArray(body.commandsRun)
        ? body.commandsRun
        : (() => {
            try {
              const parsed = typeof body.commandsRun === 'string' ? JSON.parse(body.commandsRun) : body.commandsRun;
              return Array.isArray(parsed) ? parsed : [];
            } catch {
              return [];
            }
          })(),
      rows = repo.createHandoff({
        id,
        unitId,
        missionId,
        milestoneId,
        featureName: body.featureName,
        description: body.description,
        implemented: body.implemented || '',
        remaining: body.remaining || '',
        rationale: body.rationale || '',
        assumptions: body.assumptions || '',
        unresolvedUncertainties: body.unresolvedUncertainties || '',
        errorsEncountered: body.errorsEncountered || '',
        commandsRun,
        gitCommitHash: body.gitCommitHash,
      }),
      stored =
        Array.isArray(rows) && rows.length > 0
          ? rows[0]
          : {
              id,
              unit_id: unitId,
              mission_id: missionId,
              milestone_id: milestoneId,
              feature_name: body.featureName,
            };

    jsonCreated(res, {
      accepted: true,
      errors: [],
      handoff: {
        id: stored.id,
        unitId: stored.unit_id || unitId,
        missionId: stored.mission_id || missionId,
        milestoneId: stored.milestone_id || milestoneId,
        featureName: stored.feature_name,
        gitCommitHash: stored.git_commit_hash,
        createdAt: stored.created_at,
      },
    });
  };
}

function getHandoffsForMilestone(repo) {
  return async (req, res, ctx) => {
    const rows = repo.getHandoffsForMilestone(ctx.params.milestoneId);
    jsonOk(res, rows);
  };
}

function getHandoffsForMission(repo) {
  return async (req, res, ctx) => {
    const rows = repo.getHandoffsForMission(ctx.params.missionId);
    jsonOk(res, rows);
  };
}

function getHandoffForUnit(repo) {
  return async (req, res, ctx) => {
    const rows = repo.getHandoffForUnit(ctx.params.unitId);
    jsonOk(res, rows);
  };
}

module.exports = {
  writeHandoff,
  getHandoffsForMilestone,
  getHandoffsForMission,
  getHandoffForUnit,
};
