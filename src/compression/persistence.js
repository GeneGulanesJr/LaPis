const { getDb } = require('../../db');

/**
 * Record a compression run in the mission_compression_log table.
 * Failures are non-fatal; the handler logs a warning.
 *
 * @param {object} args
 * @param {string} args.missionId
 * @param {string} args.trigger - one of "post_milestone" | "manual" | "budget_threshold"
 * @param {{ summary?: string|null, tokensSaved?: number, error?: string }} args.result
 */
function recordCompressionRun({ missionId, trigger, result }) {
  const stmt = `INSERT INTO mission_compression_log
    (mission_id, trigger, summary, tokens_saved, error)
    VALUES (?, ?, ?, ?, ?)`;
  const db = getDb();
  db.prepare(stmt).run(missionId, trigger, result.summary ?? '', result.tokensSaved ?? 0, result.error ?? null);
}

module.exports = { recordCompressionRun };
