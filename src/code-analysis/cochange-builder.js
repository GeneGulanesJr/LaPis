/**
 * Co-change builder — extracts git co-occurrence frequency for behavioral coupling signal.
 * Full reindex only (expensive), cached in file_cochange table.
 */
const { execFileSync } = require('child_process');

/**
 * Parse git log output grouped by COMMIT: markers.
 * Returns a map of "fileA::fileB" → co_commit_count.
 */
function parseGitLogForCochange(logOutput) {
  const pairs = {},
    lines = logOutput.split('\n');
  let currentFiles = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('COMMIT:')) {
      processCommitFiles(currentFiles, pairs);
      currentFiles = [];
    } else if (trimmed) {
      currentFiles.push(trimmed);
    }
  }
  processCommitFiles(currentFiles, pairs);

  return pairs;
}

function processCommitFiles(files, pairs) {
  if (files.length >= 2) {
    const sorted = [...files].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = `${sorted[i]}::${sorted[j]}`;
        pairs[key] = (pairs[key] || 0) + 1;
      }
    }
  }
}

/**
 * Store co-change pairs into file_cochange table in both directions.
 */
function storeCochangePairs(db, repoId, pairs, pathToId, windowDays) {
  const insertStmt = db.prepare(
      `INSERT INTO file_cochange (repo_id, file_a_id, file_b_id, co_commit_count, strength, window_days)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo_id, file_a_id, file_b_id) DO UPDATE SET
       co_commit_count = excluded.co_commit_count,
       strength = excluded.strength`,
    ),
    maxCount = Math.max(...Object.values(pairs), 1);

  for (const [key, count] of Object.entries(pairs)) {
    const [pathA, pathB] = key.split('::'),
      idA = pathToId.get(pathA),
      idB = pathToId.get(pathB);
    if (idA && idB) {
      const strength = Math.round((count / maxCount) * 100) / 100;

      insertStmt.run(repoId, idA, idB, count, strength, windowDays);
      insertStmt.run(repoId, idB, idA, count, strength, windowDays);
    }
  }
}

/**
 * Build co-change edges from git history.
 * Full reindex only — expensive operation, cached in file_cochange table.
 */
function buildCochangeEdges(db, repoId, opts = {}) {
  const { windowDays = 90 } = opts,
    repo = db.prepare('SELECT path FROM code_repos WHERE id = ?').get(repoId);
  if (!repo || !repo.path) {
    return { success: false, count: 0, reason: 'repo not found' };
  }

  let logOutput;
  try {
    const since = new Date(Date.now() - windowDays * 86400000).toISOString().split('T')[0];
    logOutput = execFileSync('git', ['-C', repo.path, 'log', `--since=${since}`, '--format=COMMIT:%H', '--name-only'], {
      encoding: 'utf8',
      timeout: 30000,
    });
  } catch (e) {
    return { success: false, count: 0, reason: `git error: ${e.message}` };
  }

  const pairs = parseGitLogForCochange(logOutput);
  if (Object.keys(pairs).length === 0) {
    return { success: true, count: 0 };
  }

  {
const files = db.prepare('SELECT id, path FROM code_files WHERE repo_id = ?').all(repoId),
    pathToId = new Map(files.map((f) => [f.path, f.id])),
  pairCount = (() => {

  
    db.prepare('DELETE FROM file_cochange WHERE repo_id = ? AND window_days = ?').run(repoId, windowDays);
  
    storeCochangePairs(db, repoId, pairs, pathToId, windowDays);
  
    
  return (Object.keys(pairs).length);
})();return { success: true, count: pairCount };
}
}

module.exports = {
  buildCochangeEdges,
  parseGitLogForCochange,
  storeCochangePairs,
};
