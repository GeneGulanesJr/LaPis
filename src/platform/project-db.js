'use strict';

/**
 * Shared sync reads for project-detection (indexed code repos + memory projects).
 *
 * Used by the Claude Code bridge, MCP server, and dispatch-client so transport
 * layers do not depend on each other for DB access. In-process TTL cache mirrors
 * Pi's REPO_CACHE_TTL (5 min) to avoid duplicate queries within one hook/MCP
 * process lifetime.
 *
 * Claude Code spawns a fresh Node process per hook event, so the in-process
 * cache is always cold there and every hook paid a full SQLite open just to
 * learn the known repos/projects. A tiny JSON snapshot written next to the
 * memory DB after each successful DB read adds an outer cross-process layer:
 * a fresh hook serves the lists from the file and never requires db.js at
 * all. Staleness is bounded by the snapshot TTL (default CACHE_TTL_MS,
 * matching the in-process cache tradeoff — a newly indexed repo becomes
 * visible to hooks within ≤ TTL).
 */

const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  CACHE_TTL_MS = 5 * 60 * 1000,
  SNAPSHOT_NAME = 'repos-snapshot.json';

let _reposCache = null,
  _reposCacheTime = 0,
  _projectsCache = null,
  _projectsCacheTime = 0;

// TTL for the cross-process snapshot. 0 disables the snapshot layer entirely
// (read AND write) — used by tests and troubleshooting.
function snapshotTtlMs() {
  const raw = Number(process.env.LAPIS_REPO_SNAPSHOT_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : CACHE_TTL_MS;
}

// Next to the memory DB, derived the same way config.js derives db_path.
// Falls back to the same HOME logic if the config module can't be loaded.
function snapshotFile() {
  try {
    const { getConfig } = require('../../config');
    return path.join(path.dirname(getConfig().db_path), SNAPSHOT_NAME);
  } catch {
    const home = process.env.LAPIS_HOME || process.env.HOME || process.env.USERPROFILE || os.homedir();
    return path.join(home, '.pi', 'memory', SNAPSHOT_NAME);
  }
}

// Cheap identity of the DB FILE (size + mtimeMs) so a snapshot written for
// One memory.db is never served after that file was replaced underneath it
// (recreated temp DB, restored backup). A stat — never a DB open — so the
// primed hook path stays DB-free. null when the file can't be statted.
function dbFileIdentity() {
  try {
    const { getConfig } = require('../../config'),
      st = fs.statSync(getConfig().db_path);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

// Missing / corrupt / expired / disabled snapshot → null (never fail the caller).
function readFreshSnapshot(now) {
  if (snapshotTtlMs() === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(snapshotFile(), 'utf8'));
    if (!parsed || typeof parsed.written_at !== 'number') {
      return null;
    }
    if (now - parsed.written_at >= snapshotTtlMs()) {
      return null;
    }
    // Identity check only when BOTH sides are known: a legacy/hand-made
    // Snapshot without it, or a currently-unstattable DB file, keeps the old
    // TTL-only behavior instead of invalidating on unverifiable state.
    if (parsed.db_identity) {
      const cur = dbFileIdentity();
      if (cur && (cur.size !== parsed.db_identity.size || cur.mtimeMs !== parsed.db_identity.mtimeMs)) {
        return null; // DB file changed underneath the snapshot
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

// Serve `field` from a fresh snapshot when present. Returns undefined when the
// Snapshot can't answer so the caller falls through to the DB.
function fromSnapshot(field, now) {
  const snap = readFreshSnapshot(now);
  if (snap && Array.isArray(snap[field])) {
    return snap[field];
  }
  return undefined;
}

/**
 * Atomically persist the freshly-read lists so fresh hook processes can skip
 * the DB open entirely. Best-effort: never throws, never blocks the caller
 * (a ~1KB tmp file + rename).
 */
function writeSnapshot() {
  if (snapshotTtlMs() === 0) {
    return; // Layer disabled (tests / troubleshooting): no snapshot IO at all
  }
  let tmp = null;
  try {
    const now = Date.now(),
      // Only lists this process actually read fresh go into the snapshot;
      // Absent fields stay null and readers fall back to the DB for them.
      payload = {
        written_at: now,
        db_identity: dbFileIdentity(),
        repos: _reposCache && now - _reposCacheTime < CACHE_TTL_MS ? _reposCache : null,
        projects: _projectsCache && now - _projectsCacheTime < CACHE_TTL_MS ? _projectsCache : null,
      },
      file = snapshotFile();
    tmp = `${file}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    if (tmp) {
      try {
        fs.unlinkSync(tmp);
      } catch {}
    }
  }
}

function clearProjectDbCache() {
  _reposCache = null;
  _reposCacheTime = 0;
  _projectsCache = null;
  _projectsCacheTime = 0;
  // Invalidate the cross-process layer too, so the next read in ANY process
  // Goes back to the DB. No-op when the snapshot layer is disabled.
  if (snapshotTtlMs() > 0) {
    try {
      fs.unlinkSync(snapshotFile());
    } catch {}
  }
}

function loadKnownRepos() {
  const { sqlJson } = require('../../db');
  return sqlJson('SELECT name, path, indexed_at FROM code_repos') || [];
}

function loadKnownProjects() {
  const { sqlJson } = require('../../db'),
    rows =
      sqlJson(`
      SELECT project
      FROM observations
      WHERE deleted_at IS NULL AND type != 'skill'
        AND project IS NOT NULL AND project != ''
      GROUP BY project
    `) || [];
  return rows.map((r) => r.project).filter(Boolean);
}

// Warm the sibling list within the same DB open so a single successful read
// Produces a complete snapshot. Sibling failure is non-fatal and never
// Changes the calling getter's own return value.
function warmProjectsSibling() {
  const now = Date.now();
  if (_projectsCache && now - _projectsCacheTime < CACHE_TTL_MS) {
    return;
  }
  try {
    _projectsCache = loadKnownProjects();
    _projectsCacheTime = now;
  } catch {}
}

function warmReposSibling() {
  const now = Date.now();
  if (_reposCache && now - _reposCacheTime < CACHE_TTL_MS) {
    return;
  }
  try {
    _reposCache = loadKnownRepos();
    _reposCacheTime = now;
  } catch {}
}

/**
 * Known indexed code repos. Best-effort; returns [] when the DB is unavailable.
 */
function getKnownRepos() {
  const now = Date.now(),
    cached = _reposCache && now - _reposCacheTime < CACHE_TTL_MS,
    // Consulted only on an in-process miss so a warm cache never pays file IO.
    snap = cached ? undefined : fromSnapshot('repos', now);
  if (cached) {
    return _reposCache;
  }
  if (snap) {
    _reposCache = snap;
    _reposCacheTime = now;
    return _reposCache;
  }
  try {
    _reposCache = loadKnownRepos();
    _reposCacheTime = now;
    warmProjectsSibling();
    writeSnapshot();
    return _reposCache;
  } catch {
    return _reposCache || [];
  }
}

/**
 * Known memory project names (list-projects parity). Best-effort.
 */
function getKnownProjects() {
  const now = Date.now(),
    cached = _projectsCache && now - _projectsCacheTime < CACHE_TTL_MS,
    // Consulted only on an in-process miss so a warm cache never pays file IO.
    snap = cached ? undefined : fromSnapshot('projects', now);
  if (cached) {
    return _projectsCache;
  }
  if (snap) {
    _projectsCache = snap;
    _projectsCacheTime = now;
    return _projectsCache;
  }
  try {
    _projectsCache = loadKnownProjects();
    _projectsCacheTime = now;
    warmReposSibling();
    writeSnapshot();
    return _projectsCache;
  } catch {
    return _projectsCache || [];
  }
}

module.exports = {
  getKnownRepos,
  getKnownProjects,
  clearProjectDbCache,
  CACHE_TTL_MS,
};
