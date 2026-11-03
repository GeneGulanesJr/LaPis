const { TRUST_DELTA } = require('../constants');

/**
 * Upsert a symbol link for a memory (`symbolId` defaults to `'__unlinked__'`).
 * @returns {{ ok:boolean, memoryId, symbolId, repo, trustScore }}
 */
function linkSymbol(deps, { memoryId, symbolId, repo, trust, symbolPath }) {
  const { sqlRun } = deps,
    symVal = symbolId || '__unlinked__';
  // symbolPath records WHERE the symbol lives so trust sync can match
  // changes on (path, name) — bare-name matching penalized same-named
  // symbols in unrelated files (#300).
  sqlRun(
    'INSERT OR REPLACE INTO symbol_links (memory_id, symbol_id, repo, trust_score, symbol_path) VALUES (?, ?, ?, ?, ?)',
    [memoryId, symVal, repo, trust, symbolPath || null],
  );
  return { ok: true, memoryId, symbolId: symVal, repo, trustScore: trust, symbolPath: symbolPath || null };
}

/**
 * Remove '__unlinked__' placeholder rows for a project (#301): they anchored
 * nothing and permanently excluded those memories from future linking.
 */
function deletePlaceholderLinks(deps, project) {
  const { sqlRun } = deps;
  sqlRun("DELETE FROM symbol_links WHERE symbol_id = '__unlinked__' AND repo = ?", [project]);
}

function findUnlinked(deps, project) {
  const { sqlJson } = deps;
  return sqlJson(
    `SELECT CAST(id AS TEXT) as memory_id FROM observations
     WHERE project = ? AND deleted_at IS NULL
       AND CAST(id AS TEXT) NOT IN (SELECT memory_id FROM symbol_links)`,
    [project],
  );
}

// Repo-relative file paths (need a slash and an extension) and code-looking names
// (camelCase, snake_case or `backticked`) mentioned in a memory.
const LINK_PATH_RE = /[\w.-]*[/\\][\w./\\-]*\.\w{1,6}\b/g,
  LINK_NAME_RE = /`([A-Za-z_$][\w$]{3,})`|\b([A-Za-z_$][\w$]*(?:[a-z0-9][A-Z]|_)[\w$]*)\b/g,
  LINK_MAX_PER_MEMORY = 10;

function linkCandidates(text) {
  const paths = new Set(),
    names = new Set();
  for (const m of text.matchAll(LINK_PATH_RE)) {
    paths.add(m[0].replace(/\\/g, '/').replace(/^(?:\.\/)+/, ''));
  }
  for (const m of text.matchAll(LINK_NAME_RE)) {
    const name = m[1] || m[2];
    if (name.length >= 4) {
      names.add(name);
    }
  }
  return { paths: [...paths], names: [...names] };
}

/**
 * Link this repo's unlinked project memories to the indexed files and symbols
 * they mention, at full trust, so trust sync can lower them when that code changes.
 * Memories that name nothing in the index stay unlinked and are retried next time.
 * @returns {{ total:number, linked:number, links:number }}
 */
function autoLinkMemories(deps, repo) {
  const { sqlJson } = deps,
    repoRow = sqlJson('SELECT id, name, path FROM code_repos WHERE name = ? COLLATE NOCASE', [repo])[0];
  if (!repoRow) {
    return { total: 0, linked: 0, links: 0 };
  }
  const memories = sqlJson(
    `SELECT CAST(id AS TEXT) as memory_id, title, content FROM observations
     WHERE project = ? COLLATE NOCASE AND deleted_at IS NULL
       AND CAST(id AS TEXT) NOT IN (SELECT memory_id FROM symbol_links)`,
    [repo],
  );
  if (memories.length === 0) {
    return { total: 0, linked: 0, links: 0 };
  }

  const candidates = memories.map((m) => linkCandidates(`${m.title || ''}\n${m.content || ''}`)),
    // basename -> [{ rel, abs }], so a path mention is matched without scanning every file.
    filesByBase = new Map();
  for (const { path: abs } of sqlJson('SELECT path FROM code_files WHERE repo_id = ?', [repoRow.id])) {
    const rel = abs.slice(repoRow.path.length).replace(/\\/g, '/').replace(/^\/+/, ''),
      base = rel.slice(rel.lastIndexOf('/') + 1);
    filesByBase.set(base, [...(filesByBase.get(base) || []), { rel, abs }]);
  }
  const allNames = [...new Set(candidates.flatMap((c) => c.names))],
    filesByName = new Map();
  for (let i = 0; i < allNames.length; i += 500) {
    const chunk = allNames.slice(i, i + 500);
    for (const row of sqlJson(
      `SELECT DISTINCT name, file_path FROM code_symbols WHERE repo_id = ? AND name IN (${chunk.map(() => '?').join(',')})`,
      [repoRow.id, ...chunk],
    )) {
      filesByName.set(row.name, [...(filesByName.get(row.name) || []), row.file_path]);
    }
  }

  let linked = 0,
    links = 0;
  memories.forEach((memory, i) => {
    const targets = new Map(); // symbolId -> symbolPath
    for (const p of candidates[i].paths) {
      for (const f of filesByBase.get(p.slice(p.lastIndexOf('/') + 1)) || []) {
        if (f.rel === p || f.rel.endsWith(`/${p}`)) {
          targets.set(f.rel, f.abs);
        }
      }
    }
    for (const name of candidates[i].names) {
      const files = filesByName.get(name) || [];
      // A name defined in several files is ambiguous; it cannot anchor a memory.
      if (files.length === 1) {
        targets.set(name, files[0]);
      }
    }
    const chosen = [...targets].slice(0, LINK_MAX_PER_MEMORY);
    for (const [symbolId, symbolPath] of chosen) {
      linkSymbol(deps, { memoryId: memory.memory_id, symbolId, repo: repoRow.name, trust: 1, symbolPath });
    }
    linked += chosen.length > 0 ? 1 : 0;
    links += chosen.length;
  });
  return { total: memories.length, linked, links };
}

function insertSymbolLink(deps, { memoryId, symbolId, repo, trustScore }) {
  const { sqlRun } = deps;
  sqlRun('INSERT OR IGNORE INTO symbol_links (memory_id, symbol_id, repo, trust_score) VALUES (?, ?, ?, ?)', [
    memoryId,
    symbolId,
    repo,
    trustScore,
  ]);
}

/**
 * Adjust a symbol link's trust by `delta` (clamped to [0,1]) and log the
 * adjustment to `trust_adjustments`.
 * @returns {number|null} the new `trust_score`, or `null` if no link exists.
 */
function adjustTrust(deps, { memoryId, delta, reason }) {
  const { sqlRun, sqlJson } = deps,
    updated = (() => {
      sqlRun('UPDATE symbol_links SET trust_score = MIN(1.0, MAX(0.0, trust_score + ?)) WHERE memory_id = ?', [
        delta,
        memoryId,
      ]);
      sqlRun('INSERT INTO trust_adjustments (memory_id, reason, delta) VALUES (?, ?, ?)', [memoryId, reason, delta]);

      return sqlJson('SELECT trust_score FROM symbol_links WHERE memory_id = ? LIMIT 1', [memoryId]);
    })();
  return updated.length > 0 ? updated[0].trust_score : null;
}

function recordRecall(deps, { sessionId, memoryId }) {
  const { sqlRun } = deps;
  sqlRun('INSERT OR IGNORE INTO session_recalls (session_id, memory_id) VALUES (?, ?)', [sessionId, memoryId]);
}

function getStaleLinks(deps, repo) {
  const { sqlJson } = deps;
  return sqlJson(
    `SELECT memory_id, symbol_id, repo, trust_score, last_verified
     FROM symbol_links
     WHERE repo = ? AND symbol_id != '__unlinked__'
     ORDER BY trust_score ASC`,
    [repo],
  );
}

function getAnchoredLinks(deps, repo) {
  const { sqlJson } = deps;
  return sqlJson(
    `SELECT memory_id, symbol_id, trust_score, last_verified, symbol_path
     FROM symbol_links WHERE repo = ? AND symbol_id != '__unlinked__'`,
    [repo],
  );
}

function updateLinkTrust(deps, { memoryId, symbolId, newTrust, _timestamp }) {
  const { sqlRun } = deps;
  sqlRun(
    "UPDATE symbol_links SET trust_score = ?, last_verified = datetime('now') WHERE memory_id = ? AND symbol_id = ?",
    [newTrust, memoryId, symbolId],
  );
}

function insertTrustAdjustment(deps, { memoryId, reason, delta }) {
  const { sqlRun } = deps;
  sqlRun('INSERT INTO trust_adjustments (memory_id, reason, delta) VALUES (?, ?, ?)', [memoryId, reason, delta]);
}

function getRecalledMemoryIds(deps, sessionId) {
  const { sqlJson } = deps;
  return sqlJson(
    `SELECT DISTINCT memory_id FROM (
       SELECT memory_id FROM recall_log WHERE session_id = ? AND was_useful = 1
       UNION
       SELECT memory_id FROM session_recalls WHERE session_id = ?
     )`,
    [sessionId, sessionId],
  );
}

function updateLinkTrustByMemoryId(deps, { memoryId, newTrust }) {
  const { sqlRun } = deps;
  sqlRun(
    `UPDATE symbol_links SET trust_score = MIN(${TRUST_DELTA.TRUST_CEILING}, trust_score + ?) WHERE memory_id = ?`,
    [newTrust, memoryId],
  );
}

function getSymbolsForMemory(deps, memoryId) {
  const { sqlJson } = deps;
  return sqlJson('SELECT symbol_id, repo FROM symbol_links WHERE memory_id = ? AND symbol_id != ?', [
    String(memoryId),
    '__unlinked__',
  ]);
}

function getSymbolCluster(deps, { symbolId, repo }) {
  const { sqlJson } = deps,
    params = [symbolId];
  let q = `
    SELECT o.id, o.title, o.type, o.project, o.scope, o.topic_key, o.created_at,
           sl.trust_score
    FROM observations o
    JOIN symbol_links sl ON sl.memory_id = CAST(o.id AS TEXT)
    WHERE sl.symbol_id = ?
      AND o.deleted_at IS NULL
  `;

  if (repo) {
    q += ' AND sl.repo = ?';
    params.push(repo);
  }
  q += ' ORDER BY o.created_at DESC';
  return sqlJson(q, params);
}

function getRelatedMemories(deps, { memoryId, symbolIds, _limit }) {
  const { sqlJson } = deps,
    placeholders = symbolIds.map(() => '?').join(',');
  return sqlJson(
    `SELECT sl.symbol_id, o.id, o.title, o.type, o.project, o.created_at
     FROM observations o
     JOIN symbol_links sl ON sl.memory_id = CAST(o.id AS TEXT)
     WHERE sl.symbol_id IN (${placeholders})
       AND o.id != ?
       AND o.deleted_at IS NULL
     ORDER BY o.created_at DESC`,
    [...symbolIds, memoryId],
  );
}

module.exports = {
  autoLinkMemories,
  linkCandidates,
  deletePlaceholderLinks,
  linkSymbol,
  findUnlinked,
  insertSymbolLink,
  adjustTrust,
  recordRecall,
  getStaleLinks,
  getAnchoredLinks,
  updateLinkTrust,
  insertTrustAdjustment,
  getRecalledMemoryIds,
  updateLinkTrustByMemoryId,
  getSymbolsForMemory,
  getSymbolCluster,
  getRelatedMemories,
};
