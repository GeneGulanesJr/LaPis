const { jsonOk, jsonCreated, jsonError } = require('../errors');

function writeFinding(repo) {
  return async (req, res, ctx) => {
    const { agentId, ...finding } = ctx.body,
      id = `f-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      rows = repo.createFinding({
        id,
        missionId: finding.missionId,
        authorId: agentId,
        domain: finding.domain,
        title: finding.title,
        content: finding.content,
        relevance: finding.relevance,
        status: 'unverified',
      });
    jsonCreated(
      res,
      rows[0] || {
        id,
        missionId: finding.missionId,
        authorId: agentId,
        status: 'unverified',
        createdAt: new Date().toISOString(),
      },
    );
  };
}

function transitionFinding(repo) {
  return async (req, res, ctx) => {
    const { newStatus, actorId, actorContext } = ctx.body,
      rows = repo.transitionFinding(ctx.params.id, newStatus);
    if (!rows || rows.length === 0) {
      return jsonError(res, 404, 'not_found', 'Finding not found');
    }
    jsonOk(res, rows[0]);
  };
}

function getFindings(repo) {
  return async (req, res, ctx) => {
    const status = ctx.query.get('status') || undefined,
      findings = repo.getFindings(ctx.params.missionId, status);
    jsonOk(res, findings);
  };
}

module.exports = { writeFinding, transitionFinding, getFindings };
