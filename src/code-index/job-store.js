// CRUD for the index_jobs table. Uses the high-level sqlJson/sqlRun wrappers
// from db.js so it works in both the worker thread (which calls createDb()
// inside the worker) and in CLI/tests. SQLite WAL mode lets readers and
// writers proceed in parallel without blocking each other.
//
// The wrapper accepts a "deps" object shaped like { sqlJson, sqlRun }.
// Tests pass { sqlJson, sqlRun } from a fresh createDb() session; the worker
// uses the same functions from db.js.

function createJob(deps, { repoName, mode = 'full', filesTotal = 0 }) {
  const rows = deps.sqlJson(
    `INSERT INTO index_jobs (repo_name, mode, status, files_total)
     VALUES (?, ?, 'running', ?) RETURNING id`,
    [repoName, mode, filesTotal],
  );
  return rows[0].id;
}

function updateProgress(deps, jobId, { filesDone, currentFile, languageBreakdown }) {
  const sets = ['files_done = ?'];
  const params = [filesDone];
  if (currentFile !== undefined) {
    sets.push('current_file = ?');
    params.push(currentFile);
  }
  if (languageBreakdown !== undefined) {
    sets.push('language_breakdown = ?');
    params.push(JSON.stringify(languageBreakdown));
  }
  params.push(jobId);
  deps.sqlRun(`UPDATE index_jobs SET ${sets.join(', ')} WHERE id = ?`, params);
}

function completeJob(deps, jobId, { status, error } = {}) {
  const finalStatus = status || 'completed';
  const params = [finalStatus];
  let sql = `UPDATE index_jobs SET status = ?, completed_at = datetime('now')`;
  if (error) {
    sql += ', error = ?';
    params.push(error);
  }
  params.push(jobId);
  sql += ' WHERE id = ?';
  deps.sqlRun(sql, params);
}

function getJob(deps, jobId) {
  const rows = deps.sqlJson('SELECT * FROM index_jobs WHERE id = ?', [jobId]);
  return rows[0];
}

function listRunningJobs(deps) {
  return deps.sqlJson(`SELECT * FROM index_jobs WHERE status = 'running' ORDER BY started_at DESC`, []);
}

function listRecentJobs(deps, limit = 20) {
  return deps.sqlJson(`SELECT * FROM index_jobs ORDER BY started_at DESC LIMIT ?`, [limit]);
}

module.exports = { createJob, updateProgress, completeJob, getJob, listRunningJobs, listRecentJobs };
