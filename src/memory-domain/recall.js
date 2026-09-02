const { RANKING } = require('../../constants'),
  { insertRecallLog: insertRecallLogDA } = require('../../data-access/observations');

function insertRecallLog(deps, entries) {
  if (!entries || entries.length === 0) {
    return { inserted: 0 };
  }
  insertRecallLogDA(deps, entries);
  return { inserted: entries.length };
}

function getRecallCount(deps, memoryId) {
  const { sqlJson } = deps,
    rows = sqlJson('SELECT COUNT(*) as cnt FROM recall_log WHERE memory_id = ?', [parseInt(memoryId, 10)]);
  return rows.length > 0 ? rows[0].cnt : 0;
}

function recallScore(recallCount) {
  return Math.log(1 + (recallCount || 0)) * RANKING.RECALL_LOG_MULTIPLIER;
}

module.exports = { insertRecallLog, getRecallCount, recallScore };
