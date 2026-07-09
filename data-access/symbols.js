const { TRUST_DELTA } = require('../constants');

function linkSymbol(deps, { memoryId, symbolId, repo, trust }) {
  const { sqlRun } = deps;
  const symVal = symbolId || '__unlinked__';
  sqlRun('INSERT OR REPLACE INTO symbol_links (memory_id, symbol_id, repo, trust_score) VALUES (?, ?, ?, ?)', [
    memoryId,
    symVal,
    repo,
    trust,
  ]);
  return { ok: true, memoryId, symbolId: symVal, repo, trustScore: trust };
}

function findUnlinked(deps, project) {
  const { sqlJson } = deps;
  return sqlJson(
    `SELECT CAST(id AS TEXT) as memory_id FROM observations
     WHERE project = ? AND deleted_at IS NULL
       AND CAST(id AS TEXT) NOT IN (SELECT memory_id FROM symbol_links)`,
    [project],
  );
}

function insertSymbolLink(deps, { memoryId, symbolId, repo, trustScore }) {
  const { sqlRun } = deps;
  sqlRun('INSERT OR IGNORE INTO symbol_links (memory_id, symbol_id, repo, trust_score) VALUES (?, ?, ?, ?)', [
    memoryId,
    symbolId,
    repo,
    trustScore,
  ]);
}

function adjustTrust(deps, { memoryId, delta, reason }) {
  const { sqlRun, sqlJson } = deps;
  sqlRun('UPDATE symbol_links SET trust_score = MIN(1.0, MAX(0.0, trust_score + ?)) WHERE memory_id = ?', [
    delta,
    memoryId,
  ]);
  sqlRun('INSERT INTO trust_adjustments (memory_id, reason, delta) VALUES (?, ?, ?)', [memoryId, reason, delta]);
  const updated = sqlJson('SELECT trust_score FROM symbol_links WHERE memory_id = ? LIMIT 1', [memoryId]);
  return updated.length > 0 ? updated[0].trust_score : null;
}

function recordRecall(deps, { sessionId, memoryId }) {
  const { sqlRun } = deps;
  sqlRun('INSERT OR IGNORE INTO session_recalls (session_id, memory_id) VALUES (?, ?)', [sessionId, memoryId]);
}

function getStaleLinks(deps, repo) {
  const { sqlJson } = deps;
  return sqlJson(
    `SELECT memory_id, symbol_id, repo, trust_score, last_verified
     FROM symbol_links
     WHERE repo = ? AND symbol_id != '__unlinked__'
     ORDER BY trust_score ASC`,
    [repo],
  );
}

function getAnchoredLinks(deps, repo) {
  const { sqlJson } = deps;
  return sqlJson(
    `SELECT memory_id, symbol_id, trust_score, last_verified
     FROM symbol_links WHERE repo = ? AND symbol_id != '__unlinked__'`,
    [repo],
  );
}

function updateLinkTrust(deps, { memoryId, symbolId, newTrust, _timestamp }) {
  const { sqlRun } = deps;
  sqlRun(
    "UPDATE symbol_links SET trust_score = ?, last_verified = datetime('now') WHERE memory_id = ? AND symbol_id = ?",
    [newTrust, memoryId, symbolId],
  );
}

function insertTrustAdjustment(deps, { memoryId, reason, delta }) {
  const { sqlRun } = deps;
  sqlRun('INSERT INTO trust_adjustments (memory_id, reason, delta) VALUES (?, ?, ?)', [memoryId, reason, delta]);
}

function getRecalledMemoryIds(deps, sessionId) {
  const { sqlJson } = deps;
  return sqlJson(
    `SELECT DISTINCT memory_id FROM (
       SELECT memory_id FROM recall_log WHERE session_id = ? AND was_useful = 1
       UNION
       SELECT memory_id FROM session_recalls WHERE session_id = ?
     )`,
    [sessionId, sessionId],
  );
}

function updateLinkTrustByMemoryId(deps, { memoryId, newTrust }) {
  const { sqlRun } = deps;
  sqlRun(
    `UPDATE symbol_links SET trust_score = MIN(${TRUST_DELTA.TRUST_CEILING}, trust_score + ?) WHERE memory_id = ?`,
    [newTrust, memoryId],
  );
}

function getSymbolsForMemory(deps, memoryId) {
  const { sqlJson } = deps;
  return sqlJson('SELECT symbol_id, repo FROM symbol_links WHERE memory_id = ? AND symbol_id != ?', [
    String(memoryId),
    '__unlinked__',
  ]);
}

function getSymbolCluster(deps, { symbolId, repo }) {
  const { sqlJson } = deps;
  let q = `
    SELECT o.id, o.title, o.type, o.project, o.scope, o.topic_key, o.created_at,
           sl.trust_score
    FROM observations o
    JOIN symbol_links sl ON sl.memory_id = CAST(o.id AS TEXT)
    WHERE sl.symbol_id = ?
      AND o.deleted_at IS NULL
  `;
  const params = [symbolId];
  if (repo) {
    q += ' AND sl.repo = ?';
    params.push(repo);
  }
  q += ' ORDER BY o.created_at DESC';
  return sqlJson(q, params);
}

function getRelatedMemories(deps, { memoryId, symbolIds, _limit }) {
  const { sqlJson } = deps;
  const placeholders = symbolIds.map(() => '?').join(',');
  return sqlJson(
    `SELECT sl.symbol_id, o.id, o.title, o.type, o.project, o.created_at
     FROM observations o
     JOIN symbol_links sl ON sl.memory_id = CAST(o.id AS TEXT)
     WHERE sl.symbol_id IN (${placeholders})
       AND o.id != ?
       AND o.deleted_at IS NULL
     ORDER BY o.created_at DESC`,
    [...symbolIds, memoryId],
  );
}

module.exports = {
  linkSymbol,
  findUnlinked,
  insertSymbolLink,
  adjustTrust,
  recordRecall,
  getStaleLinks,
  getAnchoredLinks,
  updateLinkTrust,
  insertTrustAdjustment,
  getRecalledMemoryIds,
  updateLinkTrustByMemoryId,
  getSymbolsForMemory,
  getSymbolCluster,
  getRelatedMemories,
};
