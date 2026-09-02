/**
 * Relation builder — extracts extends, implements, reexport, and reference edges
 * from existing indexed data (code_symbols, code_imports, scope_resolution).
 */
const { _requireNativeDb } = require('./shared-deps');

/**
 * Extract extends edges from class signatures.
 * Language-aware: JS/TS uses `extends`, Python uses `(Base)`.
 */
function buildExtendsEdges(db, repoId) {
  const guard = _requireNativeDb(db);
  if (guard) {
    return guard;
  }

  db.prepare("DELETE FROM code_relations WHERE repo_id = ? AND kind = 'extends'").run(repoId);

  const classes = db
      .prepare(
        "SELECT id, name, signature, file_id, file_path, language FROM code_symbols WHERE repo_id = ? AND kind = 'class'",
      )
      .all(repoId),
    insertStmt = db.prepare(
      `INSERT OR IGNORE INTO code_relations (repo_id, source_symbol_id, target_symbol_id, source_file_id, target_file_id, kind, weight)
     VALUES (?, ?, ?, ?, ?, 'extends', 1.0)`,
    );

  let count = 0;
  for (const cls of classes) {
    const baseName = extractExtendsName(cls.signature, cls.language);
    if (baseName) {
      const target = db
        .prepare(
          "SELECT id, file_id FROM code_symbols WHERE repo_id = ? AND name = ? AND kind IN ('class', 'interface')",
        )
        .get(repoId, baseName);

      if (target) {
        insertStmt.run(repoId, cls.id, target.id, cls.file_id, target.file_id);
        count++;
      }
    }
  }

  return { success: true, count };
}

/**
 * Extract implements edges from TS class signatures.
 * JS/TS only — Python and other languages don't have `implements`.
 */
function buildImplementsEdges(db, repoId) {
  const guard = _requireNativeDb(db);
  if (guard) {
    return guard;
  }

  db.prepare("DELETE FROM code_relations WHERE repo_id = ? AND kind = 'implements'").run(repoId);

  const classes = db
      .prepare(
        `SELECT id, name, signature, file_id, file_path, language FROM code_symbols
     WHERE repo_id = ? AND kind = 'class' AND language IN ('javascript', 'typescript')`,
      )
      .all(repoId),
    insertStmt = db.prepare(
      `INSERT OR IGNORE INTO code_relations (repo_id, source_symbol_id, target_symbol_id, source_file_id, target_file_id, kind, weight)
     VALUES (?, ?, ?, ?, ?, 'implements', 1.0)`,
    );

  let count = 0;
  for (const cls of classes) {
    const ifaceNames = extractImplementsNames(cls.signature);
    if (ifaceNames.length > 0) {
      for (const ifaceName of ifaceNames) {
        const target = db
          .prepare("SELECT id, file_id FROM code_symbols WHERE repo_id = ? AND name = ? AND kind = 'interface'")
          .get(repoId, ifaceName.trim());

        if (target) {
          insertStmt.run(repoId, cls.id, target.id, cls.file_id, target.file_id);
          count++;
        }
      }
    }
  }

  return { success: true, count };
}

/**
 * Extract re-export edges from code_imports where import_type = 're-export'.
 * Direct edges get weight 1.0. Transitive chains up to depth 3 get 0.7^depth.
 */
function buildReexportEdges(db, repoId) {
  const guard = _requireNativeDb(db);
  if (guard) {
    return guard;
  }

  db.prepare("DELETE FROM code_relations WHERE repo_id = ? AND kind = 'reexport'").run(repoId);

  const reexports = db
      .prepare(
        `SELECT source_file_id, target_file_id FROM code_imports
     WHERE repo_id = ? AND import_type = 're-export' AND target_file_id IS NOT NULL`,
      )
      .all(repoId),
    insertStmt = db.prepare(
      `INSERT OR IGNORE INTO code_relations (repo_id, source_file_id, target_file_id, kind, weight)
     VALUES (?, ?, ?, 'reexport', ?)`,
    );

  let count = 0;

  for (const row of reexports) {
    insertStmt.run(repoId, row.source_file_id, row.target_file_id, 1.0);
    count++;
  }

  const fileById = new Map();
  for (const row of reexports) {
    const targets = fileById.get(row.source_file_id) || [];
    targets.push(row.target_file_id);
    fileById.set(row.source_file_id, targets);
  }

  for (const [sourceId] of fileById) {
    const visited = new Set([sourceId]),
      queue = [{ fileId: sourceId, depth: 0 }];

    while (queue.length > 0) {
      const { fileId, depth } = queue.shift();
      if (depth < 3) {
        const targets = fileById.get(fileId) || [];
        for (const targetId of targets) {
          if (!visited.has(targetId)) {
            visited.add(targetId);

            const transitiveWeight = 0.7 ** (depth + 1);
            if (transitiveWeight >= 0.1) {
              const existing = db
                .prepare(
                  `SELECT id FROM code_relations WHERE repo_id = ? AND source_file_id = ? AND target_file_id = ? AND kind = 'reexport' AND weight = 1.0`,
                )
                .get(repoId, sourceId, targetId);

              if (!existing) {
                insertStmt.run(repoId, sourceId, targetId, transitiveWeight);
                count++;
              }

              queue.push({ fileId: targetId, depth: depth + 1 });
            }
          }
        }
      }
    }
  }

  return { success: true, count };
}

/**
 * Extract reference edges from scope_resolution.
 * Only for non-function/method resolved symbols (functions are in code_calls).
 */
function buildReferenceEdges(db, repoId) {
  const guard = _requireNativeDb(db);
  if (guard) {
    return guard;
  }

  db.prepare("DELETE FROM code_relations WHERE repo_id = ? AND kind = 'references'").run(repoId);

  const resolved = db
      .prepare(`
    SELECT sr.binding_id, sr.resolved_symbol_id, sr.resolved_file_id,
           fsb.file_id AS source_file_id, fsb.name AS binding_name,
           cs.name AS target_name, cs.kind AS target_kind, cs.file_id AS target_file_id
    FROM scope_resolution sr
    JOIN file_scope_bindings fsb ON fsb.id = sr.binding_id
    JOIN code_symbols cs ON cs.id = sr.resolved_symbol_id
    WHERE fsb.repo_id = ? AND sr.status = 'resolved'
      AND cs.kind NOT IN ('function', 'method')
      AND sr.resolved_symbol_id IS NOT NULL
  `)
      .all(repoId),
    insertStmt = db.prepare(
      `INSERT OR IGNORE INTO code_relations (repo_id, source_symbol_id, target_symbol_id, source_file_id, target_file_id, kind, weight)
     VALUES (?, NULL, ?, ?, ?, 'references', 0.8)`,
    );

  let count = 0;
  const seen = new Set();

  for (const row of resolved) {
    const key = `${row.source_file_id}:${row.resolved_symbol_id}`;
    if (!seen.has(key)) {
      seen.add(key);
      insertStmt.run(repoId, row.resolved_symbol_id, row.source_file_id, row.target_file_id);
      count++;
    }
  }

  return { success: true, count };
}

/**
 * Extract the base class name from a class signature, language-aware.
 */
function extractExtendsName(signature, language) {
  if (!signature) {
    return null;
  }

  if (language === 'javascript' || language === 'typescript') {
    const m = signature.match(/extends\s+(\w+)/);
    return m ? m[1] : null;
  }

  if (language === 'python') {
    const m = signature.match(/class\s+\w+\((\w+)\)/);
    return m ? m[1] : null;
  }

  return null;
}

/**
 * Extract interface names from `implements X, Y` in a TS class signature.
 */
function extractImplementsNames(signature) {
  if (!signature) {
    return [];
  }
  const m = signature.match(/implements\s+([\w,\s]+?)(?:\s*\{|$)/);
  if (!m) {
    return [];
  }
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

module.exports = {
  buildExtendsEdges,
  buildImplementsEdges,
  buildReexportEdges,
  buildReferenceEdges,
};
