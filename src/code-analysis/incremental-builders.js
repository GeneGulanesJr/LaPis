// Incremental builders for import graph, call graph, and complexity.

const { codeParser, _requireNativeDb, _SKIP_CALLEE_NAMES, CALL_GRAPH, COMPLEXITY } = require('./shared-deps'), { extractImportBindings, extractImportsFromSource, resolveImportTarget } = require('./import-graph-impl');


function buildImportGraphForFiles(db, repoId, changedFileIds, deletedFileIds = []) {
  const guard = _requireNativeDb(db),
  allAffected = !(guard) && !(!changedFileIds.length && !deletedFileIds.length) ? (new Set([...changedFileIds, ...deletedFileIds])) : undefined;
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
  { onProgress } = !(guard) && !(!changedFileIds.length && !deletedFileIds.length) ? (opts) : undefined,
  deletedSet = !(guard) && !(!changedFileIds.length && !deletedFileIds.length) ? (new Set(deletedFileIds)) : undefined;
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

  const staleCallers = db
    .prepare(
      `SELECT DISTINCT s.file_id FROM code_calls cc JOIN code_symbols s ON s.id = cc.caller_symbol_id WHERE cc.repo_id = ? AND cc.callee_symbol_id IS NULL`,
    )
    .all(repoId)
    .map((r) => r.file_id),
  rebuildFileIds = (() => {

  
    if (staleCallers.length > 0) {
      const stalePh = staleCallers.map(() => '?').join(',');
      db.prepare(
        `DELETE FROM code_calls WHERE repo_id = ? AND caller_symbol_id IN (SELECT id FROM code_symbols WHERE file_id IN (${stalePh})) AND callee_symbol_id IS NULL`,
      ).run(repoId, ...staleCallers);
    }
  
    
  return (new Set([...changedFileIds, ...staleCallers].filter((id) => !deletedSet.has(id))));
})(); if (rebuildFileIds.size === 0) {
    return { success: true, calls: 0, incremental: true };
  }

  // PERF(issue #131): file_path intentionally excluded — never dereferenced from allSymbols.
  // File paths are read from fileById.get(fileId).path. Including it wastes ~8 bytes per row
  // On V8 heap pointer slots that the hot loop never touches.
  const allSymbols = db
      .prepare(
        'SELECT id, name, file_id, parent_name, kind, qualified_name, start_byte, end_byte, start_line, end_line FROM code_symbols WHERE repo_id = ?',
      )
      .all(repoId),
    // PERF(issue #137): Single-pass symbol index construction — all 7 Map indices are built
    // In one iteration over allSymbols instead of 5 separate passes. For 50K symbols (~10MB),
    // This keeps the array hot in L1/L2 cache instead of re-scanning cold memory 4 extra times.
    // Derived maps (symbolsByFileAndName, methodsByParentAndName) are populated inline.
    // Do NOT split this back into separate loops — the cache behavior matters at scale.
    symbolsByName = new Map(),
    symbolsByQualified = new Map(),
    symbolsByFile = new Map(),
    symbolsByFileAndName = new Map(),
    classParentMap = new Map(),
    methodsByParent = new Map(),
    methodsByParentAndName = new Map();

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

  const fileRows = db.prepare('SELECT id, path, size_bytes FROM code_files WHERE repo_id = ?').all(repoId),
    fileById = new Map();
  for (const f of fileRows) {
    fileById.set(f.id, f);
  }
  const contentStmt = db.prepare('SELECT content FROM code_files WHERE id = ?'),
    insertStmt = db.prepare(
      `INSERT OR IGNORE INTO code_calls (repo_id, caller_symbol_id, callee_name, callee_symbol_id, confidence, line_number) VALUES (?, ?, ?, ?, ?, ?)`,
    ), fileImportsCache = {},
    fileBindingsCache = {}, _rr = { calleeSymbolId: null, confidence: 0 }, totalFiles = rebuildFileIds.size;
  let totalCalls = 0, processedFiles = 0;
  

  

  

  

  // PERF(issue #134): Pre-allocated result for resolveCallee — avoids creating a new object
  // Per call in the hot path. resolveCallee writes directly into _rr; callers read from it
  // After the call. Do NOT change resolveCallee to return a new object; the per-call
  // Allocation overhead is significant at hundreds of thousands of invocations.
  

  

  

  
  

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
      {
const meta = fileById.get(fileId);
      if (!meta) {
        processedFiles++;
        // oxlint-disable-next-line no-continue
        continue;
      }
      {
const contentRow = contentStmt.get(fileId);
      if (!contentRow || !contentRow.content) {
        processedFiles++;
        // oxlint-disable-next-line no-continue
        continue;
      }
      {
const fileContent = contentRow.content,
        filePath = meta.path,
        fileSize = fileContent.length;

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
        const calleeByLine = new Map(),
        _seen = (() => {

          for (const c of fileCallees) {
            if (!calleeByLine.has(c.line)) {
              calleeByLine.set(c.line, []);
            }
            calleeByLine.get(c.line).push(c);
          }
          // PERF(issue #134): Pre-allocated dedup Set — cleared per symbol instead of
          // Allocating a new Set. For N symbols this eliminates N Set allocations.
          
  return (new Set());
})();for (const sym of fileSymbols) {
          _seen.clear();
          for (let line = sym.start_line; line <= sym.end_line; line++) {
            const lineCallees = calleeByLine.get(line);
            // oxlint-disable-next-line no-continue
            if (!lineCallees) {
              continue;
            }
            for (const c of lineCallees) {
              // oxlint-disable-next-line no-continue
              if (_SKIP_CALLEE_NAMES.has(c.callee)) {
                continue;
              }
              const key = `${c.callee}:${c.line}`;
              // oxlint-disable-next-line no-continue
              if (_seen.has(key)) {
                continue;
              }
              _seen.add(key);
              resolveCallee(c.callee, sym, c.receiver || null, fileContent);
              insertStmt.run(repoId, sym.id, c.callee, _rr.calleeSymbolId, _rr.confidence, c.line);
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
}
}
}
  });

  return { success: true, calls: totalCalls, incremental: true, filesAffected: rebuildFileIds.size };
function getFileSymbol(fileId, name, kind) {
    const byName = symbolsByFileAndName.get(fileId),
    matches = byName ? (byName.get(name)) : undefined;
    if (!byName) {
      return null;
    }
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
    const bindings = extractImportBindings(fileContent || ''),
      imports = getFileImports(fileId),
      importMap = new Map(),
    resolved = (() => {

      for (const imp of imports) {
        importMap.set(imp.target_module, imp.target_file_id);
      }
      
  return (bindings.map((b) => ({ ...b, target_file_id: importMap.get(b.modulePath) || null })));
})();fileBindingsCache[fileId] = resolved;
    return resolved;
  }
function resolveCallee(calleeName, callerSym, receiver, fileContent) {
    _rr.calleeSymbolId = null;
    _rr.confidence = 0.5;

    const bindings = getFileBindings(callerSym.file_id, fileContent),
      bindingMatch = bindings.find((b) => b.localName === calleeName && !b.isReExport);
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
      const qualifiedName = `${callerSym.parent_name}.${calleeName}`,
        qualifiedMatches = symbolsByQualified.get(qualifiedName);
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
        const superQualified = `${parentName}.${calleeName}`,
          superMatches = symbolsByQualified.get(superQualified);
        if (superMatches && superMatches.length === 1) {
          _rr.calleeSymbolId = superMatches[0].id;
          _rr.confidence = 0.9;
          return;
        }
      }
    }

    if (receiver && receiver !== 'this' && receiver !== 'super') {
      const binding = bindings.find((b) => b.localName === receiver && !b.isReExport), qualifiedName = `${receiver}.${calleeName}`,
        qualifiedMatches = symbolsByQualified.get(qualifiedName);
      if (binding && binding.target_file_id) {
        if (binding.originalName === '*') {
          const matchSym = getFileSymbol(binding.target_file_id, calleeName, 'function');
          if (matchSym) {
            _rr.calleeSymbolId = matchSym.id;
            _rr.confidence = 0.95;
            return;
          }
        }
        const resolvedName = binding.originalName === 'default' ? receiver : binding.originalName,
          classSym = getFileSymbol(binding.target_file_id, resolvedName, 'class');
        if (classSym) {
          const parentMethods = methodsByParentAndName.get(resolvedName),
            methodSym = parentMethods ? parentMethods.get(calleeName)?.[0] || null : null;
          if (methodSym) {
            _rr.calleeSymbolId = methodSym.id;
            _rr.confidence = 0.9;
            return;
          }
        }
      }
      
      if (qualifiedMatches && qualifiedMatches.length === 1) {
        _rr.calleeSymbolId = qualifiedMatches[0].id;
        _rr.confidence = 0.85;
        return;
      }
    }

    {
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
}
function processRegexFallback(sym, fileContent) {
    if (sym.end_byte <= sym.start_byte) {
      return;
    }
    const body = Buffer.from(fileContent, 'utf-8').toString('utf-8', sym.start_byte, sym.end_byte),
    seen = !(!body || body.length < 2) ? (new Set()) : undefined,
    callPatterns = !(!body || body.length < 2) ? ([
        /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g,
        /\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g,
        /\bnew\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g,
      ]) : undefined;
    if (!body || body.length < 2) {
      return;
    }
    for (const pattern of callPatterns) {
      let match;
      pattern.lastIndex = 0;
      while ((match = pattern.exec(body)) !== null) {
        const calleeName = match[1];
        // oxlint-disable-next-line no-continue
        if (_SKIP_CALLEE_NAMES.has(calleeName)) {
          continue;
        }
        // oxlint-disable-next-line no-continue
        if (seen.has(calleeName)) {
          continue;
        }
        seen.add(calleeName);
        resolveCallee(calleeName, sym, null, fileContent);
        {
const lineNum = sym.start_line + body.substring(0, match.index).split('\n').length - 1;
        insertStmt.run(repoId, sym.id, calleeName, _rr.calleeSymbolId, _rr.confidence, lineNum);
        totalCalls++;
      }
}
    }
  }
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
        `SELECT cs.id, cs.name, cs.start_byte, cs.end_byte, cs.start_line, cs.end_line, cs.signature, cf.content as file_content
       FROM code_symbols cs JOIN code_files cf ON cf.id = cs.file_id
       WHERE cs.repo_id = ? AND cs.kind IN ('function', 'method') AND cs.file_id IN (${changedPh})`,
      )
      .all(repoId, ...changedFileIds),
    insertStmt = db.prepare(
      `INSERT OR REPLACE INTO symbol_complexity (symbol_id, cyclomatic, nesting_depth, param_count, lines_of_code, assessment) VALUES (?, ?, ?, ?, ?, ?)`,
    );

  let count = 0;
  for (const sym of symbols) {
    // oxlint-disable-next-line no-continue
    if (!sym.file_content || sym.end_byte <= sym.start_byte) {
      continue;
    }
    const body = Buffer.from(sym.file_content, 'utf-8').toString('utf-8', sym.start_byte, sym.end_byte);
    // oxlint-disable-next-line no-continue
    if (!body) {
      continue;
    }

    let cyclomatic = 1, __ternaryMatch, maxDepth = 0,
      currentDepth = 0,
      inString = false,
      stringCharCode = 0,
      templateDepth = 0, assessment = 'high';
    {
const decisionPatterns = [
      /(?<!else\s+)if\b/g,
      /\belse\s+if\b/g,
      /\bfor\b/g,
      /\bwhile\b/g,
      /\bdo\b/g,
      /\bcase\b/g,
      /\bcatch\b/g,
      /\&\&/g,
      /\|\|/g,
      /\?\?/g,
    ],
    ternaryRe = (() => {

      for (const pattern of decisionPatterns) {
        pattern.lastIndex = 0;
        const m = body.match(pattern);
        if (m) {
          cyclomatic += m.length;
        }
      }
      
  return (/\?(?:\s*[^.:])/g);
})();
    while ((_ternaryMatch = ternaryRe.exec(body)) !== null) {
      cyclomatic++;
    }

    // PERF(issue #133): CharCode fast-path — reduces branch evaluations from 6+ per byte to
    // 1 for the common case (plain code, not in string/template). Uses integer charCodeAt
    // Instead of string boxing. body.substring() replaced with charCodeAt to avoid allocation.
    // Do NOT replace charCode checks with string comparisons; the integer path is the
    // Performance-critical fast path. Template depth tracking logic is preserved as-is.
    
    for (let i = 0; i < body.length; i++) {
      const code = body.charCodeAt(i);

      if (inString) {
        if (code === stringCharCode && (i === 0 || body.charCodeAt(i - 1) !== 92)) {
          inString = false;
        }
        // oxlint-disable-next-line no-continue
        continue;
      }

      if (templateDepth === 0) {
        if (code !== 34 && code !== 39 && code !== 96 && code !== 123 && code !== 125) {
          // oxlint-disable-next-line no-continue
          continue;
        }
        if (code === 34 || code === 39) {
          inString = true;
          stringCharCode = code;
          // oxlint-disable-next-line no-continue
          continue;
        }
        if (code === 96) {
          templateDepth++;
          // oxlint-disable-next-line no-continue
          continue;
        }
        if (code === 123) {
          currentDepth++;
          if (currentDepth > maxDepth) {
            maxDepth = currentDepth;
          }
          // oxlint-disable-next-line no-continue
          continue;
        }
        if (currentDepth > 0) {
          currentDepth--;
        }
        // oxlint-disable-next-line no-continue
        continue;
      }

      if (code === 96) {
        templateDepth++;
        // oxlint-disable-next-line no-continue
        continue;
      }
      if (code === 123) {
        currentDepth++;
        if (currentDepth > maxDepth) {
          maxDepth = currentDepth;
        }
      } else if (code === 125) {
        if (currentDepth > 0) {
          currentDepth--;
        }
      }
    }

    {
const sigMatch = sym.signature ? sym.signature.match(/\(([^)]*)\)/) : null,
      paramCount = sigMatch ? sigMatch[1].split(',').filter((p) => p.trim()).length : 0,
      lines = body.split('\n'),
      codeLines = lines.filter((l) => l.trim() && !l.trim().startsWith('//')).length;
    
    if (cyclomatic <= COMPLEXITY.LOW_THRESHOLD) {
      assessment = 'low';
    } else if (cyclomatic <= COMPLEXITY.MEDIUM_THRESHOLD) {
      assessment = 'medium';
    }

    insertStmt.run(sym.id, cyclomatic, maxDepth, paramCount, codeLines, assessment);
    count++;
  }
}
}

  return { success: true, symbols: count, incremental: true };
}

module.exports = {
  buildImportGraphForFiles,
  buildCallGraphForFiles,
  buildComplexityForFiles,
};
