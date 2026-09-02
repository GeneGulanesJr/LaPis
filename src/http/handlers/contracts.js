const { jsonOk, jsonCreated } = require('../errors');

function createContract(repo) {
  return async (req, res, ctx) => {
    const content = ctx.body.content || ctx.body,
      id = `vc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      rows = repo.createContract({ id, milestoneId: ctx.params.milestoneId, version: 1, content }),
      row = rows[0] || { id, milestoneId: ctx.params.milestoneId, version: 1, content };
    jsonCreated(res, {
      ...row,
      supersedes: row.supersedes || null,
      supersededBy: row.superseded_by || null,
      rescopeEventId: row.rescope_event_id || null,
      createdAt: row.created_at || new Date().toISOString(),
    });
  };
}

function supersedeContract(repo) {
  return async (req, res, ctx) => {
    const { newContract, rescopeEvent } = ctx.body,
      id = `vc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      rows = repo.supersedeContract({ oldId: ctx.params.oldId, newId: id, newContract, rescopeEvent }),
      row = rows[0] || { id, version: 2, content: newContract };
    jsonCreated(res, {
      ...row,
      supersedes: row.supersedes || null,
      supersededBy: row.superseded_by || null,
      rescopeEventId: row.rescope_event_id || null,
      createdAt: row.created_at || new Date().toISOString(),
    });
  };
}

function getContractHistory(repo) {
  return async (req, res, ctx) => {
    const history = repo.getContractHistory(ctx.params.milestoneId);
    jsonOk(res, history);
  };
}

module.exports = { createContract, supersedeContract, getContractHistory };
