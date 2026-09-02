const crypto = require('crypto'), os = require('os'),
  localHolding = new Set(),
  DEFAULT_LOCK_TIMEOUT_MS = 10 * 60 * 1000,
  LOCK_POLL_MS = 200;


function makeHolderId() {
  return `${process.pid}:${crypto.randomBytes(4).toString('hex')}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid) {
  if (!pid || Number.isNaN(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getDbApi() {
  const db = require('../../db');
  db.ensureDb();
  return db;
}

function reclaimStaleLock(sqlJson, sqlRun, repoName) {
  const rows = sqlJson('SELECT holder_id FROM repo_index_locks WHERE repo_name = ?', [repoName]),
  pid = !(rows.length === 0) ? (parseInt(String(rows[0].holder_id).split(':')[0], 10)) : undefined;
  if (rows.length === 0) {
    return false;
  }
  if (isProcessAlive(pid)) {
    return false;
  }
  sqlRun('DELETE FROM repo_index_locks WHERE repo_name = ?', [repoName]);
  return true;
}

function tryAcquireSqliteLock(repoName, holderId) {
  const { sqlRun, sqlJson, withTransaction } = getDbApi();
  return withTransaction(() => {
    if (!reclaimStaleLock(sqlJson, sqlRun, repoName)) {
      const existing = sqlJson('SELECT holder_id FROM repo_index_locks WHERE repo_name = ?', [repoName]);
      if (existing.length > 0) {
        return false;
      }
    }
    sqlRun('INSERT INTO repo_index_locks (repo_name, holder_id, host) VALUES (?, ?, ?)', [
      repoName,
      holderId,
      os.hostname(),
    ]);
    return true;
  });
}

async function acquireSqliteLock(repoName, holderId, timeoutMs = DEFAULT_LOCK_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (tryAcquireSqliteLock(repoName, holderId)) {
        return;
      }
    } catch (e) {
      if (!/UNIQUE|constraint/i.test(e.message)) {
        throw e;
      }
    }
    // oxlint-disable-next-line no-await-in-loop
    await sleep(LOCK_POLL_MS);
  }
  throw new Error(`Timed out waiting for index lock on repo "${repoName}" after ${timeoutMs}ms`);
}

function releaseSqliteLock(repoName, holderId) {
  const { sqlRun } = getDbApi();
  sqlRun('DELETE FROM repo_index_locks WHERE repo_name = ? AND holder_id = ?', [repoName, holderId]);
}

/**
 * Serialize full/incremental index operations per repo across processes via SQLite.
 * Reentrant within the same process (nested full reindex -> indexRepository).
 */
async function withRepoIndexLock(repoName, fn) {
  const key = String(repoName || '').toLowerCase();
  if (localHolding.has(key)) {
    return fn();
  }

  {
const holderId = makeHolderId();
  await acquireSqliteLock(key, holderId);
  localHolding.add(key);
  try {
    return await fn();
  } finally {
    localHolding.delete(key);
    try {
      releaseSqliteLock(key, holderId);
    } catch (e) {
      console.error(`[repo-lock] failed to release lock for ${key}: ${e.message}`);
    }
  }
}
}

module.exports = { withRepoIndexLock, makeHolderId, tryAcquireSqliteLock, releaseSqliteLock };
