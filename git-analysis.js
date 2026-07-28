/**
 * Git-analysis.js — Git commit frequency analysis for churn metrics
 *
 * Uses git CLI (zero native deps). Gracefully degrades if git unavailable.
 */

const { execFileSync } = require('child_process');
const path = require('path');
const { requireNativeDb: _requireNativeDb } = require('./utils');

function isGitAvailable() {
  try {
    execFileSync('git', ['--version'], { encoding: 'utf8', timeout: 3000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function lookupRepo(db, repoId) {
  return db.prepare('SELECT id, path, name FROM code_repos WHERE id = ?').get(repoId);
}

function getCachedChurn(db, repoId, filePath, days) {
  return db
    .prepare('SELECT * FROM churn_metrics WHERE repo_id = ? AND file_path = ? AND window_days = ?')
    .get(repoId, filePath || '__all__', days);
}

function computeSince(days) {
  return new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
}

function resolveTarget(repoId, target, db) {
  const repo = lookupRepo(db, repoId);
  if (!repo) {
    return { error: `Repo ID ${repoId} not found` };
  }
  if (target && target !== '__all__') {
    // Normalize to absolute path for consistent cache key
    const filePath = path.isAbsolute(target) ? target : path.resolve(repo.path, target);
    return { repo, filePath };
  }
  return { repo, filePath: null };
}

/**
 * Compute or return cached churn metrics for a repo or a single file.
 * @param {object} db native better-sqlite3 handle
 * @param {number} repoId code_repos.id
 * @param {string|null} target file path, or '__all__'/null for repo-wide
 * @param {number} [days=90] lookback window in days
 * @param {boolean} [refresh=false] bypass the churn_metrics cache
 * @returns {object} repo-wide shape { repo, window_days, total_files_changed,
 *                   top_files, ... }, a per-file cached row, or a fresh
 *                   computeRepoChurn/computeFileChurn result; `{ error }` when
 *                   the native DB or repo is unavailable.
 */
// eslint-disable-next-line max-statements -- churn computation inherently requires many steps
function getChurn(db, repoId, target, days, refresh) {
  const guard = _requireNativeDb(db);
  if (guard) {
    return guard;
  }

  const resolved = resolveTarget(repoId, target, db);
  if (resolved.error) {
    return resolved;
  }

  days = days || 90;
  refresh = refresh || false;

  if (!refresh) {
    const cached = getCachedChurn(db, repoId, resolved.filePath, days);
    if (cached) {
      if (!resolved.filePath) {
        let topFiles = [];
        if (cached.top_files_json) {
          try {
            const parsed = JSON.parse(cached.top_files_json);
            if (Array.isArray(parsed)) {
              topFiles = parsed;
            }
          } catch {
            topFiles = [];
          }
        }
        return {
          repo: resolved.repo.name,
          window_days: days,
          total_files_changed: cached.total_files_changed,
          top_files: topFiles,
          commits: cached.commits,
          unique_authors: cached.unique_authors,
          first_seen: cached.first_seen,
          last_modified: cached.last_modified,
          churn_per_week: cached.churn_per_week,
        };
      }
      return cached;
    }
  }

  const since = computeSince(days);
  if (resolved.filePath) {
    return computeFileChurn(db, resolved.repo, resolved.filePath, days, since);
  }
  return computeRepoChurn(db, resolved.repo, days, since);
}

function getFirstSeen(repoPath, filePath) {
  try {
    const fullLog = execFileSync('git', ['-C', repoPath, 'log', '--follow', '--format=%aI', '--', filePath], {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const allDates = fullLog.split('\n').filter(Boolean).sort();
    return allDates.length ? allDates[0] : null;
  } catch {
    return null;
  }
}

function parseCommitLog(log) {
  const lines = log.split('\n');
  const authors = new Set(lines.map((l) => l.split('|')[1]).filter(Boolean));
  const dates = lines
    .map((l) => l.split('|')[2])
    .filter(Boolean)
    .sort();
  return { lines, authors, dates };
}

function buildFileChurnResult(lines, authors, dates, firstSeen, days) {
  return {
    commits: lines.length,
    unique_authors: authors.size,
    first_seen: firstSeen,
    last_modified: dates[dates.length - 1] || null,
    churn_per_week: Math.round((lines.length / (days / 7)) * 100) / 100,
  };
}

// eslint-disable-next-line max-statements -- file churn computation requires many steps
function computeFileChurn(db, repo, filePath, days, since) {
  const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(repo.path, filePath);
  try {
    const log = execFileSync(
      'git',
      ['-C', repo.path, 'log', '--follow', '--format=%H|%an|%aI', `--since=${since}`, '--', filePath],
      { encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();

    if (!log) {
      const result = { commits: 0, unique_authors: 0, churn_per_week: 0, first_seen: null, last_modified: null };
      upsertChurn(db, repo.id, absPath, days, result);
      return result;
    }

    const { lines, authors, dates } = parseCommitLog(log);
    const firstSeen = getFirstSeen(repo.path, filePath) || dates[0];
    const result = buildFileChurnResult(lines, authors, dates, firstSeen, days);
    upsertChurn(db, repo.id, absPath, days, result);
    return result;
  } catch (e) {
    return { error: `git log failed: ${e.message}` };
  }
}

// eslint-disable-next-line max-statements -- repo churn computation requires many steps
function computeRepoChurn(db, repo, days, since) {
  try {
    const log = execFileSync('git', ['-C', repo.path, 'log', `--since=${since}`, '--format=', '--name-only'], {
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const fileCounts = new Map();
    for (const line of log.split('\n')) {
      const f = line.trim();
      if (f) {
        fileCounts.set(f, (fileCounts.get(f) || 0) + 1);
      }
    }

    const topFiles = [...fileCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50)
      .map(([file, commits]) => ({
        file,
        commits,
        churn_per_week: Math.round((commits / (days / 7)) * 100) / 100,
      }));

    const totalCommits = [...fileCounts.values()].reduce((a, b) => a + b, 0);
    const uniqueAuthorsRaw = execFileSync('git', ['-C', repo.path, 'log', `--since=${since}`, '--format=%an'], {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const uniqueAuthors = new Set(uniqueAuthorsRaw.split('\n').filter(Boolean)).size;

    const cacheMetrics = {
      commits: totalCommits,
      unique_authors: uniqueAuthors,
      first_seen: null,
      last_modified: null,
      churn_per_week: Math.round((totalCommits / (days / 7)) * 100) / 100,
      total_files_changed: fileCounts.size,
      top_files_json: JSON.stringify(topFiles),
    };
    const result = {
      repo: repo.name,
      window_days: days,
      total_files_changed: fileCounts.size,
      top_files: topFiles,
      ...cacheMetrics,
    };
    upsertChurn(db, repo.id, '__all__', days, cacheMetrics);
    return result;
  } catch (e) {
    return { error: `git log failed: ${e.message}` };
  }
}

function upsertChurn(db, repoId, filePath, windowDays, metrics) {
  const totalFilesChanged = metrics.total_files_changed ?? 0;
  const topFilesJson = metrics.top_files_json ?? '[]';
  db.prepare(`
    INSERT OR REPLACE INTO churn_metrics (repo_id, file_path, commits, unique_authors, first_seen, last_modified, churn_per_week, window_days, total_files_changed, top_files_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    repoId,
    filePath,
    metrics.commits,
    metrics.unique_authors,
    metrics.first_seen,
    metrics.last_modified,
    metrics.churn_per_week,
    windowDays,
    totalFilesChanged,
    topFilesJson,
  );
}

// ══════════════════════════════════════════════════════════
// SYMBOL PROVENANCE (v6 — Git archaeology for single symbol)
// ══════════════════════════════════════════════════════════

const CLASSIFICATION_RULES = [
  { pattern: /^Initial commit|first commit/i, classification: 'creation' },
  { pattern: /^Add\b|^Implement\b|^Create\b/i, classification: 'feature' },
  { pattern: /\bfix(?:es)?\b|\bbug\b|\bhotfix\b|\bpatch\b/i, classification: 'bugfix' },
  { pattern: /\brefactor\b|\bclean\s*up\b|\breorganize\b/i, classification: 'refactor' },
  { pattern: /\bperf(?:ormance)?\b|\boptimize\b|\bspeed\b/i, classification: 'perf' },
  { pattern: /\brename\b|\bmove\b|\brelocate\b/i, classification: 'rename' },
  { pattern: /\brevert\b|\brollback\b/i, classification: 'revert' },
];

function classifyCommit(message) {
  for (const rule of CLASSIFICATION_RULES) {
    if (rule.pattern.test(message)) {
      return rule.classification;
    }
  }
  return 'unknown';
}

/**
 * Build change provenance for a symbol by shelling out to git (log --follow + blame).
 * Side effects: spawns git subprocesses (each with a 15s timeout).
 * @param {object} db native better-sqlite3 handle
 * @param {number} repoId code_repos.id
 * @param {string} symbolName exact symbol name to look up
 * @returns {object} provenance summary with commits + classification, or `{ error }`
 *                   when the DB/repo/symbol is missing or git fails.
 */
function getProvenance(db, repoId, symbolName) {
  const guard = _requireNativeDb(db);
  if (guard) {
    return guard;
  }

  const symbol = db
    .prepare('SELECT id, name, file_path, start_line, end_line, kind FROM code_symbols WHERE repo_id = ? AND name = ?')
    .get(repoId, symbolName);

  if (!symbol) {
    return { error: `Symbol "${symbolName}" not found in repo ${repoId}` };
  }

  const repo = db.prepare('SELECT path FROM code_repos WHERE id = ?').get(repoId);
  if (!repo) {
    return { error: `Repo ${repoId} not found` };
  }

  let logEntries = [];
  try {
    const logOutput = execFileSync(
      'git',
      ['-C', repo.path, 'log', '--follow', '--format=%H|%an|%aI|%s', '--', symbol.file_path],
      { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();

    if (!logOutput) {
      return { symbol: symbolName, commits: [], total_commits: 0, summary: 'No git history found.' };
    }

    logEntries = logOutput.split('\n').map((line) => {
      const [hash, author, date, ...msgParts] = line.split('|');
      return {
        hash,
        author,
        date,
        message: msgParts.join('|'),
        classification: classifyCommit(msgParts.join('|')),
        touches_symbol: false,
      };
    });
  } catch (e) {
    return { error: `git log failed: ${e.message}` };
  }

  try {
    const blameOutput = execFileSync(
      'git',
      ['-C', repo.path, 'blame', `-L${symbol.start_line},${symbol.end_line}`, '--', symbol.file_path],
      { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
    const blameHashes = new Set();
    const blameRe = /^([a-f0-9]{8,})/gm;
    let match;
    while ((match = blameRe.exec(blameOutput)) !== null) {
      blameHashes.add(match[1]);
    }
    for (const entry of logEntries) {
      if (blameHashes.has(entry.hash.substring(0, 8)) || blameHashes.has(entry.hash)) {
        entry.touches_symbol = true;
      }
    }
  } catch {
    /* Blame failed, keep all */
  }

  const relevantCommits =
    logEntries.length > 50 && logEntries.some((e) => e.touches_symbol)
      ? logEntries.filter((e) => e.touches_symbol).slice(0, 50)
      : logEntries.slice(0, 50);

  const classifications = {};
  let creationDate = null,
    lastModifiedDate = null;
  const authors = new Set();
  for (const c of relevantCommits) {
    classifications[c.classification] = (classifications[c.classification] || 0) + 1;
    if (c.classification === 'creation' && !creationDate) {
      creationDate = c.date;
    }
    authors.add(c.author);
    if (!lastModifiedDate || c.date > lastModifiedDate) {
      lastModifiedDate = c.date;
    }
  }

  let summary = `${symbol.kind} "${symbolName}" in ${symbol.file_path}:${symbol.start_line}-${symbol.end_line}. `;
  summary += `${relevantCommits.length} commits by ${authors.size} author(s). `;
  if (creationDate) {
    summary += `First seen: ${creationDate.split('T')[0]}. `;
  }
  if (lastModifiedDate) {
    summary += `Last modified: ${lastModifiedDate.split('T')[0]}. `;
  }
  const clsSummary = Object.entries(classifications)
    .sort((a, b) => b[1] - a[1])
    .map(([cls, count]) => `${cls}(${count})`)
    .join(', ');
  summary += `Activity: ${clsSummary || 'unknown'}.`;

  return {
    symbol: symbolName,
    file: symbol.file_path,
    kind: symbol.kind,
    lines: `${symbol.start_line}-${symbol.end_line}`,
    commits: relevantCommits,
    total_commits: logEntries.length,
    authors: [...authors],
    creation_date: creationDate,
    last_modified: lastModifiedDate,
    classification_summary: classifications,
    summary,
  };
}

module.exports = { getChurn, isGitAvailable, getProvenance, classifyCommit };
