const { jsonOk, jsonError } = require('../errors');
const { compressMissionState } = require('../../compression/mission-state');
const { recordCompressionRun } = require('../../compression/persistence');
const { getDb } = require('../../../db');

function runCompression() {
  return async (req, res, ctx) => {
    const trigger = ctx.body?.trigger || 'manual';
    const missionId = ctx.params.missionId;

    if (!missionId) {
      return jsonError(res, 400, 'missionId is required', 'missionId is required');
    }

    let db;
    try {
      db = getDb();
    } catch (e) {
      console.error(`[compression] db unavailable for ${missionId}:`, e.message);
      return jsonError(res, 500, 'database unavailable', e.message);
    }

    const sqlJson = (sql, params = []) => {
      try {
        return db.prepare(sql).all(...params);
      } catch (e) {
        console.error(`[compression] query failed:`, e.message, '\n', sql);
        return [];
      }
    };

    let result;
    try {
      result = compressMissionState({ sqlJson, missionId });
    } catch (e) {
      console.error(`[compression] compress threw for ${missionId}:`, e.message);
      result = {
        summary: null,
        tokensSaved: 0,
        error: e.message,
      };
    }

    // Persist so compression history is queryable later.
    try {
      recordCompressionRun({ missionId, trigger, result });
    } catch (e) {
      console.warn(`[compression] persistence failed (non-fatal):`, e.message);
    }

    console.log(
      `[compression] ${trigger} for ${missionId}: saved ${result.tokensSaved} tokens, summary=${(result.summary ?? '').slice(0, 80)}…`,
    );

    return jsonOk(res, result);
  };
}

module.exports = { runCompression };
