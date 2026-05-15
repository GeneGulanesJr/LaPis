const { RANKING } = require('../../constants');

function insertRecallLog(deps, entries) {
  if (!entries || entries.length === 0) {
    return { inserted: 0 };
  }
  const { sqlRun } = deps;
  const placeholders = entries.map(() => '(?, ?, ?)').join(',');
  const params = entries.flatMap((r) => [r.memoryId, r.sessionId, r.query]);
  sqlRun(`INSERT OR IGNORE INTO recall_log (memory_id, session_id, query) VALUES ${placeholders}`, params);
  return { inserted: entries.length };
}

function getRecallCount(deps, memoryId) {
  const { sqlJson } = deps;
  const rows = sqlJson('SELECT COUNT(*) as cnt FROM recall_log WHERE memory_id = ?', [parseInt(memoryId, 10)]);
  return rows.length > 0 ? rows[0].cnt : 0;
}

function recallScore(recallCount) {
  return Math.log(1 + (recallCount || 0)) * RANKING.RECALL_LOG_MULTIPLIER;
}

module.exports = { insertRecallLog, getRecallCount, recallScore };
