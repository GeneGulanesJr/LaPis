// Incremental builders for import graph, call graph, and complexity.

const { _requireNativeDb, CALL_GRAPH, COMPLEXITY, computeNestingDepth } = require('./shared-deps');
const { extractImportBindings, extractImportsFromSource, resolveImportTarget } = require('./import-graph-impl');

function buildImportGraphForFiles(db, repoId, changedFileIds, deletedFileIds = []) {
  const guard = _requireNativeDb(db);
  if (guard) {return guard;}
  if (!changedFileIds.length && !deletedFileIds.length) {
    return { success: true, edges: 0, incremental: true };
  }

  const allAffected = new Set([...changedFileIds, ...deletedFileIds]);
  if (allAffected.size > 0) {
    const ph = [...allAffected].map(() => '?').join(',');
    const importers = db
      .prepare(`SELECT DISTINCT source_file_id FROM code_imports WHERE repo_id = ? AND target_file_id IN (${ph})`)
      .all(repoId, ...allAffected);
    for (const row of importers) {allAffected.add(row.source_file_id);}
  }

  const delPh = [...allAffected].map(() => '?').join(',');
  db.prepare(`DELETE FROM code_imports WHERE repo_id = ? AND source_file_id IN (${delPh})`).run(repoId, ...allAffected);

  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO code_imports (repo_id, source_file_id, target_module, target_file_id, import_type, line_number) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const fileStmt = db.prepare('SELECT id, path, content FROM code_files WHERE id = ?');
  const deletedSet = new Set(deletedFileIds);
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
      if (deletedSet.has(fileId)) {continue;}
      const row = fileStmt.get(fileId);
      // oxlint-disable-next-line no-continue
      if (!row || !row.content) {continue;}
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
  const guard = _requireNativeDb(db);
  if (guard) {return guard;}
  if (!changedFileIds.length && !deletedFileIds.length) {
    return { success: true, calls: 0, incremental: true };
  }

  const { onProgress } = opts;
  const deletedSet = new Set(deletedFileIds);

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

  const staleCallers = db
    .prepare(
      `SELECT DISTINCT s.file_id FROM code_calls cc JOIN code_symbols s ON s.id = cc.caller_symbol_id WHERE cc.repo_id = ? AND cc.callee_symbol_id IS NULL`,
    )
    .all(repoId)
    .map((r) => r.file_id);

  if (staleCallers.length > 0) {
    const stalePh = staleCallers.map(() => '?').join(',');
    db.prepare(
      `DELETE FROM code_calls WHERE repo_id = ? AND caller_symbol_id IN (SELECT id FROM code_symbols WHERE file_id IN (${stalePh})) AND callee_symbol_id IS NULL`,
    ).run(repoId, ...staleCallers);
  }

  const rebuildFileIds = new Set(
    [...changedFileIds, ...staleCallers].filter((id) => !deletedSet.has(id)),
  );

  if (rebuildFileIds.size === 0) {
    return { success: true, calls: 0, incremental: true };
  }

  const allSymbols = db
    .prepare(
      'SELECT id, name, file_id, file_path, parent_name, kind, qualified_name, start_byte, end_byte, start_line, end_line FROM code_symbols WHERE repo_id = ?',
    )
    .all(repoId);

  const symbolsByName = new Map();
  const symbolsByQualified = new Map();
  const symbolsByFile = new Map();
  for (const sym of allSymbols) {
    if (!symbolsByName.has(sym.name)) {symbolsByName.set(sym.name, []);}
    symbolsByName.get(sym.name).push(sym);
    if (sym.qualified_name && sym.qualified_name !== sym.name) {
      if (!symbolsByQualified.has(sym.qualified_name)) {symbolsByQualified.set(sym.qualified_name, []);}
      symbolsByQualified.get(sym.qualified_name).push(sym);
    }
    if (!symbolsByFile.has(sym.file_id)) {symbolsByFile.set(sym.file_id, []);}
    symbolsByFile.get(sym.file_id).push(sym);
  }

  const fileRows = db.prepare('SELECT id, path, size_bytes FROM code_files WHERE repo_id = ?').all(repoId);
  const fileById = new Map();
  for (const f of fileRows) {fileById.set(f.id, f);}
  const contentStmt = db.prepare('SELECT content FROM code_files WHERE id = ?');

  const symbolsByFileAndName = new Map();
  for (const [fileId, syms] of symbolsByFile) {
    const byName = new Map();
    for (const s of syms) {
      if (!byName.has(s.name)) {byName.set(s.name, []);}
      byName.get(s.name).push(s);
    }
    symbolsByFileAndName.set(fileId, byName);
  }
  const classParentMap = new Map();
  for (const sym of allSymbols) {
    if (sym.kind === 'class' && sym.parent_name) {classParentMap.set(sym.name, sym.parent_name);}
  }
  const methodsByParent = new Map();
  for (const sym of allSymbols) {
    if (sym.parent_name) {
      if (!methodsByParent.has(sym.parent_name)) {methodsByParent.set(sym.parent_name, []);}
      methodsByParent.get(sym.parent_name).push(sym);
    }
  }
  const methodsByParentAndName = new Map();
  for (const [parent, methods] of methodsByParent) {
    const byName = new Map();
    for (const m of methods) {
      if (!byName.has(m.name)) {byName.set(m.name, []);}
      byName.get(m.name).push(m);
    }
    methodsByParentAndName.set(parent, byName);
  }

  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO code_calls (repo_id, caller_symbol_id, callee_name, callee_symbol_id, confidence, line_number) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  let totalCalls = 0;
  const fileImportsCache = {};
  const fileBindingsCache = {};

  function getFileSymbol(fileId, name, kind) {
    const byName = symbolsByFileAndName.get(fileId);
    if (!byName) {return null;}
    const matches = byName.get(name);
    if (!matches) {return null;}
    if (kind) {return matches.find((s) => s.kind === kind) || null;}
    return matches[0] || null;
  }

  function getFileImports(fileId) {
    if (fileImportsCache[fileId]) {return fileImportsCache[fileId];}
    const imports = db
      .prepare(
        'SELECT target_file_id, target_module FROM code_imports WHERE source_file_id = ? AND target_file_id IS NOT NULL',
      )
      .all(fileId);
    fileImportsCache[fileId] = imports;
    return imports;
  }

  function getFileBindings(fileId, fileContent) {
    if (fileBindingsCache[fileId]) {return fileBindingsCache[fileId];}
    const bindings = extractImportBindings(fileContent || '');
    const imports = getFileImports(fileId);
    const importMap = new Map();
    for (const imp of imports) {importMap.set(imp.target_module, imp.target_file_id);}
    const resolved = bindings.map((b) => ({ ...b, target_file_id: importMap.get(b.modulePath) || null }));
    fileBindingsCache[fileId] = resolved;
    return resolved;
  }

  function resolveCallee(calleeName, callerSym, receiver, fileContent) {
    let calleeSymbolId = null;
    let confidence = 0.5;

    const bindings = getFileBindings(callerSym.file_id, fileContent);
    const bindingMatch = bindings.find((b) => b.localName === calleeName && !b.isReExport);
    if (bindingMatch) {
      const originalName = bindingMatch.originalName;
      if (bindingMatch.target_file_id) {
        if (originalName === '*' || originalName === 'default') {
          const matchSym = getFileSymbol(bindingMatch.target_file_id, calleeName);
          if (matchSym) {return { calleeSymbolId: matchSym.id, confidence: 1.0, resolvedVia: 'import-binding' };}
        } else {
          const matchSym = getFileSymbol(bindingMatch.target_file_id, originalName);
          if (matchSym) {return { calleeSymbolId: matchSym.id, confidence: 1.0, resolvedVia: 'import-binding-alias' };}
        }
      }
    }

    if (receiver === 'this' && callerSym.parent_name) {
      const qualifiedName = `${callerSym.parent_name}.${calleeName}`;
      const qualifiedMatches = symbolsByQualified.get(qualifiedName);
      if (qualifiedMatches && qualifiedMatches.length === 1)
        {return { calleeSymbolId: qualifiedMatches[0].id, confidence: 0.95, resolvedVia: 'this-dispatch' };}
      if (qualifiedMatches && qualifiedMatches.length > 1) {
        const sameFile = qualifiedMatches.find((m) => m.file_id === callerSym.file_id);
        if (sameFile) {return { calleeSymbolId: sameFile.id, confidence: 0.9, resolvedVia: 'this-dispatch-same-file' };}
      }
    }

    if (receiver === 'super' && callerSym.parent_name) {
      const parentName = classParentMap.get(callerSym.parent_name);
      if (parentName) {
        const superQualified = `${parentName}.${calleeName}`;
        const superMatches = symbolsByQualified.get(superQualified);
        if (superMatches && superMatches.length === 1)
          {return { calleeSymbolId: superMatches[0].id, confidence: 0.9, resolvedVia: 'super-dispatch' };}
      }
    }

    if (receiver && receiver !== 'this' && receiver !== 'super') {
      const binding = bindings.find((b) => b.localName === receiver && !b.isReExport);
      if (binding && binding.target_file_id) {
        if (binding.originalName === '*') {
          const matchSym = getFileSymbol(binding.target_file_id, calleeName, 'function');
          if (matchSym) {return { calleeSymbolId: matchSym.id, confidence: 0.95, resolvedVia: 'namespace-member' };}
        }
        const resolvedName = binding.originalName === 'default' ? receiver : binding.originalName;
        const classSym = getFileSymbol(binding.target_file_id, resolvedName, 'class');
        if (classSym) {
          const parentMethods = methodsByParentAndName.get(resolvedName);
          const methodSym = parentMethods ? parentMethods.get(calleeName)?.[0] || null : null;
          if (methodSym) {return { calleeSymbolId: methodSym.id, confidence: 0.9, resolvedVia: 'object-type-member' };}
        }
      }
      const qualifiedName = `${receiver}.${calleeName}`;
      const qualifiedMatches = symbolsByQualified.get(qualifiedName);
      if (qualifiedMatches && qualifiedMatches.length === 1)
        {return { calleeSymbolId: qualifiedMatches[0].id, confidence: 0.85, resolvedVia: 'qualified-name' };}
    }

    const fileImports = getFileImports(callerSym.file_id);
    for (const imp of fileImports) {
      const matchSym = getFileSymbol(imp.target_file_id, calleeName);
      if (matchSym) {
        calleeSymbolId = matchSym.id;
        confidence = 0.8;
        break;
      }
    }

    if (!calleeSymbolId) {
      const sameFile = getFileSymbol(callerSym.file_id, calleeName);
      if (sameFile) {
        calleeSymbolId = sameFile.id;
        confidence = 0.9;
      }
    }

    if (!calleeSymbolId) {
      const matches = symbolsByName.get(calleeName);
      if (matches && matches.length === 1) {
        calleeSymbolId = matches[0].id;
        confidence = 0.7;
      }
    }

    return { calleeSymbolId, confidence };
  }

  function processRegexFallback(sym, fileContent) {
    if (sym.end_byte <= sym.start_byte) {return;}
    const body = Buffer.from(fileContent, 'utf-8').toString('utf-8', sym.start_byte, sym.end_byte);
    if (!body || body.length < 2) {return;}
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
        // oxlint-disable-next-line no-continue
        if (_SKIP_CALLEE_NAMES.has(calleeName)) {continue;}
        // oxlint-disable-next-line no-continue
        if (seen.has(calleeName)) {continue;}
        seen.add(calleeName);
        const { calleeSymbolId, confidence } = resolveCallee(calleeName, sym, null, fileContent);
        const lineNum = sym.start_line + body.substring(0, match.index).split('\n').length - 1;
        insertStmt.run(repoId, sym.id, calleeName, calleeSymbolId, confidence, lineNum);
        totalCalls++;
      }
    }
  }

  const totalFiles = rebuildFileIds.size;
  let processedFiles = 0;

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
    for (const fileId of rebuildFileIds) {
      const fileSymbols = symbolsByFile.get(fileId);
      if (!fileSymbols || fileSymbols.length === 0) {
        processedFiles++;
        // oxlint-disable-next-line no-continue
        continue;
      }
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
          if (!calleeByLine.has(c.line)) {calleeByLine.set(c.line, []);}
          calleeByLine.get(c.line).push(c);
        }
        for (const sym of fileSymbols) {
          const seen = new Set();
          for (let line = sym.start_line; line <= sym.end_line; line++) {
            const lineCallees = calleeByLine.get(line);
            // oxlint-disable-next-line no-continue
            if (!lineCallees) {continue;}
            for (const c of lineCallees) {
              // oxlint-disable-next-line no-continue
              if (_SKIP_CALLEE_NAMES.has(c.callee)) {continue;}
              const key = `${c.callee}:${c.line}`;
              // oxlint-disable-next-line no-continue
              if (seen.has(key)) {continue;}
              seen.add(key);
              const { calleeSymbolId, confidence } = resolveCallee(c.callee, sym, c.receiver || null, fileContent);
              insertStmt.run(repoId, sym.id, c.callee, calleeSymbolId, confidence, c.line);
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
  });

  return { success: true, calls: totalCalls, incremental: true, filesAffected: rebuildFileIds.size };
}

function buildComplexityForFiles(db, repoId, changedFileIds, deletedFileIds = []) {
  const guard = _requireNativeDb(db);
  if (guard) {return guard;}
  if (!changedFileIds.length && !deletedFileIds.length) {
    return { success: true, symbols: 0, incremental: true };
  }

  const allAffected = [...changedFileIds, ...deletedFileIds];
  const ph = allAffected.map(() => '?').join(',');
  db.prepare(
    `DELETE FROM symbol_complexity WHERE symbol_id IN (SELECT id FROM code_symbols WHERE file_id IN (${ph}))`,
  ).run(...allAffected);

  if (changedFileIds.length === 0) {
    return { success: true, symbols: 0, incremental: true };
  }

  const changedPh = changedFileIds.map(() => '?').join(',');
  const symbols = db
    .prepare(
      `SELECT cs.id, cs.name, cs.start_byte, cs.end_byte, cs.start_line, cs.end_line, cs.signature, cf.content as file_content
       FROM code_symbols cs JOIN code_files cf ON cf.id = cs.file_id
       WHERE cs.repo_id = ? AND cs.kind IN ('function', 'method') AND cs.file_id IN (${changedPh})`,
    )
    .all(repoId, ...changedFileIds);

  const insertStmt = db.prepare(
    `INSERT OR REPLACE INTO symbol_complexity (symbol_id, cyclomatic, nesting_depth, param_count, lines_of_code, assessment) VALUES (?, ?, ?, ?, ?, ?)`,
  );

  let count = 0;
  for (const sym of symbols) {
    // oxlint-disable-next-line no-continue
    if (!sym.file_content || sym.end_byte <= sym.start_byte) {continue;}
    const body = Buffer.from(sym.file_content, 'utf-8').toString('utf-8', sym.start_byte, sym.end_byte);
    // oxlint-disable-next-line no-continue
    if (!body) {continue;}

    let cyclomatic = 1;
    const decisionPatterns = [
      /\if\b/g,
      /\belse\s+if\b/g,
      /\bfor\b/g,
      /\bwhile\b/g,
      /\bdo\b/g,
      /\bcase\b/g,
      /\bcatch\b/g,
      /\&\&/g,
      /\|\|/g,
      /\?\?/g,
    ];
    for (const pattern of decisionPatterns) {
      pattern.lastIndex = 0;
      const m = body.match(pattern);
      if (m) {cyclomatic += m.length;}
    }
    const ternaryRe = /\?(?:\s*[^.:])/g;
    let __ternaryMatch;
    while ((_ternaryMatch = ternaryRe.exec(body)) !== null) {cyclomatic++;}

    const maxDepth = computeNestingDepth(body);

    const sigMatch = sym.signature ? sym.signature.match(/\(([^)]*)\)/) : null;
    const paramCount = sigMatch ? sigMatch[1].split(',').filter((p) => p.trim()).length : 0;
    const lines = body.split('\n');
    const codeLines = lines.filter((l) => l.trim() && !l.trim().startsWith('//')).length;
    let assessment = 'high';
    if (cyclomatic <= COMPLEXITY.LOW_THRESHOLD) {
      assessment = 'low';
    } else if (cyclomatic <= COMPLEXITY.MEDIUM_THRESHOLD) {
      assessment = 'medium';
    }

    insertStmt.run(sym.id, cyclomatic, maxDepth, paramCount, codeLines, assessment);
    count++;
  }

  return { success: true, symbols: count, incremental: true };
}

module.exports = {
  buildImportGraphForFiles,
  buildCallGraphForFiles,
  buildComplexityForFiles,
};
