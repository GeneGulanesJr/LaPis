function listWorkspaces(deps) {
  const { sqlJson } = deps,
    // Sort un-archived workspaces first, then most-recently-active first.
    // `w.archived_at IS NULL` evaluates to 0/1; sorting it DESC puts NULLs
    // (un-archived) before non-NULL (archived) without relying on the
    // SQLite-3.30+ `NULLS FIRST` clause — works on any SQLite engine.
    workspaces = sqlJson(`
    SELECT w.id, w.name, w.created_at, w.archived_at,
           COUNT(CASE WHEN o.deleted_at IS NULL AND o.type != 'skill' THEN 1 END) as memory_count,
           MAX(o.created_at) as last_active
    FROM workspaces w
    LEFT JOIN observations o ON o.project = w.name
    GROUP BY w.id
    ORDER BY (w.archived_at IS NULL) DESC, w.archived_at ASC, last_active DESC
  `);
  return { workspaces, total: workspaces.length };
}

function createWorkspace(deps, name) {
  const { sqlJson, sqlRun } = deps;
  if (!name) {
    return { error: 'Missing --name' };
  }
  try {
    sqlRun('INSERT INTO workspaces (name) VALUES (?)', [name]);
    const row = sqlJson('SELECT id, name, created_at FROM workspaces WHERE name = ?', [name]);
    return { success: true, workspace: row[0] };
  } catch {
    return { error: `Workspace already exists: ${name}` };
  }
}

function archiveWorkspace(deps, name) {
  const { sqlJson, sqlRun } = deps;
  if (!name) {
    return { error: 'Missing --name' };
  }
  {
    const existing = sqlJson('SELECT id FROM workspaces WHERE name = ? AND archived_at IS NULL', [name]);
    if (existing.length === 0) {
      return { error: `Workspace not found or already archived: ${name}` };
    }
    sqlRun("UPDATE workspaces SET archived_at = datetime('now') WHERE id = ?", [existing[0].id]);
    return { success: true, workspace: name, archived: true };
  }
}

function listProjects(deps) {
  const { sqlJson } = deps,
    rows = sqlJson(`
    SELECT project, COUNT(*) as memory_count,
           MAX(created_at) as last_active
    FROM observations
    WHERE deleted_at IS NULL AND type != 'skill'
    GROUP BY project
    ORDER BY last_active DESC
  `);
  return { projects: rows };
}

module.exports = {
  listWorkspaces,
  createWorkspace,
  archiveWorkspace,
  listProjects,
};
