// Incremental builders for import graph, call graph, and complexity.

const { _requireNativeDb } = require('./shared-deps'),
  { extractImportsFromSource, resolveImportTarget } = require('./import-graph-impl'),
  { buildCallGraph } = require('./call-graph-impl'),
  { computeComplexity } = require('./complexity-impl');

function buildImportGraphForFiles(db, repoId, changedFileIds, deletedFileIds = []) {
  const guard = _requireNativeDb(db),
    allAffected =
      !guard && !(!changedFileIds.length && !deletedFileIds.length)
        ? new Set([...changedFileIds, ...deletedFileIds])
        : undefined;
  if (guard) {
    return guard;
  }
  if (!changedFileIds.length && !deletedFileIds.length) {
    return { success: true, edges: 0, incremental: true };
  }

  if (allAffected.size > 0) {
    const ph = [...allAffected].map(() => '?').join(','),
      importers = db
        .prepare(`SELECT DISTINCT source_file_id FROM code_imports WHERE repo_id = ? AND target_file_id IN (${ph})`)
        .all(repoId, ...allAffected);
    for (const row of importers) {
      allAffected.add(row.source_file_id);
    }
  }

  const delPh = [...allAffected].map(() => '?').join(',');
  db.prepare(`DELETE FROM code_imports WHERE repo_id = ? AND source_file_id IN (${delPh})`).run(repoId, ...allAffected);

  const insertStmt = db.prepare(
      `INSERT OR IGNORE INTO code_imports (repo_id, source_file_id, target_module, target_file_id, import_type, line_number) VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    fileStmt = db.prepare('SELECT id, path, content FROM code_files WHERE id = ?'),
    deletedSet = new Set(deletedFileIds);
  let totalEdges = 0;

  const runInTx =
    typeof db.transaction === 'function'
      ? (fn) => db.transaction(fn)()
      : (fn) => {
          db.exec('BEGIN');
          try {
            const r = fn();
            db.exec('COMMIT');
            return r;
          } catch (e) {
            db.exec('ROLLBACK');
            throw e;
          }
        };

  runInTx(() => {
    for (const fileId of allAffected) {
      // oxlint-disable-next-line no-continue
      if (deletedSet.has(fileId)) {
        continue;
      }
      const row = fileStmt.get(fileId);
      // oxlint-disable-next-line no-continue
      if (!row || !row.content) {
        continue;
      }
      const imports = extractImportsFromSource(row.content);
      for (const imp of imports) {
        const targetFileId = resolveImportTarget(db, repoId, row.path, imp.target_module);
        insertStmt.run(repoId, fileId, imp.target_module, targetFileId, imp.import_type, imp.line_number);
        totalEdges++;
      }
    }
  });

  return { success: true, edges: totalEdges, incremental: true, filesAffected: allAffected.size };
}

function buildCallGraphForFiles(db, repoId, changedFileIds, deletedFileIds = [], opts = {}) {
  const guard = _requireNativeDb(db),
    { onProgress } = !guard && !(!changedFileIds.length && !deletedFileIds.length) ? opts : undefined,
    deletedSet = !guard && !(!changedFileIds.length && !deletedFileIds.length) ? new Set(deletedFileIds) : undefined;
  if (guard) {
    return guard;
  }
  if (!changedFileIds.length && !deletedFileIds.length) {
    return { success: true, calls: 0, incremental: true };
  }

  if (changedFileIds.length > 0) {
    const ph = changedFileIds.map(() => '?').join(',');
    db.prepare(
      `DELETE FROM code_calls WHERE repo_id = ? AND caller_symbol_id IN (SELECT id FROM code_symbols WHERE file_id IN (${ph}))`,
    ).run(repoId, ...changedFileIds);
  }
  if (deletedFileIds.length > 0) {
    const ph = deletedFileIds.map(() => '?').join(',');
    db.prepare(
      `DELETE FROM code_calls WHERE repo_id = ? AND caller_symbol_id IN (SELECT id FROM code_symbols WHERE file_id IN (${ph}))`,
    ).run(repoId, ...deletedFileIds);
  }

  // Unresolved calls are normal (builtins, libraries), so only re-resolve the
  // Ones whose callee name is now defined in a changed file.
  const changedPh = changedFileIds.map(() => '?').join(','),
    newNames = changedFileIds.length
      ? `AND callee_name IN (SELECT name FROM code_symbols WHERE file_id IN (${changedPh}))`
      : 'AND 0',
    staleCallers = db
      .prepare(
        `SELECT DISTINCT s.file_id FROM code_calls cc JOIN code_symbols s ON s.id = cc.caller_symbol_id WHERE cc.repo_id = ? AND cc.callee_symbol_id IS NULL ${newNames}`,
      )
      .all(repoId, ...changedFileIds)
      .map((r) => r.file_id),
    rebuildFileIds = (() => {
      if (staleCallers.length > 0) {
        const stalePh = staleCallers.map(() => '?').join(',');
        db.prepare(
          `DELETE FROM code_calls WHERE repo_id = ? AND caller_symbol_id IN (SELECT id FROM code_symbols WHERE file_id IN (${stalePh})) AND callee_symbol_id IS NULL ${newNames}`,
        ).run(repoId, ...staleCallers, ...changedFileIds);
      }

      return new Set([...changedFileIds, ...staleCallers].filter((id) => !deletedSet.has(id)));
    })();
  if (rebuildFileIds.size === 0) {
    return { success: true, calls: 0, incremental: true };
  }

  const r = buildCallGraph(db, repoId, { onProgress, fileIds: rebuildFileIds });
  return { ...r, incremental: true, filesAffected: rebuildFileIds.size };
}

function buildComplexityForFiles(db, repoId, changedFileIds, deletedFileIds = []) {
  const guard = _requireNativeDb(db);
  if (guard) {
    return guard;
  }
  if (!changedFileIds.length && !deletedFileIds.length) {
    return { success: true, symbols: 0, incremental: true };
  }

  const allAffected = [...changedFileIds, ...deletedFileIds],
    ph = allAffected.map(() => '?').join(',');
  db.prepare(
    `DELETE FROM symbol_complexity WHERE symbol_id IN (SELECT id FROM code_symbols WHERE file_id IN (${ph}))`,
  ).run(...allAffected);

  if (changedFileIds.length === 0) {
    return { success: true, symbols: 0, incremental: true };
  }

  const changedPh = changedFileIds.map(() => '?').join(','),
    symbols = db
      .prepare(
        `SELECT cs.id, cs.name, cs.file_id, cs.start_byte, cs.end_byte, cs.start_line, cs.end_line, cs.signature, cf.content as file_content
       FROM code_symbols cs JOIN code_files cf ON cf.id = cs.file_id
       WHERE cs.repo_id = ? AND cs.kind IN ('function', 'method') AND cs.file_id IN (${changedPh})`,
      )
      .all(repoId, ...changedFileIds),
    insertStmt = db.prepare(
      `INSERT OR REPLACE INTO symbol_complexity (symbol_id, cyclomatic, nesting_depth, param_count, lines_of_code, assessment) VALUES (?, ?, ?, ?, ?, ?)`,
    );

  const fileBuffers = new Map();
  let count = 0;
  for (const sym of symbols) {
    // oxlint-disable-next-line no-continue
    if (!sym.file_content || sym.end_byte <= sym.start_byte) {
      continue;
    }
    // The JOIN repeats file_content per symbol; encode each file once.
    let fileBuf = fileBuffers.get(sym.file_id);
    if (!fileBuf) {
      fileBuf = Buffer.from(sym.file_content, 'utf-8');
      fileBuffers.set(sym.file_id, fileBuf);
    }
    const body = fileBuf.toString('utf-8', sym.start_byte, sym.end_byte);
    // oxlint-disable-next-line no-continue
    if (!body) {
      continue;
    }

    const c = computeComplexity(body, sym.signature);
    insertStmt.run(sym.id, c.cyclomatic, c.nesting_depth, c.param_count, c.lines_of_code, c.assessment);
    count++;
  }

  return { success: true, symbols: count, incremental: true };
}

module.exports = {
  buildImportGraphForFiles,
  buildCallGraphForFiles,
  buildComplexityForFiles,
};
