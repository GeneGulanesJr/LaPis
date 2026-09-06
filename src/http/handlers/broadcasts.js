const { jsonOk, jsonCreated, jsonError } = require('../errors');

function writeBroadcast(repo) {
  return async (req, res, ctx) => {
    const { agentId, ...broadcast } = ctx.body,
      id = `b-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      rows = repo.createBroadcast({
        id,
        missionId: broadcast.missionId,
        authorId: agentId,
        authorType: broadcast.authorType,
        category: broadcast.category,
        title: broadcast.title,
        content: broadcast.content,
        status: 'active',
        ttl: broadcast.ttl,
        expiresAt: broadcast.expiresAt,
      });
    jsonCreated(
      res,
      rows[0] || {
        id,
        missionId: broadcast.missionId,
        authorId: agentId,
        status: 'active',
        createdAt: new Date().toISOString(),
      },
    );
  };
}

function transitionBroadcast(repo) {
  return async (req, res, ctx) => {
    const { newStatus, actorId } = ctx.body,
      rows = repo.transitionBroadcast(ctx.params.id, newStatus);
    if (!rows || rows.length === 0) {
      return jsonError(res, 404, 'not_found', 'Broadcast not found');
    }
    jsonOk(res, rows[0]);
  };
}

function getBroadcasts(repo) {
  return async (req, res, ctx) => {
    const statusParam = ctx.query.get('status'),
      statusFilter = statusParam ? statusParam.split(',') : undefined,
      broadcasts = repo.getBroadcasts(ctx.params.missionId, statusFilter);
    jsonOk(res, broadcasts);
  };
}

module.exports = { writeBroadcast, transitionBroadcast, getBroadcasts };
