const { getDb } = require('../../db');

const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS token_saver_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  command TEXT NOT NULL,
  command_type TEXT NOT NULL,
  exit_code INTEGER,
  original_chars INTEGER NOT NULL,
  compressed_chars INTEGER NOT NULL,
  estimated_original_tokens INTEGER NOT NULL,
  estimated_compressed_tokens INTEGER NOT NULL,
  estimated_saved_tokens INTEGER NOT NULL,
  savings_percent REAL NOT NULL,
  summary TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

const CREATE_INDEX_SQL = 'CREATE INDEX IF NOT EXISTS idx_ts_runs_type ON token_saver_runs(command_type)';
const CREATE_INDEX_DATE_SQL = 'CREATE INDEX IF NOT EXISTS idx_ts_runs_date ON token_saver_runs(created_at DESC)';

let _tableEnsured = false;

function ensureTable() {
  if (_tableEnsured) {
    return;
  }
  const db = getDb();
  if (!db) {
    return;
  }
  try {
    db.exec(CREATE_TABLE_SQL);
    db.exec(CREATE_INDEX_SQL);
    db.exec(CREATE_INDEX_DATE_SQL);
    _tableEnsured = true;
  } catch (err) {
    // Swallow: the savings store is best-effort telemetry. A schema error
    // Here should not break the parent command (e.g. `lapis run`).
    // The next call retries ensureTable() because _tableEnsured stays false.
    void err;
  }
}

function recordRun(run) {
  ensureTable();
  const db = getDb();
  if (!db) {
    return;
  }
  try {
    const stmt = db.prepare(
      `INSERT INTO token_saver_runs (command, command_type, exit_code, original_chars, compressed_chars, estimated_original_tokens, estimated_compressed_tokens, estimated_saved_tokens, savings_percent, summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    stmt.run(
      run.command,
      run.commandType,
      run.exitCode,
      run.originalChars,
      run.compressedChars,
      run.estimatedOriginalTokens,
      run.estimatedCompressedTokens,
      run.estimatedSavedTokens,
      run.savingsPercent,
      run.summary || null,
    );
  } catch (err) {
    // Same rationale as ensureTable(): telemetry writes must never break
    // The user-facing command. A failed insert is dropped silently.
    void err;
  }
}

function getStats() {
  ensureTable();
  const db = getDb();
  if (!db) {
    return {
      totalRuns: 0,
      estimatedOriginalTokens: 0,
      estimatedCompressedTokens: 0,
      estimatedSavedTokens: 0,
      averageSavingsPercent: 0,
      topSavingCommandTypes: [],
    };
  }
  try {
    const rows = db
      .prepare(
        `SELECT
         COUNT(*) as totalRuns,
         COALESCE(SUM(estimated_original_tokens), 0) as estimatedOriginalTokens,
         COALESCE(SUM(estimated_compressed_tokens), 0) as estimatedCompressedTokens,
         COALESCE(SUM(estimated_saved_tokens), 0) as estimatedSavedTokens,
         COALESCE(AVG(savings_percent), 0) as averageSavingsPercent
       FROM token_saver_runs`,
      )
      .all();
    const stats = rows[0] || {};

    const topRows = db
      .prepare(
        `SELECT command_type as type, SUM(estimated_saved_tokens) as savedTokens
       FROM token_saver_runs
       GROUP BY command_type
       ORDER BY savedTokens DESC
       LIMIT 10`,
      )
      .all();

    return {
      totalRuns: stats.totalRuns || 0,
      estimatedOriginalTokens: stats.estimatedOriginalTokens || 0,
      estimatedCompressedTokens: stats.estimatedCompressedTokens || 0,
      estimatedSavedTokens: stats.estimatedSavedTokens || 0,
      averageSavingsPercent: Math.round((stats.averageSavingsPercent || 0) * 10) / 10,
      topSavingCommandTypes: topRows,
    };
  } catch {
    return {
      totalRuns: 0,
      estimatedOriginalTokens: 0,
      estimatedCompressedTokens: 0,
      estimatedSavedTokens: 0,
      averageSavingsPercent: 0,
      topSavingCommandTypes: [],
    };
  }
}

function clearStats() {
  ensureTable();
  const db = getDb();
  if (!db) {
    return;
  }
  try {
    db.exec('DELETE FROM token_saver_runs');
  } catch (err) {
    void err;
  }
}

function reset() {
  _tableEnsured = false;
}

module.exports = { recordRun, getStats, clearStats, ensureTable, reset };
