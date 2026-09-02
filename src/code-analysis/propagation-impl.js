/**
 * Propagation engine — unified weighted BFS across all edge types.
 * Finds all files/symbols affected by a change using code_calls, code_imports,
 * code_relations, and file_cochange with per-type decay scoring.
 */
const { _requireNativeDb } = require('./shared-deps'),
  EDGE_DECAY = {
    call: 0.7,
    import: 0.5,
    extends: 0.8,
    implements: 0.8,
    reexport: 0.7,
    references: 0.4,
    cochange: 0.3,
  },
  DISTANCE_DECAY = 0.85,
  DEFAULT_MIN_REACHABILITY = 0.1,
  DEFAULT_MAX_DEPTH = 5;

/**
 * Unified weighted BFS across all edge types.
 * Finds all files/symbols affected by a change to the given symbol or file.
 */
function getAffectedGraph(db, repoId, opts = {}) {
  const guard = _requireNativeDb(db),
  { symbol, file, minReachability = DEFAULT_MIN_REACHABILITY, maxDepth = DEFAULT_MAX_DEPTH } = !(guard) ? (opts) : undefined, seedSymbolIds = [];
  if (guard) {
    return guard;
  }


  if (!symbol && !file) {
    return { error: 'Missing --symbol or --file' };
  }

  let seedFileId = null,
    seedFilePath = file || null,
    seedSymbolName = symbol || null;
  

  if (symbol) {
    const symRows = db
      .prepare('SELECT id, name, file_id, file_path FROM code_symbols WHERE repo_id = ? AND name = ?')
      .all(repoId, symbol);

    if (symRows.length === 0) {
      return { error: `Symbol "${symbol}" not found` };
    }
    if (symRows.length > 1) {
      return { error: `Multiple symbols named "${symbol}"`, candidates: symRows };
    }

    seedSymbolIds.push(symRows[0].id);
    seedFileId = symRows[0].file_id;
    seedFilePath = symRows[0].file_path;
    seedSymbolName = symRows[0].name;
  }

  if (file && !seedFileId) {
    const fileRow = db.prepare('SELECT id, path FROM code_files WHERE repo_id = ? AND path = ?').get(repoId, file);
    if (fileRow) {
      seedFileId = fileRow.id;
    }
  }

  {
const visited = new Map(), // Key → { reachability, depth, signals }
    queue = [],
    affectedFiles = new Map(), // FileId → { path, reachability, signals, depth }
    affectedSymbols = new Map(),
  stmtFilePath = (() => {
 // SymbolId → { name, file, reachability, via }
  
    if (seedSymbolIds.length > 0) {
      const key = `sym:${seedSymbolIds[0]}`;
      visited.set(key, { reachability: 1.0, depth: 0, signals: [] });
      queue.push({ type: 'symbol', id: seedSymbolIds[0], fileId: seedFileId, reachability: 1.0, depth: 0 });
    }
    if (seedFileId) {
      const key = `file:${seedFileId}`;
      if (!visited.has(key)) {
        visited.set(key, { reachability: 1.0, depth: 0, signals: [] });
      }
      queue.push({ type: 'file', id: seedFileId, reachability: 1.0, depth: 0 });
    }
  
    
  return (db.prepare('SELECT path FROM code_files WHERE id = ?'));
})(); while (queue.length > 0) {
    const current = queue.shift();

    if (current.depth < maxDepth) {
      const fileId = current.type === 'file' ? current.id : current.fileId;

      // 1. code_calls: who calls this symbol?
      if (current.type === 'symbol') {
        try {
          const callers = db
            .prepare(
              `SELECT cc.caller_symbol_id, cc.confidence, cs.name, cs.file_path, cs.file_id
             FROM code_calls cc JOIN code_symbols cs ON cs.id = cc.caller_symbol_id
             WHERE cc.callee_symbol_id = ? AND cc.confidence >= ?`,
            )
            .all(current.id, 0.3);

          for (const c of callers) {
            const score = c.confidence * EDGE_DECAY.call * DISTANCE_DECAY ** (current.depth + 1),
              key = `sym:${c.caller_symbol_id}`,
              existing = visited.get(key),
              shouldVisit = score >= minReachability && (!existing || existing.reachability < score);

            if (shouldVisit) {
              visited.set(key, { reachability: score, depth: current.depth + 1, signals: ['call'] });
              queue.push({
                type: 'symbol',
                id: c.caller_symbol_id,
                fileId: c.file_id,
                reachability: score,
                depth: current.depth + 1,
              });

              affectedSymbols.set(c.caller_symbol_id, {
                name: c.name,
                file: c.file_path,
                reachability: Math.round(score * 100) / 100,
                via: 'call',
              });

              if (c.file_id) {
                updateFileEntry(affectedFiles, c.file_id, c.file_path, score, 'call', current.depth + 1);
              }
            }
          }
        } catch {}
      }

      // 2. code_imports: who imports this file?
      if (fileId) {
        try {
          const importers = db
            .prepare(
              `SELECT ci.source_file_id, cf.path
             FROM code_imports ci JOIN code_files cf ON cf.id = ci.source_file_id
             WHERE ci.target_file_id = ?`,
            )
            .all(fileId);

          for (const imp of importers) {
            const score = EDGE_DECAY.import * DISTANCE_DECAY ** (current.depth + 1),
              key = `file:${imp.source_file_id}`,
              existing = visited.get(key),
              shouldVisit = score >= minReachability && (!existing || existing.reachability < score);

            if (shouldVisit) {
              visited.set(key, { reachability: score, depth: current.depth + 1, signals: ['import'] });
              queue.push({ type: 'file', id: imp.source_file_id, reachability: score, depth: current.depth + 1 });

              updateFileEntry(affectedFiles, imp.source_file_id, imp.path, score, 'import', current.depth + 1);
            }
          }
        } catch {}
      }

      // 3. code_relations: what targets this symbol/file?
      {
        const rels = [];
        try {
          if (current.type === 'symbol') {
            rels.push(
              ...db
                .prepare(
                  `SELECT cr.source_symbol_id, cr.source_file_id, cr.kind, cr.weight,
                      cs.name, cs.file_path, cs.file_id AS sym_file_id
               FROM code_relations cr
               LEFT JOIN code_symbols cs ON cs.id = cr.source_symbol_id
               WHERE cr.target_symbol_id = ? AND cr.repo_id = ?`,
                )
                .all(current.id, repoId),
            );
          }
          if (fileId) {
            rels.push(
              ...db
                .prepare(
                  `SELECT cr.source_symbol_id, cr.source_file_id, cr.kind, cr.weight,
                      cs.name, cs.file_path, cs.file_id AS sym_file_id
               FROM code_relations cr
               LEFT JOIN code_symbols cs ON cs.id = cr.source_symbol_id
               WHERE cr.target_file_id = ? AND cr.repo_id = ?`,
                )
                .all(fileId, repoId),
            );
          }
        } catch {}

        for (const r of rels) {
          const decay = EDGE_DECAY[r.kind] || 0.5,
            score = (r.weight || 1.0) * decay * DISTANCE_DECAY ** (current.depth + 1);
          if (score >= minReachability) {
            if (r.source_symbol_id) {
              const key = `sym:${r.source_symbol_id}`,
                existing = visited.get(key);
              if (!existing || existing.reachability < score) {
                visited.set(key, { reachability: score, depth: current.depth + 1, signals: [r.kind] });
                queue.push({
                  type: 'symbol',
                  id: r.source_symbol_id,
                  fileId: r.sym_file_id,
                  reachability: score,
                  depth: current.depth + 1,
                });

                if (r.name) {
                  affectedSymbols.set(r.source_symbol_id, {
                    name: r.name,
                    file: r.file_path,
                    reachability: Math.round(score * 100) / 100,
                    via: r.kind,
                  });
                }
              }
            }
            if (r.source_file_id) {
              const key = `file:${r.source_file_id}`,
                existing = visited.get(key);
              if (!existing || existing.reachability < score) {
                visited.set(key, { reachability: score, depth: current.depth + 1, signals: [r.kind] });
                queue.push({ type: 'file', id: r.source_file_id, reachability: score, depth: current.depth + 1 });

                const filePath = stmtFilePath.get(r.source_file_id);
                if (filePath) {
                  updateFileEntry(affectedFiles, r.source_file_id, filePath.path, score, r.kind, current.depth + 1);
                }
              }
            }
          }
        }
      }

      // 4. file_cochange: what files co-change with this file?
      if (fileId) {
        try {
          const cochanges = db
            .prepare(
              `SELECT file_a_id, file_b_id, strength FROM file_cochange WHERE repo_id = ? AND (file_a_id = ? OR file_b_id = ?)`,
            )
            .all(repoId, fileId, fileId);

          for (const cc of cochanges) {
            const otherId = cc.file_a_id === fileId ? cc.file_b_id : cc.file_a_id,
              score = (cc.strength || 0.3) * EDGE_DECAY.cochange * DISTANCE_DECAY ** (current.depth + 1),
              key = `file:${otherId}`,
              existing = visited.get(key),
              shouldVisit = score >= minReachability && (!existing || existing.reachability < score);

            if (shouldVisit) {
              visited.set(key, { reachability: score, depth: current.depth + 1, signals: ['cochange'] });
              queue.push({ type: 'file', id: otherId, reachability: score, depth: current.depth + 1 });

              const filePath = stmtFilePath.get(otherId);
              if (filePath) {
                updateFileEntry(affectedFiles, otherId, filePath.path, score, 'cochange', current.depth + 1);
              }
            }
          }
        } catch {}
      }
    }
  }

  {
const sortedFiles = [...affectedFiles.values()].sort((a, b) => b.reachability - a.reachability),
    sortedSymbols = [...affectedSymbols.values()].sort((a, b) => b.reachability - a.reachability);

  return {
    symbol: seedSymbolName,
    seed_file: seedFilePath,
    affected_files: sortedFiles,
    affected_symbols: sortedSymbols,
  };
}
}
}

function updateFileEntry(map, fileId, filePath, score, signal, depth) {
  const existing = map.get(fileId);
  if (existing) {
    if (score > existing.reachability) {
      existing.reachability = Math.round(score * 100) / 100;
    }
    if (!existing.signals.includes(signal)) {
      existing.signals.push(signal);
    }
    if (depth < existing.depth) {
      existing.depth = depth;
    }
  } else {
    map.set(fileId, {
      path: filePath,
      reachability: Math.round(score * 100) / 100,
      signals: [signal],
      depth,
    });
  }
}

module.exports = {
  getAffectedGraph,
  EDGE_DECAY,
};
