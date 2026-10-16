// Src/judgment/log.js
// The judgment log: one JSON line per judged call (surface, status, counts,
// Probabilities or levels per memory id, latency). It never holds memory text,
// Prompt text, message text or command text. Best-effort: writing it can never
// Affect the caller.
//
// Path: LAPIS_JUDGE_LOG, else judgment.log next to the configured memory DB
// (default ~/.pi/memory/judgment.log). LAPIS_JUDGE_LOG=0 turns it off.

const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');

function judgmentLogPath() {
  if (process.env.LAPIS_JUDGE_LOG) {
    return process.env.LAPIS_JUDGE_LOG;
  }
  try {
    const { getConfig } = require('../../config'),
      dbPath = getConfig().db_path;
    if (typeof dbPath === 'string' && dbPath) {
      return path.join(path.dirname(dbPath), 'judgment.log');
    }
  } catch {
    // Fall through to the default location
  }
  return path.join(os.homedir(), '.pi', 'memory', 'judgment.log');
}

/** Append one JSON line to the judgment log (best-effort, never throws). */
function writeJudgmentLog(record) {
  try {
    if (process.env.LAPIS_JUDGE_LOG === '0') {
      return;
    }
    const file = judgmentLogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
  } catch {
    // Logging must never affect the caller.
  }
}

/** Round a probability/confidence for the log (3 decimals). */
function round3(x) {
  return typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null;
}

/** Shorten a failure reason for the log. Reasons are provider/wire messages, never memory text. */
function capReason(reason) {
  const s = String(reason || 'no result');
  return s.length <= 200 ? s : `${s.slice(0, 200)}…`;
}

/**
 * LogSurfaceCall(surface, startedMs, fields) — one line for one judged call:
 * { ts, surface, ...fields, ms }. fields carry status and counts / ids / p only.
 */
function logSurfaceCall(surface, startedMs, fields) {
  writeJudgmentLog({
    ts: new Date(startedMs).toISOString(),
    surface,
    ...fields,
    ms: Date.now() - startedMs,
  });
}

module.exports = { judgmentLogPath, writeJudgmentLog, logSurfaceCall, round3, capReason };
