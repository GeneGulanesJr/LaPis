const { jsonOk, jsonCreated, jsonError } = require('../errors');

function createMission(repo) {
  return async (req, res, ctx) => {
    const { description, config } = ctx.body,
      id = `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      rows = repo.createMission({ id, description, status: 'planning', configJson: config });
    jsonCreated(
      res,
      rows[0] || { id, description, status: 'planning', configJson: config, createdAt: new Date().toISOString() },
    );
  };
}

function getMission(repo) {
  return async (req, res, ctx) => {
    const rows = repo.getMission(ctx.params.id),
      row = !(rows.length === 0) ? rows[0] : undefined;
    if (rows.length === 0) {
      return jsonError(res, 404, 'not_found', 'Mission not found');
    }
    jsonOk(res, { ...row, configJson: safeParse(row.config_json) });
  };
}

function updateMissionStatus(repo) {
  return async (req, res, ctx) => {
    const { status } = ctx.body;
    if (typeof status !== 'string' || status.trim().length === 0) {
      return jsonError(res, 400, 'invalid_status', 'status is required and must be a non-empty string');
    }
    const rows = repo.updateMissionStatus(ctx.params.id, status);
    if (!rows || rows.length === 0) {
      return jsonError(res, 404, 'not_found', 'Mission not found');
    }
    jsonOk(res, rows[0]);
  };
}

function listMissions(repo) {
  return async (req, res, ctx) => {
    const status = ctx.query.get('status') || undefined,
      rows = repo.listMissions(status);
    jsonOk(res, rows);
  };
}

function safeParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

module.exports = { createMission, getMission, updateMissionStatus, listMissions };
