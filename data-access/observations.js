function insertObservation(deps, { sessionId, type, title, content, project, scope, topicKey, expiresAt }) {
  const { sqlJson } = deps;
  return sqlJson(
    `INSERT INTO observations (session_id, type, title, content, project, scope, topic_key, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, created_at, expires_at`,
    [String(sessionId), type, title, content, project, scope, topicKey, expiresAt || null],
  );
}

function insertObservationRelation(deps, { sourceId, targetId, relation, confidence }) {
  const { sqlRun } = deps;
  sqlRun(
    'INSERT OR IGNORE INTO observation_relations (source_id, target_id, relation, confidence) VALUES (?, ?, ?, ?)',
    [sourceId, targetId, relation, confidence],
  );
}

function softDeleteObservation(deps, id) {
  const { sqlRun } = deps;
  sqlRun("UPDATE observations SET deleted_at = datetime('now') WHERE id = ?", [parseInt(id, 10)]);
  try {
    sqlRun(
      "INSERT INTO observations_fts(observations_fts, rowid, title, content, type, project, topic_key) VALUES ('delete', ?, '', '', '', '', '')",
      [parseInt(id, 10)],
    );
  } catch {}
}

function hardDeleteObservation(deps, id) {
  const { sqlRun } = deps;
  sqlRun('DELETE FROM observations WHERE id = ?', [parseInt(id, 10)]);
}

function getObservation(deps, id) {
  const { sqlJson } = deps;
  return sqlJson(
    `SELECT id, title, content, type, project, scope, topic_key, expires_at, created_at, updated_at, deleted_at
     FROM observations WHERE id = ?`,
    [parseInt(id, 10)],
  );
}

function getSymbolLinksForMemory(deps, memoryId) {
  const { sqlJson } = deps;
  return sqlJson('SELECT symbol_id, repo, trust_score FROM symbol_links WHERE memory_id = ?', [String(memoryId)]);
}

function getRecallCountForMemory(deps, memoryId) {
  const { sqlJson } = deps;
  return sqlJson('SELECT COUNT(*) as cnt FROM recall_log WHERE memory_id = ?', [parseInt(memoryId, 10)]);
}

function getObservationVersions(deps, id) {
  const { sqlJson } = deps;
  return sqlJson(
    'SELECT field, old_value, new_value, created_at FROM observation_versions WHERE memory_id = ? ORDER BY created_at DESC',
    [parseInt(id, 10)],
  );
}

function getObservationRelations(deps, id) {
  const { sqlJson } = deps;
  return sqlJson(
    `SELECT source_id, target_id, relation, confidence
     FROM observation_relations
     WHERE source_id = ? OR target_id = ?`,
    [parseInt(id, 10), parseInt(id, 10)],
  );
}

/**
 * Partially update an observation, recording changed fields to
 * `observation_versions`. Resolves `topicKey` and expiry (set via `expiresAt`
 * or clear via `clearExpiry`).
 * @returns {Array|null} the updated rows, or `null` if the id is missing.
 */
function updateObservation(deps, { id, title, content, type, project, scope, topicKey, expiresAt, clearExpiry }) {
  const { sqlJson, sqlRun } = deps,
    parsedId = parseInt(id, 10),
    current = sqlJson('SELECT title, content, type, scope, expires_at FROM observations WHERE id = ?', [parsedId]),
  before = !(!current || current.length === 0) ? (current[0]) : undefined,
  fields = !(!current || current.length === 0) ? ({ title, content, type, scope }) : undefined,
  versionEntries = !(!current || current.length === 0) ? ([]) : undefined;
  if (!current || current.length === 0) {
    return null;
  }

  for (const [field, newVal] of Object.entries(fields)) {
    if (newVal !== undefined && newVal !== null && String(newVal) !== String(before[field] || '')) {
      versionEntries.push([parsedId, field, String(before[field] || ''), String(newVal)]);
    }
  }
  // Resolve the post-update expires_at value up-front so both the version
  // History row and the actual UPDATE agree on what the new value is.
  // Observation_versions.new_value is NOT NULL, so we stringify null as ''
  // (matching the convention used by other fields in this table).
  const nextExpiresAt = clearExpiry === true ? null : expiresAt !== undefined ? expiresAt || null : undefined;
  if (nextExpiresAt !== undefined && String(nextExpiresAt || '') !== String(before.expires_at || '')) {
    versionEntries.push([
      parsedId,
      'expires_at',
      String(before.expires_at || ''),
      nextExpiresAt === null ? '' : String(nextExpiresAt),
    ]);
  }

  const setFields = [
      { name: 'title', value: title },
      { name: 'content', value: content },
      { name: 'type', value: type },
      { name: 'project', value: project },
      { name: 'scope', value: scope },
      { name: 'topic_key', value: topicKey },
    ],
    sets = [],
    params = [];
  for (const f of setFields) {
    if (f.value !== undefined && f.value !== null) {
      sets.push(`${f.name} = ?`);
      params.push(f.value);
    }
  }
  if (nextExpiresAt !== undefined) {
    sets.push('expires_at = ?');
    params.push(nextExpiresAt);
  }
  if (sets.length === 0) {
    return null;
  }
  params.push(parsedId);
  sqlRun(`UPDATE observations SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`, params);
  for (const entry of versionEntries) {
    sqlRun('INSERT INTO observation_versions (memory_id, field, old_value, new_value) VALUES (?, ?, ?, ?)', entry);
  }
  return sqlJson(
    `SELECT id, title, content, type, project, scope, topic_key, expires_at, created_at, updated_at
     FROM observations WHERE id = ?`,
    [parsedId],
  );
}

/**
 * Neighbors of an observation by **id window** `[id-before, id+after]`
 * (not a time-based window), excluding soft-deleted and expired rows.
 * Ordered by id.
 */
function getTimeline(deps, { id, before, after }) {
  const { sqlJson } = deps;
  return sqlJson(
    `SELECT id, title, type, project, scope, expires_at, created_at
     FROM observations
     WHERE id BETWEEN ? AND ? AND deleted_at IS NULL
       AND (expires_at IS NULL OR expires_at > datetime('now'))
     ORDER BY id`,
    [id - before, id + after],
  );
}

function insertUserPrompt(deps, { sessionId, content, project }) {
  const { sqlJson } = deps;
  return sqlJson(`INSERT INTO user_prompts (session_id, content, project) VALUES (?, ?, ?) RETURNING id, created_at`, [
    String(sessionId),
    content,
    project,
  ]);
}

function insertCapturePassiveObservation(deps, { sessionId, summary, content }) {
  const { sqlJson } = deps;
  return sqlJson('INSERT INTO observations (session_id, type, title, content, scope) VALUES (?, ?, ?, ?, ?)', [
    String(sessionId),
    'learning',
    summary,
    content,
    'project',
  ]);
}

function getObservationStats(deps) {
  const { sqlJson } = deps,
    obs = sqlJson('SELECT COUNT(*) as cnt FROM observations WHERE deleted_at IS NULL')[0].cnt,
    prompts = sqlJson('SELECT COUNT(*) as cnt FROM user_prompts')[0].cnt,
    sessions = sqlJson('SELECT COUNT(*) as cnt FROM session_log')[0].cnt,
    links = sqlJson('SELECT COUNT(*) as cnt FROM symbol_links')[0].cnt;
  return {
    total_observations: obs,
    total_prompts: prompts,
    total_sessions: sessions,
    total_symbol_links: links,
  };
}

function countObservationsByProjectAndType(deps, project) {
  const { sqlJson } = deps;
  if (project) {
    return sqlJson('SELECT COUNT(*) as cnt FROM observations WHERE project = ? AND deleted_at IS NULL AND type != ?', [
      project,
      'skill',
    ])[0].cnt;
  }
  return sqlJson('SELECT COUNT(*) as cnt FROM observations WHERE deleted_at IS NULL AND type != ?', ['skill'])[0].cnt;
}

function insertRecallLog(deps, entries) {
  const { sqlRun } = deps,
    placeholders = entries.map(() => '(?, ?, ?, ?)').join(','),
    params = entries.flatMap((r) => [r.memoryId, r.sessionId, r.query, r.wasUseful === false ? 0 : 1]);
  sqlRun(`INSERT OR IGNORE INTO recall_log (memory_id, session_id, query, was_useful) VALUES ${placeholders}`, params);
}

module.exports = {
  insertObservation,
  insertObservationRelation,
  softDeleteObservation,
  hardDeleteObservation,
  getObservation,
  getSymbolLinksForMemory,
  getRecallCountForMemory,
  getObservationVersions,
  getObservationRelations,
  updateObservation,
  getTimeline,
  insertUserPrompt,
  insertCapturePassiveObservation,
  getObservationStats,
  countObservationsByProjectAndType,
  insertRecallLog,
};
