// Call graph extraction, callee resolution, and call hierarchy queries.

const { codeParser, _requireNativeDb, CALL_GRAPH, _SKIP_CALLEE_NAMES } = require('./shared-deps');
const { extractImportBindings } = require('./import-graph-impl');

function buildCallGraph(db, repoId, opts = {}) {
  const guard = _requireNativeDb(db);
  if (guard) {
    return guard;
  }
  const { onProgress } = opts;

  db.prepare('DELETE FROM code_calls WHERE repo_id = ?').run(repoId);

  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO code_calls (repo_id, caller_symbol_id, callee_name, callee_symbol_id, confidence, line_number) VALUES (?, ?, ?, ?, ?, ?)`,
  );

  // PERF(issue #131): file_path intentionally excluded — never dereferenced from allSymbols.
  // File paths are read from fileById.get(fileId).path. Including it wastes ~8 bytes per row
  // On V8 heap pointer slots that the hot loop never touches.
  const allSymbols = db
    .prepare(
      'SELECT id, name, file_id, parent_name, kind, qualified_name, start_byte, end_byte, start_line, end_line FROM code_symbols WHERE repo_id = ?',
    )
    .all(repoId);

  // PERF(issue #137): Single-pass symbol index construction — all 7 Map indices are built
  // In one iteration over allSymbols instead of 5 separate passes. For 50K symbols (~10MB),
  // This keeps the array hot in L1/L2 cache instead of re-scanning cold memory 4 extra times.
  // Derived maps (symbolsByFileAndName, methodsByParentAndName) are populated inline.
  // Do NOT split this back into separate loops — the cache behavior matters at scale.
  const symbolsByName = new Map();
  const symbolsByQualified = new Map();
  const symbolsByFile = new Map();
  const symbolsByFileAndName = new Map();
  const classParentMap = new Map();
  const methodsByParent = new Map();
  const methodsByParentAndName = new Map();

  for (const sym of allSymbols) {
    if (!symbolsByName.has(sym.name)) {
      symbolsByName.set(sym.name, []);
    }
    symbolsByName.get(sym.name).push(sym);

    if (sym.qualified_name && sym.qualified_name !== sym.name) {
      if (!symbolsByQualified.has(sym.qualified_name)) {
        symbolsByQualified.set(sym.qualified_name, []);
      }
      symbolsByQualified.get(sym.qualified_name).push(sym);
    }

    if (!symbolsByFile.has(sym.file_id)) {
      symbolsByFile.set(sym.file_id, []);
    }
    symbolsByFile.get(sym.file_id).push(sym);

    if (!symbolsByFileAndName.has(sym.file_id)) {
      symbolsByFileAndName.set(sym.file_id, new Map());
    }
    const fileByName = symbolsByFileAndName.get(sym.file_id);
    if (!fileByName.has(sym.name)) {
      fileByName.set(sym.name, []);
    }
    fileByName.get(sym.name).push(sym);

    if (sym.kind === 'class' && sym.parent_name) {
      classParentMap.set(sym.name, sym.parent_name);
    }

    if (sym.parent_name) {
      if (!methodsByParent.has(sym.parent_name)) {
        methodsByParent.set(sym.parent_name, []);
        methodsByParentAndName.set(sym.parent_name, new Map());
      }
      methodsByParent.get(sym.parent_name).push(sym);
      const parentByName = methodsByParentAndName.get(sym.parent_name);
      if (!parentByName.has(sym.name)) {
        parentByName.set(sym.name, []);
      }
      parentByName.get(sym.name).push(sym);
    }
  }

  const fileRows = db.prepare('SELECT id, path, size_bytes FROM code_files WHERE repo_id = ?').all(repoId);
  const fileById = new Map();
  for (const f of fileRows) {
    fileById.set(f.id, f);
  }
  const contentStmt = db.prepare('SELECT content FROM code_files WHERE id = ?');

  let totalCalls = 0;
  const fileImportsCache = {};
  const fileBindingsCache = {};

  function getFileSymbol(fileId, name, kind) {
    const byName = symbolsByFileAndName.get(fileId);
    if (!byName) {
      return null;
    }
    const matches = byName.get(name);
    if (!matches) {
      return null;
    }
    if (kind) {
      return matches.find((s) => s.kind === kind) || null;
    }
    return matches[0] || null;
  }

  function getFileImports(fileId) {
    if (fileImportsCache[fileId]) {
      return fileImportsCache[fileId];
    }
    const imports = db
      .prepare(
        'SELECT target_file_id, target_module FROM code_imports WHERE source_file_id = ? AND target_file_id IS NOT NULL',
      )
      .all(fileId);
    fileImportsCache[fileId] = imports;
    return imports;
  }

  function getFileBindings(fileId, fileContent) {
    if (fileBindingsCache[fileId]) {
      return fileBindingsCache[fileId];
    }
    const bindings = extractImportBindings(fileContent || '');
    const imports = getFileImports(fileId);
    const importMap = new Map();
    for (const imp of imports) {
      importMap.set(imp.target_module, imp.target_file_id);
    }
    const resolved = bindings.map((b) => ({
      ...b,
      target_file_id: importMap.get(b.modulePath) || null,
    }));
    fileBindingsCache[fileId] = resolved;
    return resolved;
  }

  // PERF(issue #134): Pre-allocated result for resolveCallee — avoids creating a new object
  // Per call in the hot path. resolveCallee writes directly into _rr; callers read from it
  // After the call. Do NOT change resolveCallee to return a new object; the per-call
  // Allocation overhead is significant at hundreds of thousands of invocations.
  const _rr = { calleeSymbolId: null, confidence: 0 };

  // ── Scope-aware resolution statement (v10) ────────────────
  const scopeResolveStmt = db.prepare(`
    SELECT sr.resolved_symbol_id, sr.confidence, sr.status, fsb.scope_depth
    FROM file_scope_bindings fsb
    JOIN scope_resolution sr ON sr.binding_id = fsb.id
    WHERE fsb.file_id = ? AND fsb.name = ? AND fsb.line_start <= ? AND fsb.line_end >= ?
      AND sr.status = 'resolved_internal'
    ORDER BY fsb.scope_depth DESC, sr.confidence DESC
    LIMIT 1
  `);

  // Keep original resolveCallee as heuristic fallback
  function resolveCalleeHeuristic(calleeName, callerSym, receiver, fileContent) {
    _rr.calleeSymbolId = null;
    _rr.confidence = 0.5;

    const bindings = getFileBindings(callerSym.file_id, fileContent);
    const bindingMatch = bindings.find((b) => b.localName === calleeName && !b.isReExport);
    if (bindingMatch) {
      const originalName = bindingMatch.originalName;
      if (bindingMatch.target_file_id) {
        if (originalName === '*' || originalName === 'default') {
          const matchSym = getFileSymbol(bindingMatch.target_file_id, calleeName);
          if (matchSym) {
            _rr.calleeSymbolId = matchSym.id;
            _rr.confidence = 1.0;
            return;
          }
        } else {
          const matchSym = getFileSymbol(bindingMatch.target_file_id, originalName);
          if (matchSym) {
            _rr.calleeSymbolId = matchSym.id;
            _rr.confidence = 1.0;
            return;
          }
        }
      }
    }

    if (receiver === 'this' && callerSym.parent_name) {
      const qualifiedName = `${callerSym.parent_name}.${calleeName}`;
      const qualifiedMatches = symbolsByQualified.get(qualifiedName);
      if (qualifiedMatches && qualifiedMatches.length === 1) {
        _rr.calleeSymbolId = qualifiedMatches[0].id;
        _rr.confidence = 0.95;
        return;
      }
      if (qualifiedMatches && qualifiedMatches.length > 1) {
        const sameFile = qualifiedMatches.find((m) => m.file_id === callerSym.file_id);
        if (sameFile) {
          _rr.calleeSymbolId = sameFile.id;
          _rr.confidence = 0.9;
          return;
        }
      }
    }

    if (receiver === 'super' && callerSym.parent_name) {
      const parentName = classParentMap.get(callerSym.parent_name);
      if (parentName) {
        const superQualified = `${parentName}.${calleeName}`;
        const superMatches = symbolsByQualified.get(superQualified);
        if (superMatches && superMatches.length === 1) {
          _rr.calleeSymbolId = superMatches[0].id;
          _rr.confidence = 0.9;
          return;
        }
      }
    }

    if (receiver && receiver !== 'this' && receiver !== 'super') {
      const binding = bindings.find((b) => b.localName === receiver && !b.isReExport);
      if (binding && binding.target_file_id) {
        if (binding.originalName === '*') {
          const matchSym = getFileSymbol(binding.target_file_id, calleeName, 'function');
          if (matchSym) {
            _rr.calleeSymbolId = matchSym.id;
            _rr.confidence = 0.95;
            return;
          }
        }
        const resolvedName = binding.originalName === 'default' ? receiver : binding.originalName;
        const classSym = getFileSymbol(binding.target_file_id, resolvedName, 'class');
        if (classSym) {
          const parentMethods = methodsByParentAndName.get(resolvedName);
          const methodSym = parentMethods ? parentMethods.get(calleeName)?.[0] || null : null;
          if (methodSym) {
            _rr.calleeSymbolId = methodSym.id;
            _rr.confidence = 0.9;
            return;
          }
        }
      }

      const qualifiedName = `${receiver}.${calleeName}`;
      const qualifiedMatches = symbolsByQualified.get(qualifiedName);
      if (qualifiedMatches && qualifiedMatches.length === 1) {
        _rr.calleeSymbolId = qualifiedMatches[0].id;
        _rr.confidence = 0.85;
        return;
      }
    }

    const fileImports = getFileImports(callerSym.file_id);
    for (const imp of fileImports) {
      const matchSym = getFileSymbol(imp.target_file_id, calleeName);
      if (matchSym) {
        _rr.calleeSymbolId = matchSym.id;
        _rr.confidence = 0.8;
        break;
      }
    }

    if (!_rr.calleeSymbolId) {
      const sameFile = getFileSymbol(callerSym.file_id, calleeName);
      if (sameFile) {
        _rr.calleeSymbolId = sameFile.id;
        _rr.confidence = 0.9;
      }
    }

    if (!_rr.calleeSymbolId) {
      const matches = symbolsByName.get(calleeName);
      if (matches && matches.length === 1) {
        _rr.calleeSymbolId = matches[0].id;
        _rr.confidence = 0.7;
      }
    }
  }

  /**
   * Scope-aware callee resolution (v10):
   * Primary: look up in scope_resolution tables, prefer innermost scope.
   * Fallback: existing heuristic cascade for cases not covered by scope tables.
   */
  function resolveCallee(calleeName, callerSym, receiver, fileContent) {
    _rr.calleeSymbolId = null;
    _rr.confidence = 0.5;

    // Primary: scope-aware lookup
    try {
      const scopeResult = scopeResolveStmt.get(
        callerSym.file_id,
        calleeName,
        callerSym.start_line,
        callerSym.start_line,
      );
      if (scopeResult && scopeResult.resolved_symbol_id) {
        _rr.calleeSymbolId = scopeResult.resolved_symbol_id;
        _rr.confidence = scopeResult.confidence;
        return;
      }
    } catch {
      // Scope_resolution table may not exist yet (pre-migration)
    }

    // Fallback: heuristic cascade
    resolveCalleeHeuristic(calleeName, callerSym, receiver, fileContent);
  }

  // oxlint-disable-next-line no-unused-vars
  function findEnclosingSymbol(line, fileSymbols) {
    for (const sym of fileSymbols) {
      if (line >= sym.start_line && line <= sym.end_line) {
        return sym;
      }
    }
    return null;
  }

  const pendingEdges = [];
  const totalFiles = symbolsByFile.size;
  let processedFiles = 0;

  function processRegexFallback(sym, fileContent) {
    if (sym.end_byte <= sym.start_byte) {
      return;
    }
    const body = Buffer.from(fileContent, 'utf-8').toString('utf-8', sym.start_byte, sym.end_byte);
    if (!body || body.length < 2) {
      return;
    }

    const seen = new Set();
    const callPatterns = [
      /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g,
      /\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g,
      /\bnew\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g,
    ];

    for (const pattern of callPatterns) {
      let match;
      pattern.lastIndex = 0;
      while ((match = pattern.exec(body)) !== null) {
        const calleeName = match[1];
        if (_SKIP_CALLEE_NAMES.has(calleeName)) {
          // oxlint-disable-next-line no-continue
          continue;
        }
        if (seen.has(calleeName)) {
          // oxlint-disable-next-line no-continue
          continue;
        }
        seen.add(calleeName);

        resolveCallee(calleeName, sym, null, fileContent);
        const lineNum = sym.start_line + body.substring(0, match.index).split('\n').length - 1;
        pendingEdges.push([repoId, sym.id, calleeName, _rr.calleeSymbolId, _rr.confidence, lineNum]);
        totalCalls++;
      }
    }
  }

  for (const [fileId, fileSymbols] of symbolsByFile) {
    const meta = fileById.get(fileId);
    if (!meta) {
      processedFiles++;
      // oxlint-disable-next-line no-continue
      continue;
    }

    const contentRow = contentStmt.get(fileId);
    if (!contentRow || !contentRow.content) {
      processedFiles++;
      // oxlint-disable-next-line no-continue
      continue;
    }

    const fileContent = contentRow.content;
    const filePath = meta.path;
    const fileSize = fileContent.length;

    let fileCallees = [];
    if (fileSize <= CALL_GRAPH.MAX_FILE_CONTENT_BYTES) {
      try {
        const extractFn = codeParser.extractCalleesFromContent || codeParser.extractCallees;
        fileCallees = extractFn(filePath, fileContent);
      } catch {
        fileCallees = [];
      }
    }

    if (fileCallees.length > 0) {
      const calleeByLine = new Map();
      for (const c of fileCallees) {
        if (!calleeByLine.has(c.line)) {
          calleeByLine.set(c.line, []);
        }
        calleeByLine.get(c.line).push(c);
      }

      const _seen = new Set();
      for (const sym of fileSymbols) {
        _seen.clear();
        for (let line = sym.start_line; line <= sym.end_line; line++) {
          const lineCallees = calleeByLine.get(line);
          if (!lineCallees) {
            // oxlint-disable-next-line no-continue
            continue;
          }
          for (const c of lineCallees) {
            if (_SKIP_CALLEE_NAMES.has(c.callee)) {
              // oxlint-disable-next-line no-continue
              continue;
            }
            const key = `${c.callee}:${c.line}`;
            if (_seen.has(key)) {
              // oxlint-disable-next-line no-continue
              continue;
            }
            _seen.add(key);

            resolveCallee(c.callee, sym, c.receiver || null, fileContent);
            pendingEdges.push([repoId, sym.id, c.callee, _rr.calleeSymbolId, _rr.confidence, c.line]);
            totalCalls++;
          }
        }
      }
    } else {
      for (const sym of fileSymbols) {
        processRegexFallback(sym, fileContent);
      }
    }

    processedFiles++;
    if (onProgress && processedFiles % CALL_GRAPH.PROGRESS_INTERVAL_FILES === 0) {
      onProgress({ filesProcessed: processedFiles, totalFiles, callsFound: totalCalls });
    }
  }

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
    for (const edge of pendingEdges) {
      insertStmt.run(edge[0], edge[1], edge[2], edge[3], edge[4], edge[5]);
    }
  });

  return { success: true, calls: totalCalls };
}

function getCallHierarchy(db, repoId, opts) {
  const guard = _requireNativeDb(db);
  if (guard) {
    return guard;
  }
  const { symbol, direction = 'callers', depth = 3, minConfidence = 0.0 } = opts;
  if (!symbol) {
    return { error: 'Missing --symbol' };
  }

  const symRow = db
    .prepare('SELECT id, name, file_path FROM code_symbols WHERE repo_id = ? AND name = ?')
    .all(repoId, symbol);
  if (symRow.length === 0) {
    return { error: `Symbol "${symbol}" not found` };
  }

  // If multiple matches, prefer the first one (already ordered by file_path)
  // rather than hard-failing — callers can use --file to disambiguate
  const symbolId = symRow[0].id;
  const ambiguous = symRow.length > 1;

  if (direction === 'callers') {
    const rows = db
      .prepare(`
      WITH RECURSIVE upstream AS (
        SELECT cc.caller_symbol_id, cs.name, cs.file_path, 1 as depth
        FROM code_calls cc JOIN code_symbols cs ON cs.id = cc.caller_symbol_id
        WHERE cc.callee_symbol_id = ? AND cc.confidence >= ?
        UNION ALL
        SELECT cc.caller_symbol_id, cs.name, cs.file_path, u.depth + 1
        FROM code_calls cc JOIN upstream u ON cc.callee_symbol_id = u.caller_symbol_id JOIN code_symbols cs ON cs.id = cc.caller_symbol_id
        WHERE u.depth < ? AND cc.confidence >= ?
      ) SELECT * FROM upstream
    `)
      .all(symbolId, minConfidence, depth, minConfidence);
    const result = { symbol: symRow[0].name, direction: 'callers', depth, callers: rows };
    if (ambiguous) {
      result.disambiguated = true;
      result.alternative_count = symRow.length - 1;
      result.resolved_file = symRow[0].file_path;
    }
    return result;
  }

  const rows = db
    .prepare(`
    WITH RECURSIVE downstream AS (
      SELECT cc.callee_name, cc.callee_symbol_id, cs.file_path, cc.confidence, 1 as depth
      FROM code_calls cc LEFT JOIN code_symbols cs ON cs.id = cc.callee_symbol_id
      WHERE cc.caller_symbol_id = ? AND cc.confidence >= ?
      UNION ALL
      SELECT cc.callee_name, cc.callee_symbol_id, cs.file_path, cc.confidence, d.depth + 1
      FROM code_calls cc JOIN downstream d ON cc.caller_symbol_id = d.callee_symbol_id LEFT JOIN code_symbols cs ON cs.id = cc.callee_symbol_id
      WHERE d.depth < ? AND cc.confidence >= ?
    ) SELECT * FROM downstream
  `)
    .all(symbolId, minConfidence, depth, minConfidence);
  const result = { symbol: symRow[0].name, direction: 'callees', depth, callees: rows };
  if (ambiguous) {
    result.disambiguated = true;
    result.alternative_count = symRow.length - 1;
    result.resolved_file = symRow[0].file_path;
  }
  return result;
}

module.exports = {
  buildCallGraph,
  getCallHierarchy,
};
