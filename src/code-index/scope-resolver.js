// Multi-pass scope resolution — populates scope_resolution table from file_scope_bindings.
// Pass 1: Parse all files, build scope tables (done in parsePhase)
// Pass 2: Direct resolution (import targets, local symbols)
// Pass 3: Re-export chain resolution (fixed-point iteration)

// Lazy load for import-graph-impl to avoid circular dependency issues
let _importGraph = null;


const _path = require('path'),
  MAX_RESOLUTION_PASSES = 10,
  WILDCARD_EXPANSION_CAP = 50;

function resolveTargetFileId(db, binding) {
  if (binding.source_file_id) {
    return binding.source_file_id;
  }
  if (binding.source_module) {
    const moduleMatch = db
      .prepare(
        `SELECT target_file_id FROM code_imports WHERE source_file_id = ? AND target_module = ? AND target_file_id IS NOT NULL LIMIT 1`,
      )
      .get(binding.file_id, binding.source_module);
    if (moduleMatch?.target_file_id) {
      return moduleMatch.target_file_id;
    }
  }
  const fallback = db
    .prepare(`SELECT target_file_id FROM code_imports WHERE source_file_id = ? AND target_file_id IS NOT NULL LIMIT 1`)
    .get(binding.file_id);
  return fallback?.target_file_id || null;
}

/**
 * Run multi-pass scope resolution for a repo.
 * @param {object} db - native database handle
 * @param {number} repoId - repo ID
 * @param {object} opts - options { onProgress }
 * @returns {{ resolved: number, unresolved: number, passes: number, warnings: string[] }}
 */
function resolveScopeBindings(db, repoId, opts = {}) {
  const { onProgress } = opts,
    warnings = [];
  let totalResolved = 0,
    totalUnresolved = 0, passNum = 3,
    newResolved = 0;

  // ── Pass 2: Direct resolution ──────────────────────────

  {
const pass2Result = runDirectResolution(db, repoId);
  totalResolved += pass2Result.resolved;
  totalUnresolved += pass2Result.unresolved;

  if (onProgress) {
    onProgress({ pass: 2, resolved: pass2Result.resolved, unresolved: pass2Result.unresolved });
  }

  // ── Pass 3: Re-export chain resolution (fixed-point) ───

  

  do {
    const passResult = runReexportResolution(db, repoId, passNum);
    newResolved = passResult.resolved;
    totalResolved += newResolved;
    warnings.push(...passResult.warnings);

    if (onProgress) {
      onProgress({ pass: passNum, resolved: newResolved, totalResolved });
    }

    passNum++;
  } while (newResolved > 0 && passNum <= MAX_RESOLUTION_PASSES);

  if (passNum > MAX_RESOLUTION_PASSES) {
    warnings.push(`Resolution hit ${MAX_RESOLUTION_PASSES} pass limit — some re-export chains may be unresolved`);
  }

  // Count final unresolved
  {
const unresolvedRow = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM scope_resolution WHERE status = 'unresolved' AND binding_id IN (SELECT id FROM file_scope_bindings WHERE repo_id = ?)`,
    )
    .get(repoId);
  totalUnresolved = unresolvedRow ? unresolvedRow.cnt : 0;

  return {
    resolved: totalResolved,
    unresolved: totalUnresolved,
    passes: passNum - 1,
    warnings,
  };
}
}
}

/**
 * Run direct resolution (Pass 2):
 * - external_file: resolve source_file_id using import target resolution
 * - external_package: mark resolved_external
 * - local: match against code_symbols in the same file
 * - unresolved: mark as-is
 */
function runDirectResolution(db, repoId) {
  let resolved = 0,
    unresolved = 0;

  // Get all bindings that don't have a scope_resolution row yet
  const bindings = db
      .prepare(`
    SELECT fsb.id, fsb.file_id, fsb.name, fsb.kind, fsb.origin, fsb.source_file_id,
           fsb.source_name, fsb.source_module, fsb.line_start, fsb.line_end, fsb.scope_depth
    FROM file_scope_bindings fsb
    WHERE fsb.repo_id = ? AND fsb.id NOT IN (SELECT binding_id FROM scope_resolution)
  `)
      .all(repoId),
    insertResolution = db.prepare(
      `INSERT INTO scope_resolution (binding_id, resolved_symbol_id, resolved_file_id, status, resolved_at_pass, confidence) VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    // Cache for import target resolution
    _importTargetCache = new Map(),
    // Cache for file path lookup
    filePathCache = new Map(),
    _getFilePath = (fileId) => {
      if (!filePathCache.has(fileId)) {
        const row = db.prepare('SELECT path FROM code_files WHERE id = ?').get(fileId);
        filePathCache.set(fileId, row ? row.path : null);
      }
      return filePathCache.get(fileId);
    },
    runInTx =
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
    for (const binding of bindings) {
      if (binding.origin === 'external_package') {
        insertResolution.run(binding.id, null, null, 'resolved_external', 2, 1.0);
        resolved++;
        // oxlint-disable-next-line no-continue
        continue;
      }

      if (binding.origin === 'unresolved') {
        insertResolution.run(binding.id, null, null, 'unresolved', 2, 0.0);
        unresolved++;
        // oxlint-disable-next-line no-continue
        continue;
      }

      if (binding.origin === 'external_file') {
        // Resolve the source_file_id from the import module path
        let targetFileId = binding.source_file_id;

        // If no source_file_id yet, try to resolve from import edges
        if (!targetFileId) {
          targetFileId = resolveTargetFileId(db, binding);
        }

        if (targetFileId) {
          // Try to find the symbol in the target file
          const sourceName = binding.source_name || binding.name,
            symbolRow = db
              .prepare(`SELECT id FROM code_symbols WHERE file_id = ? AND name = ? LIMIT 1`)
              .get(targetFileId, sourceName);

          if (symbolRow) {
            insertResolution.run(binding.id, symbolRow.id, targetFileId, 'resolved_internal', 2, 1.0);
            resolved++;
          } else {
            // Import resolved to file but symbol not found
            insertResolution.run(binding.id, null, targetFileId, 'unresolved', 2, 0.5);
            unresolved++;
          }
        } else {
          insertResolution.run(binding.id, null, null, 'unresolved', 2, 0.3);
          unresolved++;
        }
        // oxlint-disable-next-line no-continue
        continue;
      }

      if (binding.origin === 'local') {
        // Find matching code_symbols row in the same file
        const symbolRow = db
          .prepare(`
          SELECT id FROM code_symbols
          WHERE file_id = ? AND name = ? AND start_line <= ? AND end_line >= ?
          ORDER BY (end_line - start_line) ASC
          LIMIT 1
        `)
          .get(binding.file_id, binding.name, binding.line_end, binding.line_start);

        if (symbolRow) {
          insertResolution.run(binding.id, symbolRow.id, null, 'resolved_internal', 2, 1.0);
          resolved++;
        } else {
          // Local binding without a matching symbol — might be a variable, param, etc.
          insertResolution.run(binding.id, null, null, 'unresolved', 2, 0.2);
          unresolved++;
        }
        // oxlint-disable-next-line no-continue
        continue;
      }

      if (binding.origin === 'internal_package' || binding.origin === 'internal_module') {
        // Go/Rust internal packages/modules — resolved at file level
        insertResolution.run(binding.id, null, null, 'resolved_external', 2, 0.8);
        resolved++;
        // oxlint-disable-next-line no-continue
        continue;
      }

      if (binding.origin === 'external') {
        // SQL table refs, etc.
        insertResolution.run(binding.id, null, null, 'resolved_external', 2, 0.7);
        resolved++;
        // oxlint-disable-next-line no-continue
        continue;
      }

      // Unknown origin
      insertResolution.run(binding.id, null, null, 'unresolved', 2, 0.0);
      unresolved++;
    }
  });

  return { resolved, unresolved };
}

/**
 * Run re-export chain resolution (Pass 3+):
 * - re_export: follow the chain through source_file_id
 * - wildcard_import: enumerate source file's exported symbols
 * - namespace_import: create synthetic bindings for exported symbols
 */
function runReexportResolution(db, repoId, passNum) {
  let resolved = 0;
  const warnings = [],
    runInTx =
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
    // ── Re-export chains ─────────────────────────────────
    const reexportBindings = db
      .prepare(`
      SELECT fsb.id, fsb.file_id, fsb.name, fsb.kind, fsb.source_file_id, fsb.source_name
      FROM file_scope_bindings fsb
      JOIN scope_resolution sr ON sr.binding_id = fsb.id
      WHERE fsb.repo_id = ? AND fsb.kind = 're_export' AND sr.status = 'unresolved'
        AND fsb.source_file_id IS NOT NULL
    `)
      .all(repoId);

    for (const binding of reexportBindings) {
      // Follow the chain: find the original binding in the source file
      const sourceBinding = db
        .prepare(`
        SELECT fsb.id, sr.resolved_symbol_id, sr.status
        FROM file_scope_bindings fsb
        JOIN scope_resolution sr ON sr.binding_id = fsb.id
        WHERE fsb.file_id = ? AND fsb.name = ? AND sr.status = 'resolved_internal'
        LIMIT 1
      `)
        .get(binding.source_file_id, binding.source_name || binding.name);

      if (sourceBinding && sourceBinding.resolved_symbol_id) {
        db.prepare(
          `UPDATE scope_resolution SET resolved_symbol_id = ?, status = 'resolved_internal', resolved_at_pass = ?, confidence = 0.9 WHERE binding_id = ?`,
        ).run(sourceBinding.resolved_symbol_id, passNum, binding.id);
        resolved++;
      }
    }

    // ── Wildcard imports (Python) ────────────────────────
    const wildcardBindings = db
        .prepare(`
      SELECT fsb.id, fsb.file_id, fsb.name, fsb.source_file_id, fsb.source_module
      FROM file_scope_bindings fsb
      JOIN scope_resolution sr ON sr.binding_id = fsb.id
      WHERE fsb.repo_id = ? AND fsb.kind = 'wildcard_import'
        AND sr.status = 'unresolved' AND fsb.source_file_id IS NOT NULL
    `)
        .all(repoId),
      insertBinding = db.prepare(
        `INSERT INTO file_scope_bindings (repo_id, file_id, name, kind, origin, source_file_id, source_name, source_module, line_start, line_end, scope_depth, first_seen_pass)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      insertResolution = db.prepare(
        `INSERT INTO scope_resolution (binding_id, resolved_symbol_id, resolved_file_id, status, resolved_at_pass, confidence) VALUES (?, ?, ?, ?, ?, ?)`,
      ),
    namespaceBindings = (() => {

  
      for (const binding of wildcardBindings) {
        // Enumerate exported symbols from the source file
        const exportedSymbols = db
          .prepare(
            `SELECT id, name, start_line, end_line FROM code_symbols WHERE file_id = ? AND name IS NOT NULL LIMIT ?`,
          )
          .all(binding.source_file_id, WILDCARD_EXPANSION_CAP + 1);
  
        if (exportedSymbols.length > WILDCARD_EXPANSION_CAP) {
          warnings.push(`Wildcard import from ${binding.source_module} exceeded ${WILDCARD_EXPANSION_CAP} symbol cap`);
        }
  
        for (const sym of exportedSymbols.slice(0, WILDCARD_EXPANSION_CAP)) {
          // Create synthetic binding
          const synthBindingId = insertBinding.run(
            repoId,
            binding.file_id,
            sym.name,
            'named_import',
            'external_file',
            binding.source_file_id,
            sym.name,
            binding.source_module || null,
            // Use the wildcard import's line range
            ...getBindingLineRange(db, binding.id),
            0,
            passNum,
          ).lastInsertRowid;
  
          insertResolution.run(synthBindingId, sym.id, binding.source_file_id, 'resolved_internal', passNum, 0.8);
          resolved++;
        }
  
        // Mark the wildcard binding itself as resolved
        db.prepare(
          `UPDATE scope_resolution SET status = 'resolved_external', resolved_at_pass = ? WHERE binding_id = ?`,
        ).run(passNum, binding.id);
        resolved++;
      }
  
      // ── Namespace imports (JS) ───────────────────────────
      
  return (db
      .prepare(`
      SELECT fsb.id, fsb.file_id, fsb.name, fsb.source_file_id, fsb.source_module
      FROM file_scope_bindings fsb
      JOIN scope_resolution sr ON sr.binding_id = fsb.id
      WHERE fsb.repo_id = ? AND fsb.kind = 'namespace_import'
        AND sr.status = 'unresolved' AND fsb.source_file_id IS NOT NULL
    `)
      .all(repoId));
})(); for (const binding of namespaceBindings) {
      const exportedSymbols = db
        .prepare(
          `SELECT id, name, start_line, end_line FROM code_symbols WHERE file_id = ? AND name IS NOT NULL LIMIT ?`,
        )
        .all(binding.source_file_id, WILDCARD_EXPANSION_CAP + 1);

      if (exportedSymbols.length > WILDCARD_EXPANSION_CAP) {
        warnings.push(
          `Namespace import ${binding.name} from ${binding.source_module} exceeded ${WILDCARD_EXPANSION_CAP} symbol cap`,
        );
      }

      for (const sym of exportedSymbols.slice(0, WILDCARD_EXPANSION_CAP)) {
        const qualifiedName = `${binding.name}.${sym.name}`,
          synthBindingId = insertBinding.run(
            repoId,
            binding.file_id,
            qualifiedName,
            'named_import',
            'external_file',
            binding.source_file_id,
            sym.name,
            ...getBindingLineRange(db, binding.id),
            0,
            passNum,
          ).lastInsertRowid;

        insertResolution.run(synthBindingId, sym.id, binding.source_file_id, 'resolved_internal', passNum, 0.85);
        resolved++;
      }

      // Mark the namespace binding itself as resolved
      db.prepare(
        `UPDATE scope_resolution SET status = 'resolved_external', resolved_at_pass = ? WHERE binding_id = ?`,
      ).run(passNum, binding.id);
      resolved++;
    }
  });

  return { resolved, warnings };
}

function getBindingLineRange(db, bindingId) {
  const row = db.prepare('SELECT line_start, line_end FROM file_scope_bindings WHERE id = ?').get(bindingId);
  return row ? [row.line_start, row.line_end] : [0, 0];
}

/**
 * Resolve scope bindings for specific changed files (incremental reindex).
 * @param {object} db - native database handle
 * @param {number} repoId - repo ID
 * @param {number[]} changedFileIds - IDs of changed files
 * @param {number[]} deletedFileIds - IDs of deleted files
 * @returns {{ resolved: number, unresolved: number, passes: number, warnings: string[] }}
 */
function resolveScopeBindingsForFiles(db, repoId, changedFileIds, deletedFileIds) {
  const warnings = [];
  let resolved = 0,
    unresolved = 0;

  // For incremental: clean and re-resolve for changed files + their direct importers
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
    // Delete scope_resolution for changed and deleted files
    for (const fileId of [...changedFileIds, ...deletedFileIds]) {
      db.prepare(
        `DELETE FROM scope_resolution WHERE binding_id IN (SELECT id FROM file_scope_bindings WHERE file_id = ?)`,
      ).run(fileId);
    }

    // Also clean for direct importers of changed files
    const importerFileIds = new Set(),
    allFileIds = (() => {

      for (const fileId of changedFileIds) {
        const importers = db
          .prepare(`SELECT DISTINCT source_file_id FROM code_imports WHERE target_file_id = ?`)
          .all(fileId);
        for (const imp of importers) {
          importerFileIds.add(imp.source_file_id);
        }
      }
  
      for (const fileId of importerFileIds) {
        db.prepare(
          `DELETE FROM scope_resolution WHERE binding_id IN (SELECT id FROM file_scope_bindings WHERE file_id = ?)`,
        ).run(fileId);
      }
  
      // Re-resolve for all affected files
      
  return ([...new Set([...changedFileIds, ...importerFileIds])]);
})(),
    reexportResult = (() => {
for (const fileId of allFileIds) {
        // Only resolve bindings for this specific file
        const bindings = db
          .prepare(`
          SELECT fsb.id, fsb.file_id, fsb.name, fsb.kind, fsb.origin, fsb.source_file_id,
                 fsb.source_name, fsb.line_start, fsb.line_end, fsb.scope_depth
          FROM file_scope_bindings fsb
          WHERE fsb.repo_id = ? AND fsb.file_id = ? AND fsb.id NOT IN (SELECT binding_id FROM scope_resolution)
        `)
          .all(repoId, fileId);
  
        for (const binding of bindings) {
          const status = resolveBindingDirect(db, binding, 2);
          if (status && status.startsWith('resolved')) {
            resolved++;
          } else {
            unresolved++;
          }
        }
      }
  
      // Run re-export resolution for all affected files
      
  return (runReexportResolution(db, repoId, 3));
})();resolved += reexportResult.resolved || 0;
    warnings.push(...reexportResult.warnings);
  });

  return {
    resolved,
    unresolved,
    passes: 3,
    warnings,
  };
}

/**
 * Resolve a single binding directly (used by incremental resolution).
 * @returns {string} the status inserted for this binding ('resolved_*' | 'unresolved')
 */
function resolveBindingDirect(db, binding, passNum) {
  const insertResolution = db.prepare(
    `INSERT INTO scope_resolution (binding_id, resolved_symbol_id, resolved_file_id, status, resolved_at_pass, confidence) VALUES (?, ?, ?, ?, ?, ?)`,
  );

  if (binding.origin === 'external_package') {
    insertResolution.run(binding.id, null, null, 'resolved_external', passNum, 1.0);
    return 'resolved_external';
  } else if (binding.origin === 'unresolved') {
    insertResolution.run(binding.id, null, null, 'unresolved', passNum, 0.0);
    return 'unresolved';
  } else if (binding.origin === 'external_file') {
    let targetFileId = binding.source_file_id;
    if (!targetFileId) {
      targetFileId = resolveTargetFileId(db, binding);
    }
    if (targetFileId) {
      const sourceName = binding.source_name || binding.name,
        symbolRow = db
          .prepare(`SELECT id FROM code_symbols WHERE file_id = ? AND name = ? LIMIT 1`)
          .get(targetFileId, sourceName);
      if (symbolRow) {
        insertResolution.run(binding.id, symbolRow.id, targetFileId, 'resolved_internal', passNum, 1.0);
        return 'resolved_internal';
      } else {
        insertResolution.run(binding.id, null, targetFileId, 'unresolved', passNum, 0.5);
        return 'unresolved';
      }
    } else {
      insertResolution.run(binding.id, null, null, 'unresolved', passNum, 0.3);
      return 'unresolved';
    }
  } else if (binding.origin === 'local') {
    const symbolRow = db
      .prepare(`
      SELECT id FROM code_symbols
      WHERE file_id = ? AND name = ? AND start_line <= ? AND end_line >= ?
      ORDER BY (end_line - start_line) ASC
      LIMIT 1
    `)
      .get(binding.file_id, binding.name, binding.line_end, binding.line_start);
    if (symbolRow) {
      insertResolution.run(binding.id, symbolRow.id, null, 'resolved_internal', passNum, 1.0);
      return 'resolved_internal';
    } else {
      insertResolution.run(binding.id, null, null, 'unresolved', passNum, 0.2);
      return 'unresolved';
    }
  } else if (binding.origin === 'internal_package' || binding.origin === 'internal_module') {
    insertResolution.run(binding.id, null, null, 'resolved_external', passNum, 0.8);
    return 'resolved_external';
  } else if (binding.origin === 'external') {
    insertResolution.run(binding.id, null, null, 'resolved_external', passNum, 0.7);
    return 'resolved_external';
  } else {
    insertResolution.run(binding.id, null, null, 'unresolved', passNum, 0.0);
    return 'unresolved';
  }
}

module.exports = {
  resolveScopeBindings,
  resolveScopeBindingsForFiles,
};
function _getImportGraph() {
  if (!_importGraph) {
    try {
      _importGraph = require('../analysis/import-graph-impl');
    } catch {
      _importGraph = {};
    }
  }
  return _importGraph;
}
