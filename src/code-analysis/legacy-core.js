/**
 * Code-analysis.js — Import graph, call graph, dead code, complexity
 *
 * All functions receive the shared SQLite db handle.
 * Requires parse-code.js to be initialized for some features.
 */

const path = require('path');
const codeParser = require('../../parse-code');
const {
  PAGERANK, HOTSPOT_THRESHOLDS, DEAD_CODE, COMPLEXITY, COUPLING,
  RESULT_LIMITS, UNTETECTED_CONFIDENCE, PR_RISK,
} = require('../../constants');
const { requireNativeDb: _requireNativeDb, SKIP_CALLEE_NAMES: _SKIP_CALLEE_NAMES } = require('../../utils');

// ══════════════════════════════════════════════════════════
// IMPORT GRAPH
// ══════════════════════════════════════════════════════════

function extractImportsFromSource(content) {
  const imports = [];
  const seen = new Set();

  function add(mod, type, line) {
    const key = `${mod}:${line}`;
    if (!seen.has(key)) {
      seen.add(key);
      imports.push({ target_module: mod, import_type: type, line_number: line });
    }
  }

  const esRe = /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+(?:\s*,\s*\{[^}]*\})?)\s+from\s+)?['"]([^'"]+)['"]/g;
  const reExportRe = /export\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+)\s+from\s+)['"]([^'"]+)['"]/g;
  const requireRe = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const dynamicRe = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

  let match;
  while ((match = esRe.exec(content)) !== null) {
    const line = content.substring(0, match.index).split('\n').length;
    const isReExport = /^export\s/.test(match[0]);
    add(match[1], isReExport ? 're-export' : 'static', line);
  }
  while ((match = reExportRe.exec(content)) !== null) {
    const line = content.substring(0, match.index).split('\n').length;
    add(match[1], 're-export', line);
  }
  while ((match = requireRe.exec(content)) !== null) {
    const line = content.substring(0, match.index).split('\n').length;
    add(match[1], 'static', line);
  }
  while ((match = dynamicRe.exec(content)) !== null) {
    const line = content.substring(0, match.index).split('\n').length;
    add(match[1], 'dynamic', line);
  }

  return imports;
}

function extractImportBindings(content) {
  const bindings = [];

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;

    m = line.match(/^import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/);
    if (m) {
      bindings.push({ localName: m[1], originalName: 'default', modulePath: m[2], line: i + 1 });
      continue;
    }

    m = line.match(/^import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/);
    if (m) {
      bindings.push({ localName: m[1], originalName: '*', modulePath: m[2], line: i + 1 });
      continue;
    }

    const namedMatch = line.match(/^import\s+(?:([\w]+)\s*,\s*)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/);
    if (namedMatch) {
      if (namedMatch[1]) {
        bindings.push({ localName: namedMatch[1], originalName: 'default', modulePath: namedMatch[3], line: i + 1 });
      }
      const names = namedMatch[2].split(',').map((s) => s.trim()).filter(Boolean);
      for (const nameStr of names) {
        const asMatch = nameStr.match(/^(\w+)\s+as\s+(\w+)$/);
        if (asMatch) {
          bindings.push({ localName: asMatch[2], originalName: asMatch[1], modulePath: namedMatch[3], line: i + 1 });
        } else {
          bindings.push({ localName: nameStr, originalName: nameStr, modulePath: namedMatch[3], line: i + 1 });
        }
      }
      continue;
    }

    const reExportNamed = line.match(/^export\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/);
    if (reExportNamed) {
      const names = reExportNamed[1].split(',').map((s) => s.trim()).filter(Boolean);
      for (const nameStr of names) {
        const asMatch = nameStr.match(/^(\w+)\s+as\s+(\w+)$/);
        if (asMatch) {
          bindings.push({ localName: asMatch[2], originalName: asMatch[1], modulePath: reExportNamed[2], line: i + 1, isReExport: true });
        } else {
          bindings.push({ localName: nameStr, originalName: nameStr, modulePath: reExportNamed[2], line: i + 1, isReExport: true });
        }
      }
      continue;
    }

    m = line.match(/^(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (m) {
      bindings.push({ localName: m[1], originalName: '*', modulePath: m[2], line: i + 1 });
      continue;
    }

    const destructureRequire = line.match(/^(?:const|let|var)\s+\{([^}]+)\}\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (destructureRequire) {
      const names = destructureRequire[1].split(',').map((s) => s.trim()).filter(Boolean);
      for (const nameStr of names) {
        const asMatch = nameStr.match(/^(\w+)\s*:\s*(\w+)$/);
        if (asMatch) {
          bindings.push({ localName: asMatch[2], originalName: asMatch[1], modulePath: destructureRequire[2], line: i + 1 });
        } else {
          bindings.push({ localName: nameStr, originalName: nameStr, modulePath: destructureRequire[2], line: i + 1 });
        }
      }
      continue;
    }
  }

  return bindings;
}

function resolveImportTarget(db, repoId, sourceFilePath, targetModule) {
  if (!targetModule.startsWith('.') && !targetModule.startsWith('/')) {return null;}

  const sourceDir = path.dirname(sourceFilePath);
  const resolved = path.resolve(sourceDir, targetModule);

  const candidates = [
    resolved,
    `${resolved  }.js`,
    `${resolved  }.mjs`,
    `${resolved  }.cjs`,
    `${resolved  }.ts`,
    `${resolved  }.mts`,
    `${resolved  }.cts`,
    `${resolved  }.tsx`,
    path.join(resolved, 'index.js'),
    path.join(resolved, 'index.ts'),
    path.join(resolved, 'index.tsx'),
  ];

  for (const candidate of candidates) {
    const row = db.prepare('SELECT id FROM code_files WHERE repo_id = ? AND path = ?').get(repoId, candidate);
    if (row) {return row.id;}
  }
  return null;
}

function buildImportGraph(db, repoId) {
  const guard = _requireNativeDb(db);
  if (guard) {return guard;}
  db.prepare('DELETE FROM code_imports WHERE repo_id = ?').run(repoId);

  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO code_imports (repo_id, source_file_id, target_module, target_file_id, import_type, line_number) VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const files = db.prepare('SELECT id, path, content FROM code_files WHERE repo_id = ?').all(repoId);
  let totalEdges = 0;

  for (const file of files) {
    if (!file.content) {continue;}
    const imports = extractImportsFromSource(file.content);
    for (const imp of imports) {
      const targetFileId = resolveImportTarget(db, repoId, file.path, imp.target_module);
      insertStmt.run(repoId, file.id, imp.target_module, targetFileId, imp.import_type, imp.line_number);
      totalEdges++;
    }
  }

  return { success: true, edges: totalEdges };
}

function getImportGraph(db, repoId, opts) {
  const guard = _requireNativeDb(db);
  if (guard) {return guard;}
  const { file, direction = 'both', depth = 1 } = opts;

  if (depth <= 1 && file) {
    const fileRow = db.prepare('SELECT id FROM code_files WHERE repo_id = ? AND path LIKE ?').get(repoId, `%${file}%`);
    if (!fileRow) {return { error: `File not found: ${file}` };}

    const edges = db
      .prepare(`
      SELECT ci.import_type, ci.line_number, ci.target_module, sf.path as source_file, tf.path as target_file
      FROM code_imports ci JOIN code_files sf ON sf.id = ci.source_file_id LEFT JOIN code_files tf ON tf.id = ci.target_file_id
      WHERE ci.repo_id = ? AND (ci.source_file_id = ? OR ci.target_file_id = ?)
    `)
      .all(repoId, fileRow.id, fileRow.id);

    return {
      edges: edges.map((r) => ({
        source: r.source_file,
        target: r.target_file || r.target_module,
        type: r.import_type,
        line: r.line_number,
      })),
    };
  }

  if (depth > 1 && file) {
    const fileRow = db.prepare('SELECT id FROM code_files WHERE repo_id = ? AND path LIKE ?').get(repoId, `%${file}%`);
    if (!fileRow) {return { error: `File not found: ${file}` };}

    const result = {};
    if (direction === 'imports' || direction === 'both') {
      result.downstream = db
        .prepare(`
        WITH RECURSIVE deps AS (
          SELECT target_file_id as file_id, 1 as depth FROM code_imports WHERE source_file_id = ? AND target_file_id IS NOT NULL
          UNION ALL SELECT ci.target_file_id, d.depth + 1 FROM code_imports ci JOIN deps d ON ci.source_file_id = d.file_id WHERE d.depth < ? AND ci.target_file_id IS NOT NULL
        ) SELECT DISTINCT cf.path, d.depth FROM deps d JOIN code_files cf ON cf.id = d.file_id
      `)
        .all(fileRow.id, depth);
    }
    if (direction === 'importers' || direction === 'both') {
      result.upstream = db
        .prepare(`
        WITH RECURSIVE imp AS (
          SELECT source_file_id as file_id, 1 as depth FROM code_imports WHERE target_file_id = ? AND source_file_id IS NOT NULL
          UNION ALL SELECT ci.source_file_id, u.depth + 1 FROM code_imports ci JOIN imp u ON ci.target_file_id = u.file_id WHERE u.depth < ? AND ci.source_file_id IS NOT NULL
        ) SELECT DISTINCT cf.path, u.depth FROM imp u JOIN code_files cf ON cf.id = u.file_id
      `)
        .all(fileRow.id, depth);
    }
    return result;
  }

  // Repo-wide: just return all edges
  const edges = db
    .prepare(`
    SELECT ci.import_type, ci.target_module, sf.path as source_file, tf.path as target_file
    FROM code_imports ci JOIN code_files sf ON sf.id = ci.source_file_id LEFT JOIN code_files tf ON tf.id = ci.target_file_id
    WHERE ci.repo_id = ? LIMIT ${RESULT_LIMITS.IMPORT_GRAPH_MAX}
  `)
    .all(repoId);

  return {
    edges: edges.map((r) => ({ source: r.source_file, target: r.target_file || r.target_module, type: r.import_type })),
  };
}

// ══════════════════════════════════════════════════════════
// CALL GRAPH
// ══════════════════════════════════════════════════════════

function buildCallGraph(db, repoId) {
  const guard = _requireNativeDb(db);
  if (guard) {return guard;}
  db.prepare('DELETE FROM code_calls WHERE repo_id = ?').run(repoId);

  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO code_calls (repo_id, caller_symbol_id, callee_name, callee_symbol_id, confidence, line_number) VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const symbols = db
    .prepare(`
    SELECT cs.id, cs.name, cs.file_id, cs.file_path, cs.start_byte, cs.end_byte, cs.start_line, cs.end_line,
           cs.parent_name, cs.kind, cs.qualified_name, cf.content as file_content
    FROM code_symbols cs JOIN code_files cf ON cf.id = cs.file_id WHERE cs.repo_id = ?
  `)
    .all(repoId);

  const allSymbols = db.prepare('SELECT id, name, file_id, file_path, parent_name, kind, qualified_name FROM code_symbols WHERE repo_id = ?').all(repoId);
  const symbolsByName = new Map();
  const symbolsByQualified = new Map();
  for (const sym of allSymbols) {
    if (!symbolsByName.has(sym.name)) {symbolsByName.set(sym.name, []);}
    symbolsByName.get(sym.name).push(sym);
    if (sym.qualified_name && sym.qualified_name !== sym.name) {
      if (!symbolsByQualified.has(sym.qualified_name)) {symbolsByQualified.set(sym.qualified_name, []);}
      symbolsByQualified.get(sym.qualified_name).push(sym);
    }
  }

  let totalCalls = 0;

  const fileImportsCache = {};
  const fileBindingsCache = {};

  // Pre-load per-file symbol maps to eliminate N+1 queries in resolveCallee
  const symbolsByFile = new Map();
  for (const sym of allSymbols) {
    if (!symbolsByFile.has(sym.file_id)) {symbolsByFile.set(sym.file_id, []);}
    symbolsByFile.get(sym.file_id).push(sym);
  }
  const symbolsByFileAndName = new Map();
  for (const [fileId, syms] of symbolsByFile) {
    const byName = new Map();
    for (const s of syms) {
      if (!byName.has(s.name)) {byName.set(s.name, []);}
      byName.get(s.name).push(s);
    }
    symbolsByFileAndName.set(fileId, byName);
  }
  // Pre-load class → parent_name map for super dispatch
  const classParentMap = new Map();
  for (const sym of allSymbols) {
    if (sym.kind === 'class' && sym.parent_name) {classParentMap.set(sym.name, sym.parent_name);}
  }
  // Pre-load parent_name → child symbols for method dispatch
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
      .prepare('SELECT target_file_id, target_module FROM code_imports WHERE source_file_id = ? AND target_file_id IS NOT NULL')
      .all(fileId);
    fileImportsCache[fileId] = imports;
    return imports;
  }

  function getFileBindings(fileId, fileContent) {
    if (fileBindingsCache[fileId]) {return fileBindingsCache[fileId];}
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
          if (matchSym) {
            return { calleeSymbolId: matchSym.id, confidence: 1.0, resolvedVia: 'import-binding' };
          }
        } else {
          const matchSym = getFileSymbol(bindingMatch.target_file_id, originalName);
          if (matchSym) {
            return { calleeSymbolId: matchSym.id, confidence: 1.0, resolvedVia: 'import-binding-alias' };
          }
        }
      }
    }

    if (receiver === 'this' && callerSym.parent_name) {
      const qualifiedName = `${callerSym.parent_name}.${calleeName}`;
      const qualifiedMatches = symbolsByQualified.get(qualifiedName);
      if (qualifiedMatches && qualifiedMatches.length === 1) {
        return { calleeSymbolId: qualifiedMatches[0].id, confidence: 0.95, resolvedVia: 'this-dispatch' };
      }
      if (qualifiedMatches && qualifiedMatches.length > 1) {
        const sameFile = qualifiedMatches.find((m) => m.file_id === callerSym.file_id);
        if (sameFile) {
          return { calleeSymbolId: sameFile.id, confidence: 0.90, resolvedVia: 'this-dispatch-same-file' };
        }
      }
    }

    if (receiver === 'super' && callerSym.parent_name) {
      const parentName = classParentMap.get(callerSym.parent_name);
      if (parentName) {
        const superQualified = `${parentName}.${calleeName}`;
        const superMatches = symbolsByQualified.get(superQualified);
        if (superMatches && superMatches.length === 1) {
          return { calleeSymbolId: superMatches[0].id, confidence: 0.90, resolvedVia: 'super-dispatch' };
        }
      }
    }

    if (receiver && receiver !== 'this' && receiver !== 'super') {
      const binding = bindings.find((b) => b.localName === receiver && !b.isReExport);
      if (binding && binding.target_file_id) {
        if (binding.originalName === '*') {
          const matchSym = getFileSymbol(binding.target_file_id, calleeName, 'function');
          if (matchSym) {
            return { calleeSymbolId: matchSym.id, confidence: 0.95, resolvedVia: 'namespace-member' };
          }
        }
        const resolvedName = binding.originalName === 'default' ? receiver : binding.originalName;
        const classSym = getFileSymbol(binding.target_file_id, resolvedName, 'class');
        if (classSym) {
          const parentMethods = methodsByParentAndName.get(resolvedName);
          const methodSym = parentMethods ? (parentMethods.get(calleeName)?.[0] || null) : null;
          if (methodSym) {
            return { calleeSymbolId: methodSym.id, confidence: 0.90, resolvedVia: 'object-type-member' };
          }
        }
      }

      const qualifiedName = `${receiver}.${calleeName}`;
      const qualifiedMatches = symbolsByQualified.get(qualifiedName);
      if (qualifiedMatches && qualifiedMatches.length === 1) {
        return { calleeSymbolId: qualifiedMatches[0].id, confidence: 0.85, resolvedVia: 'qualified-name' };
      }
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

  for (const sym of symbols) {
    if (!sym.file_content || sym.end_byte <= sym.start_byte) {continue;}

    let astCallees = [];
    try {
      const allCallees = codeParser.extractCallees(sym.file_path);
      astCallees = allCallees.filter((c) => c.line >= sym.start_line && c.line <= sym.end_line);
    } catch (_) {
      astCallees = [];
    }

    const seen = new Set();

    if (astCallees.length > 0) {
      for (const c of astCallees) {
        if (_SKIP_CALLEE_NAMES.has(c.callee)) {continue;}
        const key = `${c.callee}:${c.line}`;
        if (seen.has(key)) {continue;}
        seen.add(key);

        const { calleeSymbolId, confidence } = resolveCallee(
          c.callee, sym, c.receiver || null, sym.file_content
        );
        insertStmt.run(repoId, sym.id, c.callee, calleeSymbolId, confidence, c.line);
        totalCalls++;
      }
    } else {
      const body = Buffer.from(sym.file_content, 'utf-8').toString('utf-8', sym.start_byte, sym.end_byte);
      if (!body || body.length < 2) {continue;}

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
          if (_SKIP_CALLEE_NAMES.has(calleeName)) {continue;}
          if (seen.has(calleeName)) {continue;}
          seen.add(calleeName);

          const { calleeSymbolId, confidence } = resolveCallee(
            calleeName, sym, null, sym.file_content
          );
          const lineNum = sym.start_line + body.substring(0, match.index).split('\n').length - 1;
          insertStmt.run(repoId, sym.id, calleeName, calleeSymbolId, confidence, lineNum);
          totalCalls++;
        }
      }
    }
  }

  return { success: true, calls: totalCalls };
}

function getCallHierarchy(db, repoId, opts) {
  const guard = _requireNativeDb(db);
  if (guard) {return guard;}
  const { symbol, direction = 'callers', depth = 3, minConfidence = 0.0 } = opts;
  if (!symbol) {return { error: 'Missing --symbol' };}

  const symRow = db
    .prepare('SELECT id, name, file_path FROM code_symbols WHERE repo_id = ? AND name = ?')
    .all(repoId, symbol);
  if (symRow.length === 0) {return { error: `Symbol "${symbol}" not found` };}
  if (symRow.length > 1) {return { error: `Multiple symbols named "${symbol}"`, candidates: symRow };}

  const symbolId = symRow[0].id;

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
    return { symbol: symRow[0].name, direction: 'callers', depth, callers: rows };
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
  return { symbol: symRow[0].name, direction: 'callees', depth, callees: rows };
}

// ══════════════════════════════════════════════════════════
// BLAST RADIUS
// ══════════════════════════════════════════════════════════

function getBlastRadius(db, repoId, opts) {
  const guard = _requireNativeDb(db);
  if (guard) {return guard;}
  const { symbol, depth = 3, minConfidence = 0.7 } = opts;
  if (!symbol) {return { error: 'Missing --symbol' };}

  const symRow = db
    .prepare('SELECT id, name, file_id, file_path FROM code_symbols WHERE repo_id = ? AND name = ?')
    .all(repoId, symbol);
  if (symRow.length === 0) {return { error: `Symbol "${symbol}" not found` };}
  if (symRow.length > 1) {return { error: `Multiple symbols named "${symbol}"`, candidates: symRow };}

  const symbolId = symRow[0].id;
  const fileId = symRow[0].file_id;

  const callers = db
    .prepare(`
    WITH RECURSIVE upstream AS (
      SELECT cc.caller_symbol_id, cs.name, cs.file_path, cc.confidence, 1 as depth
      FROM code_calls cc JOIN code_symbols cs ON cs.id = cc.caller_symbol_id
      WHERE cc.callee_symbol_id = ? AND cc.confidence >= ?
      UNION ALL
      SELECT cc.caller_symbol_id, cs.name, cs.file_path, cc.confidence, u.depth + 1
      FROM code_calls cc JOIN upstream u ON cc.callee_symbol_id = u.caller_symbol_id JOIN code_symbols cs ON cs.id = cc.caller_symbol_id
      WHERE u.depth < ? AND cc.confidence >= ?
    ) SELECT * FROM upstream
  `)
    .all(symbolId, minConfidence, depth, minConfidence);

  const fileImporters = db
    .prepare(`
    WITH RECURSIVE imp AS (
      SELECT ci.source_file_id, cf.path, 1 as depth FROM code_imports ci JOIN code_files cf ON cf.id = ci.source_file_id WHERE ci.target_file_id = ? AND ci.target_file_id IS NOT NULL
      UNION ALL SELECT ci.source_file_id, cf.path, u.depth + 1 FROM code_imports ci JOIN imp u ON ci.target_file_id = u.source_file_id JOIN code_files cf ON cf.id = ci.source_file_id WHERE u.depth < ? AND ci.target_file_id IS NOT NULL
    ) SELECT DISTINCT path, depth FROM imp
  `)
    .all(fileId, depth);

  return {
    symbol: symRow[0].name,
    file: symRow[0].file_path,
    callers,
    file_importers: fileImporters,
    affected_files: [...new Set([...callers.map((c) => c.file_path), ...fileImporters.map((f) => f.path)])],
    min_confidence: minConfidence,
  };
}

// ══════════════════════════════════════════════════════════
// DEAD CODE
// ══════════════════════════════════════════════════════════

function getDeadCode(db, repoId, opts) {
  const guard = _requireNativeDb(db);
  if (guard) {return guard;}
  const minConfidence = opts.minConfidence || DEAD_CODE.DEFAULT_MIN_CONFIDENCE;
  const includeTests = opts.includeTests || false;

  // ── Gather entry points ──
  const entryFiles = new Set();

  // 1. Filename patterns
  const entryPatterns = [
    '%main.js',
    '%index.js',
    '%index.ts',
    '%mod.ts',
    '%cli.js',
    '%app.js',
    '%app.ts',
    '%server.js',
    '%server.ts',
  ];
  for (const pattern of entryPatterns) {
    const rows = db.prepare('SELECT id FROM code_files WHERE repo_id = ? AND path LIKE ?').all(repoId, pattern);
    for (const r of rows) {entryFiles.add(r.id);}
  }

  // 2. Shebang files
  const shebangFiles = db
    .prepare("SELECT id FROM code_files WHERE repo_id = ? AND content LIKE '#!/usr/bin/env%'")
    .all(repoId);
  for (const r of shebangFiles) {entryFiles.add(r.id);}

  // 3. export default
  const exportDefaultFiles = db
    .prepare("SELECT id FROM code_files WHERE repo_id = ? AND content LIKE '%export default%'")
    .all(repoId);
  for (const r of exportDefaultFiles) {entryFiles.add(r.id);}

  // 4. package.json bin/main/exports fields
  const packageJsonFiles = db
    .prepare("SELECT id, path, content FROM code_files WHERE repo_id = ? AND path LIKE '%/package.json'")
    .all(repoId);
  for (const pkg of packageJsonFiles) {
    try {
      const pkgData = JSON.parse(pkg.content);
      if (pkgData.main) {
        const mainRow = db
          .prepare('SELECT id FROM code_files WHERE repo_id = ? AND path LIKE ?')
          .get(repoId, `%${pkgData.main}%`);
        if (mainRow) {entryFiles.add(mainRow.id);}
      }
      if (pkgData.bin) {
        const bins = typeof pkgData.bin === 'string' ? [pkgData.bin] : Object.values(pkgData.bin);
        for (const bin of bins) {
          const binRow = db
            .prepare('SELECT id FROM code_files WHERE repo_id = ? AND path LIKE ?')
            .get(repoId, `%${bin}%`);
          if (binRow) {entryFiles.add(binRow.id);}
        }
      }
    } catch (_) {}
  }

  // 5. Barrel files (index.js/ts that re-export other modules)
  const barrelFiles = db
    .prepare(
      "SELECT source_file_id as file_id FROM code_imports WHERE import_type = 're-export' AND repo_id = ? GROUP BY source_file_id",
    )
    .all(repoId);
  for (const b of barrelFiles) {entryFiles.add(b.file_id);}

  // ── BFS from entry points through import graph ──
  const reachable = new Set(entryFiles);
  const queue = [...entryFiles];
  while (queue.length > 0) {
    const current = queue.shift();
    const importers = db
      .prepare(
        'SELECT DISTINCT source_file_id FROM code_imports WHERE target_file_id = ? AND source_file_id IS NOT NULL',
      )
      .all(current);
    for (const imp of importers) {
      if (!reachable.has(imp.source_file_id)) {
        reachable.add(imp.source_file_id);
        queue.push(imp.source_file_id);
      }
    }
  }

  const allFiles = db.prepare('SELECT id, path FROM code_files WHERE repo_id = ?').all(repoId);
  const deadFiles = allFiles.filter((f) => !reachable.has(f.id));
  const deadFileSet = new Set(deadFiles.map((f) => f.id));

  // ── Symbols with zero callers ──
  const uncalledSymbols = db
    .prepare(`
    SELECT cs.id, cs.name, cs.file_path, cs.kind, cs.file_id FROM code_symbols cs
    WHERE cs.repo_id = ? AND cs.id NOT IN (SELECT callee_symbol_id FROM code_calls WHERE callee_symbol_id IS NOT NULL AND repo_id = ?)
  `)
    .all(repoId, repoId);

  // ── Symbols that are re-exported (barrel exports) ──
  const reExportedNames = new Set();
  const reExports = db
    .prepare(
      "SELECT fi.path, ci.target_module FROM code_imports ci JOIN code_files fi ON fi.id = ci.source_file_id WHERE ci.import_type = 're-export' AND ci.repo_id = ?",
    )
    .all(repoId);
  for (const re of reExports) {reExportedNames.add(re.target_module);}

  const results = [];
  for (const sym of uncalledSymbols) {
    const isFileDead = deadFileSet.has(sym.file_id);
    const isReExported = db
      .prepare("SELECT 1 FROM code_imports WHERE target_file_id = ? AND import_type = 're-export' LIMIT 1")
      .get(sym.file_id);
    const isNameReExported = reExportedNames.has(sym.name);

    let confidence = 0;
    const signals = [];
    if (!isReExported && !isNameReExported) {
      confidence += DEAD_CODE.NO_CALLERS_WEIGHT;
      signals.push('no_callers');
    }
    if (isFileDead) {
      confidence += DEAD_CODE.UNREACHABLE_FILE_WEIGHT;
      signals.push('unreachable_file');
    }
    if (isNameReExported) {
      confidence -= DEAD_CODE.RE_EXPORTED_PENALTY;
      signals.push('re_exported');
    }

    if (!includeTests && /test|spec|__tests__|\.test\./.test(sym.file_path)) {continue;}
    if (confidence >= minConfidence) {
      results.push({
        symbol_id: sym.id,
        name: sym.name,
        kind: sym.kind,
        file: sym.file_path,
        confidence: Math.round(confidence * 100) / 100,
        signals,
      });
    }
  }

  return {
    dead_files: deadFiles.map((f) => ({ id: f.id, path: f.path })),
    dead_symbols: results,
    total_symbols: allFiles.length,
  };
}

// ══════════════════════════════════════════════════════════
// COMPLEXITY
// ══════════════════════════════════════════════════════════

function buildComplexity(db, repoId) {
  const guard = _requireNativeDb(db);
  if (guard) {return guard;}
  db.prepare('DELETE FROM symbol_complexity WHERE symbol_id IN (SELECT id FROM code_symbols WHERE repo_id = ?)').run(
    repoId,
  );

  const insertStmt = db.prepare(
    `INSERT OR REPLACE INTO symbol_complexity (symbol_id, cyclomatic, nesting_depth, param_count, lines_of_code, assessment) VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const symbols = db
    .prepare(`
    SELECT cs.id, cs.name, cs.start_byte, cs.end_byte, cs.start_line, cs.end_line, cs.signature, cf.content as file_content
    FROM code_symbols cs JOIN code_files cf ON cf.id = cs.file_id WHERE cs.repo_id = ? AND cs.kind IN ('function', 'method')
  `)
    .all(repoId);

  let count = 0;
  for (const sym of symbols) {
    if (!sym.file_content || sym.end_byte <= sym.start_byte) {continue;}
    const body = Buffer.from(sym.file_content, 'utf-8').toString('utf-8', sym.start_byte, sym.end_byte);
    if (!body) {continue;}

    let cyclomatic = 1;
    const decisionPatterns = [
      /if\b/g,
      /else\s+if\b/g,
      /\bfor\b/g,
      /\bwhile\b/g,
      /\bdo\b/g,
      /\bcase\b/g,
      /\bcatch\b/g,
      /\&\&/g,
      /\|\|/g,
      /\?\?/g,
    ];
    // Note: optional chaining (?.) is NOT a decision point per spec
    for (const pattern of decisionPatterns) {
      pattern.lastIndex = 0;
      const m = body.match(pattern);
      if (m) {cyclomatic += m.length;}
    }
    // Ternary (?:) — count only if not followed by . (to exclude ?.)
    const ternaryRe = /\?(?:\s*[^.:])/g;
    let ternaryMatch;
    while ((ternaryMatch = ternaryRe.exec(body)) !== null) {
      cyclomatic++;
    }

    // V5.1: String-aware brace counting for nesting depth
    let maxDepth = 0,
      currentDepth = 0;
    let inString = false,
      stringChar = '',
      templateDepth = 0;
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      const prev = i > 0 ? body[i - 1] : '';

      // Handle string literals (skip braces inside them)
      if (!inString && templateDepth === 0 && (ch === '"' || ch === "'")) {
        inString = true;
        stringChar = ch;
        continue;
      }
      if (inString && ch === stringChar && prev !== '\\') {
        inString = false;
        continue;
      }
      // Handle template literals (${...} inside backtick strings)
      if (!inString && ch === '`') {
        templateDepth++;
        continue;
      }
      if (templateDepth === 1 && ch === '`') {
        templateDepth--;
        continue;
      }

      if (!inString || templateDepth > 0) {
        if (ch === '{') {
          currentDepth++;
          maxDepth = Math.max(maxDepth, currentDepth);
        }
        if (ch === '}') {
          if (templateDepth > 0 && body.substring(i - 1, i + 1) === '}') {
            // Template expression ${...}
            currentDepth++;
            maxDepth = Math.max(maxDepth, currentDepth);
          }
          if (currentDepth > 0) {currentDepth--;}
        }
      }
    }

    const sigMatch = sym.signature ? sym.signature.match(/\(([^)]*)\)/) : null;
    const paramCount = sigMatch ? sigMatch[1].split(',').filter((p) => p.trim()).length : 0;
    const lines = body.split('\n');
    const codeLines = lines.filter((l) => l.trim() && !l.trim().startsWith('//')).length;
    const assessment = cyclomatic <= COMPLEXITY.LOW_THRESHOLD ? 'low' : cyclomatic <= COMPLEXITY.MEDIUM_THRESHOLD ? 'medium' : 'high';

    insertStmt.run(sym.id, cyclomatic, maxDepth, paramCount, codeLines, assessment);
    count++;
  }

  return { success: true, symbols: count };
}

function getComplexity(db, repoId, symbolId) {
  const guard = _requireNativeDb(db);
  if (guard) {return guard;}
  if (symbolId) {
    const row = db
      .prepare(
        'SELECT sc.*, cs.name, cs.file_path FROM symbol_complexity sc JOIN code_symbols cs ON cs.id = sc.symbol_id WHERE sc.symbol_id = ?',
      )
      .get(symbolId);
    if (!row) {return { error: 'Complexity not computed' };}
    return row;
  }
  return db
    .prepare(
      'SELECT sc.*, cs.name, cs.file_path FROM symbol_complexity sc JOIN code_symbols cs ON cs.id = sc.symbol_id WHERE cs.repo_id = ? ORDER BY sc.cyclomatic DESC',
    )
    .all(repoId);
}

// ══════════════════════════════════════════════════════════
// FILE OUTLINE
// ══════════════════════════════════════════════════════════

function getFileOutline(db, repoId, filePath) {
  const guard = _requireNativeDb(db);
  if (guard) {return guard;}
  const fileRow = db
    .prepare('SELECT id FROM code_files WHERE repo_id = ? AND path LIKE ?')
    .get(repoId, `%${filePath}%`);
  if (!fileRow) {
    // Suggest available files that partially match
    const suggestions = db
      .prepare('SELECT path FROM code_files WHERE repo_id = ? AND path LIKE ? LIMIT 20')
      .all(repoId, `%${filePath.split('/').pop()}%`);
    const totalFiles = db
      .prepare('SELECT COUNT(*) as cnt FROM code_files WHERE repo_id = ?')
      .get(repoId).cnt;
    if (suggestions.length) {
      return {
        file: filePath,
        classes: [],
        standalone: [],
        not_found: true,
        message: `File not found: "${filePath}". Did you mean one of these?`,
        suggestions: suggestions.map(s => s.path),
        total_files_in_repo: totalFiles,
        hint: `Files are resolved relative to the repo root. List all files with: memory-store.js outline --repo <repo> (no --file)`
      };
    }
    return {
      file: filePath,
      classes: [],
      standalone: [],
      not_found: true,
      message: `File not found: "${filePath}" in repo. ${totalFiles} files indexed.`,
      total_files_in_repo: totalFiles,
      hint: `Use --file with a path relative to the repo root.`
    };
  }

  const symbols = db
    .prepare(`
    SELECT cs.id, cs.name, cs.kind, cs.start_line, cs.end_line, cs.signature, cs.qualified_name, cs.parent_name,
           sc.cyclomatic, sc.assessment
    FROM code_symbols cs LEFT JOIN symbol_complexity sc ON sc.symbol_id = cs.id
    WHERE cs.repo_id = ? AND cs.file_path LIKE ? ORDER BY cs.start_line
  `)
    .all(repoId, `%${filePath}%`);

  const classes = [];
  const standalone = [];
  for (const sym of symbols) {
    if (sym.parent_name) {
      let cls = classes.find((c) => c.name === sym.parent_name);
      if (!cls) {
        cls = { name: sym.parent_name, methods: [] };
        classes.push(cls);
      }
      cls.methods.push(sym);
    } else {
      standalone.push(sym);
    }
  }

  return { file: filePath, classes, standalone };
}

// ══════════════════════════════════════════════════════════
// HOTSPOTS (complexity × churn)
// ══════════════════════════════════════════════════════════

function getHotspots(db, repoId, opts = {}) {
  const guard = _requireNativeDb(db);
  if (guard) {return guard;}
  const topN = opts.top || RESULT_LIMITS.HOTSPOTS_DEFAULT_TOP;
  const days = opts.days || 90;

  const churnCount = db
    .prepare('SELECT count(*) as c FROM churn_metrics WHERE repo_id = ? AND window_days = ?')
    .get(repoId, days);
  if (!churnCount || churnCount.c === 0) {
    return { hotspots: [], note: 'No churn data. Run `churn --repo X` first to populate git history metrics.' };
  }

  const rows = db
    .prepare(`
    SELECT
      cs.name,
      cs.kind,
      cs.file_path,
      sc.cyclomatic,
      sc.nesting_depth,
      cm.commits,
      cm.churn_per_week,
      cm.unique_authors,
      ROUND(sc.cyclomatic * LOG(1 + cm.commits), 2) as hotspot_score,
      CASE
        WHEN sc.cyclomatic * LOG(1 + cm.commits) >= ${HOTSPOT_THRESHOLDS.CRITICAL} THEN 'critical'
        WHEN sc.cyclomatic * LOG(1 + cm.commits) >= ${HOTSPOT_THRESHOLDS.HIGH} THEN 'high'
        WHEN sc.cyclomatic * LOG(1 + cm.commits) >= ${HOTSPOT_THRESHOLDS.MEDIUM} THEN 'medium'
        ELSE 'low'
      END as risk
    FROM symbol_complexity sc
    JOIN code_symbols cs ON cs.id = sc.symbol_id
    JOIN churn_metrics cm ON cm.repo_id = cs.repo_id AND (cs.file_path = cm.file_path OR cs.file_path LIKE '%/' || cm.file_path)
    WHERE cs.repo_id = ? AND cm.window_days = ?
    ORDER BY hotspot_score DESC
    LIMIT ?
  `)
    .all(repoId, days, topN);

  return { hotspots: rows };
}

// ══════════════════════════════════════════════════════════
// DEPENDENCY CYCLES (Tarjan's SCC on import graph)
// ══════════════════════════════════════════════════════════

function getDependencyCycles(db, repoId) {
  const guard = _requireNativeDb(db);
  if (guard) {return guard;}
  // Build adjacency list from import edges (source → target)
  const edges = db
    .prepare(`
    SELECT DISTINCT cf_source.path as source, cf_target.path as target
    FROM code_imports ci
    JOIN code_files cf_source ON cf_source.id = ci.source_file_id
    JOIN code_files cf_target ON cf_target.id = ci.target_file_id
    WHERE ci.repo_id = ? AND ci.target_file_id IS NOT NULL
  `)
    .all(repoId);

  const adj = new Map();
  const allNodes = new Set();
  for (const e of edges) {
    if (!adj.has(e.source)) {adj.set(e.source, []);}
    adj.get(e.source).push(e.target);
    allNodes.add(e.source);
    allNodes.add(e.target);
  }

  // Tarjan's SCC
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const indices = new Map();
  const lowlink = new Map();
  const sccs = [];

  function strongconnect(v) {
    indices.set(v, index);
    lowlink.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    for (const w of adj.get(v) || []) {
      if (!indices.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v), lowlink.get(w)));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v), indices.get(w)));
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const scc = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1) {sccs.push(scc);}
    }
  }

  for (const v of allNodes) {
    if (!indices.has(v)) {strongconnect(v);}
  }

  // Find actual cycles (paths that close the loop)
  const cycles = sccs.map((scc) => {
    const sccSet = new Set(scc);
    const cycleEdges = [];
    for (const node of scc) {
      for (const neighbor of adj.get(node) || []) {
        if (sccSet.has(neighbor)) {
          cycleEdges.push({ from: node, to: neighbor });
        }
      }
    }
    return { files: scc, edges: cycleEdges, size: scc.length };
  });

  return {
    cycles: cycles.sort((a, b) => b.size - a.size),
    total_circular_files: cycles.reduce((sum, c) => sum + c.size, 0),
  };
}

// PageRank cache — shared between getSymbolImportance and winnow
// Key: repoId, auto-invalidates on reindex via head_commit change
// Bounded LRU: evicts oldest entry when MAX_CACHE_SIZE is exceeded
const MAX_PAGE_RANK_CACHE_SIZE = PAGERANK.MAX_CACHE_SIZE;
const _pageRankCache = new Map(); // RepoId → { ranks: Map, symbolMap: Map, n: number }

function _prCacheGet(repoId) {
  if (!_pageRankCache.has(repoId)) {return undefined;}
  // Move to end (most recently used)
  const entry = _pageRankCache.get(repoId);
  _pageRankCache.delete(repoId);
  _pageRankCache.set(repoId, entry);
  return entry;
}

function _prCacheSet(repoId, value) {
  if (_pageRankCache.has(repoId)) {_pageRankCache.delete(repoId);}
  if (_pageRankCache.size >= MAX_PAGE_RANK_CACHE_SIZE) {
    // Evict oldest (first inserted)
    const oldest = _pageRankCache.keys().next().value;
    _pageRankCache.delete(oldest);
  }
  _pageRankCache.set(repoId, value);
}

function buildPageRank(db, repoId) {
  // Check cache — cache key is just repoId (invalidated by reindex/repo removal)
  const cached = _prCacheGet(repoId);
  if (cached) {return cached;}

  const guard = _requireNativeDb(db);
  if (guard) {return { error: guard.error };}

  // Build call graph: caller → [callees]
  const calls = db
    .prepare(`
    SELECT cc.caller_symbol_id, cc.callee_symbol_id
    FROM code_calls cc
    JOIN code_symbols cs ON cs.id = cc.caller_symbol_id
    WHERE cc.repo_id = ? AND cc.callee_symbol_id IS NOT NULL AND cs.repo_id = ?
  `)
    .all(repoId, repoId);

  const symbols = db.prepare('SELECT id, name, kind, file_path FROM code_symbols WHERE repo_id = ?').all(repoId);
  const symbolSet = new Set(symbols.map((s) => s.id));
  const symbolMap = new Map(symbols.map((s) => [s.id, s]));

  // Build outgoing edges map
  const outEdges = new Map();
  for (const call of calls) {
    if (!symbolSet.has(call.caller_symbol_id) || !symbolSet.has(call.callee_symbol_id)) {continue;}
    if (!outEdges.has(call.caller_symbol_id)) {outEdges.set(call.caller_symbol_id, []);}
    outEdges.get(call.caller_symbol_id).push(call.callee_symbol_id);
  }

  // PageRank computation
  const d = PAGERANK.DAMPING_FACTOR;
  const n = symbolSet.size;
  let ranks = new Map();
  for (const id of symbolSet) {ranks.set(id, 1 / n);}

  for (let i = 0; i < PAGERANK.ITERATIONS; i++) {
    const newRanks = new Map();
    for (const id of symbolSet) {newRanks.set(id, (1 - d) / n);}

    for (const [callerId, calleeIds] of outEdges) {
      const outDegree = calleeIds.length;
      if (outDegree === 0) {continue;}
      const rankShare = ranks.get(callerId) / outDegree;
      for (const calleeId of calleeIds) {
        newRanks.set(calleeId, newRanks.get(calleeId) + d * rankShare);
      }
    }
    ranks = newRanks;
  }

  const result = { ranks, symbolMap, n };
  _prCacheSet(repoId, result);
  return result;
}

// Clear PageRank cache (for testing / reindex)
function clearPageRankCache(repoId) {
  if (repoId) {_pageRankCache.delete(repoId);}
  else {_pageRankCache.clear();}
}

// ══════════════════════════════════════════════════════════
// SYMBOL IMPORTANCE (PageRank on call graph)
// ══════════════════════════════════════════════════════════

function getSymbolImportance(db, repoId, opts = {}) {
  const guard = _requireNativeDb(db);
  if (guard) {return guard;}
  const topN = opts.top || 20;
  const scope = opts.scope || null;

  const pr = buildPageRank(db, repoId);
  if (pr.error) {return pr;}

  const { ranks, symbolMap, n: totalSymbols } = pr;

  // Apply scope filter if provided
  let entries = [...ranks.entries()];
  if (scope) {
    entries = entries.filter(([id]) => {
      const sym = symbolMap.get(id);
      return sym && sym.file_path.startsWith(scope);
    });
  }

  // Sort by rank and return top N
  const results = entries
    .map(([id, rank]) => ({ ...symbolMap.get(id), pagerank: Math.round(rank * 10000) / 10000 }))
    .sort((a, b) => b.pagerank - a.pagerank)
    .slice(0, topN);

  return { nodes: results, total_symbols: scope ? entries.length : totalSymbols };
}

// ══════════════════════════════════════════════════════════
// WINNOW — Multi-axis symbol query (AND-intersected filters)
// ══════════════════════════════════════════════════════════

function winnow(db, repoId, opts = {}) {
  const guard = _requireNativeDb(db);
  if (guard) {return guard;}

  const {
    kind = null,
    minComplexity = null,
    minChurn = null,
    minPageRank = null,
    minCallers = null,
    fileGlob = null,
    nameRegex = null,
    sortBy = 'pagerank',
    top = 20,
  } = opts;

  // Get PageRank data
  const pr = buildPageRank(db, repoId);
  if (pr.error) {return pr;}
  const { symbolMap, n: totalSymbols } = pr;

  // Build query dynamically based on active axes
  const conditions = ['s.repo_id = ?'];
  const params = [repoId];
  const joins = [];
  const activeAxes = [];

  // Kind filter
  if (kind) {
    conditions.push('s.kind = ?');
    params.push(kind);
    activeAxes.push('kind');
  }

  // File glob filter
  if (fileGlob) {
    conditions.push('s.file_path GLOB ?');
    params.push(fileGlob);
    activeAxes.push('file_glob');
  }

  // Name regex filter (applied in JS after query)
  let nameRegexObj = null;
  if (nameRegex) {
    try {
      nameRegexObj = new RegExp(nameRegex);
      activeAxes.push('name_regex');
    } catch (_) {
      return { error: `Invalid regex: ${nameRegex}` };
    }
  }

  // Complexity filter
  if (minComplexity != null) {
    joins.push('LEFT JOIN symbol_complexity sc ON sc.symbol_id = s.id');
    conditions.push('sc.cyclomatic >= ?');
    params.push(Number(minComplexity));
    activeAxes.push('min_complexity');
  }

  // Churn filter
  if (minChurn != null) {
    joins.push('LEFT JOIN churn_metrics cm ON cm.file_path = s.file_path AND cm.repo_id = s.repo_id');
    conditions.push('cm.commits >= ?');
    params.push(Number(minChurn));
    activeAxes.push('min_churn');
  }

  // Caller count filter
  if (minCallers != null) {
    joins.push(`LEFT JOIN (
      SELECT callee_symbol_id, COUNT(DISTINCT caller_symbol_id) as caller_count
      FROM code_calls WHERE repo_id = ? AND callee_symbol_id IS NOT NULL
      GROUP BY callee_symbol_id
    ) cc_cnt ON cc_cnt.callee_symbol_id = s.id`);
    params.unshift(repoId); // Insert at front for the subquery param
    conditions.push('cc_cnt.caller_count >= ?');
    params.push(Number(minCallers));
    activeAxes.push('min_callers');
  }

  // Build the SQL
  let sql = `
    SELECT s.id, s.name, s.kind, s.file_path, s.signature, s.start_line, s.end_line
    FROM code_symbols s
    ${joins.join('\n    ')}
    WHERE ${conditions.join(' AND ')}
  `;

  if (sortBy === 'complexity' && minComplexity == null) {
    // Need to join complexity for sorting
    if (!joins.some(j => j.includes('symbol_complexity'))) {
      sql = sql.replace('FROM code_symbols s', 'FROM code_symbols s\n    LEFT JOIN symbol_complexity sc ON sc.symbol_id = s.id');
    }
  }

  if (sortBy === 'churn' && minChurn == null) {
    if (!joins.some(j => j.includes('churn_metrics'))) {
      sql = sql.replace('FROM code_symbols s', 'FROM code_symbols s\n    LEFT JOIN churn_metrics cm ON cm.file_path = s.file_path AND cm.repo_id = s.repo_id');
    }
  }

  // Apply name regex filter in SQL if possible, otherwise filter in JS
  const rows = db.prepare(sql).all(...params);

  // Filter by name regex if needed
  let filteredRows = rows;
  if (nameRegexObj) {
    filteredRows = rows.filter(r => nameRegexObj.test(r.name));
  }

  // Annotate with PageRank
  const enriched = filteredRows.map(row => {
    const prData = symbolMap.get(row.id);
    const rank = prData ? pr.ranks.get(row.id) || 0 : 0;
    return {
      ...row,
      pagerank: Math.round(rank * 1000000) / 1000000,
    };
  });

  // Sort
  const sortFn = {
    pagerank: (a, b) => b.pagerank - a.pagerank,
    complexity: (a, b) => (b.cyclomatic || 0) - (a.cyclomatic || 0),
    churn: (a, b) => (b.commits || 0) - (a.commits || 0),
    callers: (a, b) => (b.caller_count || 0) - (a.caller_count || 0),
  }[sortBy] || ((a, b) => b.pagerank - a.pagerank);

  enriched.sort(sortFn);

  const topResults = enriched.slice(0, top);

  return {
    results: topResults,
    total_matched: filteredRows.length,
    total_symbols: totalSymbols,
    axes: activeAxes,
  };
}

// ══════════════════════════════════════════════════════════
// COUPLING METRICS (afferent/efferent/instability per file)
// ══════════════════════════════════════════════════════════

function getCouplingMetrics(db, repoId, opts = {}) {
  const guard = _requireNativeDb(db);
  if (guard) {return guard;}
  const filePath = opts.file || null;
  const minCa = opts.minCa || 0;
  const sortBy = opts.sortBy || 'instability'; // 'instability', 'afferent', 'efferent'

  // Afferent coupling (Ca): files that import this file
  const afferentRows = db
    .prepare(`
    SELECT tf.path as file_path, COUNT(DISTINCT ci.source_file_id) as ca
    FROM code_imports ci
    JOIN code_files tf ON tf.id = ci.target_file_id
    WHERE ci.repo_id = ? AND ci.target_file_id IS NOT NULL
    GROUP BY tf.path
  `)
    .all(repoId);

  // Efferent coupling (Ce): files this file imports
  const efferentRows = db
    .prepare(`
    SELECT sf.path as file_path, COUNT(DISTINCT ci.target_file_id) as ce
    FROM code_imports ci
    JOIN code_files sf ON sf.id = ci.source_file_id
    WHERE ci.repo_id = ? AND ci.target_file_id IS NOT NULL AND ci.import_type != 're-export'
    GROUP BY sf.path
  `)
    .all(repoId);

  const afferentMap = new Map(afferentRows.map((r) => [r.file_path, r.ca]));
  const efferentMap = new Map(efferentRows.map((r) => [r.file_path, r.ce]));

  // Get all files in repo
  const allFiles = db.prepare('SELECT path FROM code_files WHERE repo_id = ?').all(repoId);
  const results = [];

  for (const f of allFiles) {
    if (filePath && f.path !== filePath && !f.path.endsWith(filePath)) {continue;}
    const ca = afferentMap.get(f.path) || 0;
    const ce = efferentMap.get(f.path) || 0;
    const total = ca + ce;
    const instability = total === 0 ? 0 : Math.round((ce / total) * 100) / 100;
    const category = instability <= COUPLING.STABLE_THRESHOLD ? 'stable' : instability >= COUPLING.UNSTABLE_THRESHOLD ? 'unstable' : 'balanced';

    if (ca < minCa) {continue;}
    results.push({ file_path: f.path, afferent: ca, efferent: ce, instability, category });
  }

  const sortKey = sortBy === 'afferent' ? 'afferent' : sortBy === 'efferent' ? 'efferent' : 'instability';
  results.sort((a, b) => b[sortKey] - a[sortKey]);

  return { metrics: results };
}

// ══════════════════════════════════════════════════════════
// EXTRACTION CANDIDATES (complexity × caller spread)
// ══════════════════════════════════════════════════════════

function getExtractionCandidates(db, repoId, opts = {}) {
  const guard = _requireNativeDb(db);
  if (guard) {return guard;}
  const minComplexity = opts.minComplexity || 5;
  const minCallers = opts.minCallers || 2;
  const topN = opts.top || 20;

  // Find symbols with high complexity that are called from multiple files
  const rows = db
    .prepare(`
    SELECT
      cs.name,
      cs.kind,
      cs.file_path,
      sc.cyclomatic,
      sc.nesting_depth,
      sc.lines_of_code,
      COUNT(DISTINCT caller.file_path) as caller_file_count,
      ROUND(sc.cyclomatic * LOG(1 + COUNT(DISTINCT caller.file_path)), 2) as extraction_score,
      GROUP_CONCAT(DISTINCT caller.file_path) as caller_files
    FROM symbol_complexity sc
    JOIN code_symbols cs ON cs.id = sc.symbol_id
    JOIN code_calls cc ON cc.callee_symbol_id = cs.id AND cc.repo_id = cs.repo_id
    JOIN code_symbols caller ON caller.id = cc.caller_symbol_id AND caller.repo_id = cs.repo_id
    WHERE cs.repo_id = ? AND sc.cyclomatic >= ?
    GROUP BY cs.id
    HAVING COUNT(DISTINCT caller.file_path) >= ?
    ORDER BY extraction_score DESC
    LIMIT ?
  `)
    .all(repoId, minComplexity, minCallers, topN);

  // Parse caller_files from GROUP_CONCAT
  const results = rows.map((r) => ({
    ...r,
    caller_files: r.caller_files ? r.caller_files.split(',') : [],
  }));

  return { candidates: results };
}

// ══════════════════════════════════════════════════════════
// CLASS HIERARCHY (parent_name → ancestors/descendants)
// ══════════════════════════════════════════════════════════

function getClassHierarchy(db, repoId, opts = {}) {
  const guard = _requireNativeDb(db);
  if (guard) {return guard;}
  const className = opts.class || opts.symbol;
  const direction = opts.direction || 'both'; // 'ancestors', 'descendants', 'both'

  if (!className) {return { error: 'Class name required. Pass --class or --symbol.' };}

  // Find the symbol
  const sym = db
    .prepare('SELECT id, name, kind, file_path, parent_name FROM code_symbols WHERE repo_id = ? AND name = ?')
    .get(repoId, className);
  if (!sym) {return { error: `Symbol "${className}" not found in repo.` };}

  const result = { name: sym.name, kind: sym.kind, file_path: sym.file_path, parent_name: sym.parent_name };

  // Ancestors: walk parent_name chain upward
  if (direction === 'ancestors' || direction === 'both') {
    const ancestors = [];
    let current = sym;
    const visited = new Set();
    while (current.parent_name && !visited.has(current.parent_name)) {
      visited.add(current.parent_name);
      const parent = db
        .prepare('SELECT id, name, kind, file_path, parent_name FROM code_symbols WHERE repo_id = ? AND name = ?')
        .get(repoId, current.parent_name);
      if (!parent) {break;}
      ancestors.push({ name: parent.name, kind: parent.kind, file_path: parent.file_path });
      current = parent;
    }
    result.ancestors = ancestors;
  }

  // Descendants: find symbols whose parent_name matches this class
  if (direction === 'descendants' || direction === 'both') {
    const descendants = db
      .prepare(`
      SELECT name, kind, file_path, parent_name FROM code_symbols
      WHERE repo_id = ? AND parent_name = ?
      ORDER BY kind, name
    `)
      .all(repoId, className);
    result.descendants = descendants;
  }

  return result;
}

// ══════════════════════════════════════════════════════════
// SIGNAL CHAINS (HTTP routes, CLI commands → call graph)
// ══════════════════════════════════════════════════════════

const _HTTP_PATTERNS = [
  /\.(get|post|put|delete|patch|head|options|all)\s*\(\s*['"\`]([^'"\`]+)['"\`]/g,
  /\.(use|route)\s*\(\s*['"\`]([^'"\`]+)['"\`]/g,
];

const _CLI_PATTERNS = [/@click\.command\s*\(/g, /@app\.route\s*\(\s*['"\`]([^'"\`]+)['"\`]/g];

function getSignalChains(db, repoId, opts = {}) {
  const guard = _requireNativeDb(db);
  if (guard) {return guard;}
  const kind = opts.kind || null; // 'http', 'cli', or null for all
  const symbol = opts.symbol || null;
  const maxDepth = opts.maxDepth || 5;

  // Get all symbols with their signatures
  const symbols = db
    .prepare('SELECT id, name, kind, file_path, signature, start_line FROM code_symbols WHERE repo_id = ?')
    .all(repoId);

  // Build call graph for tracing
  const calls = db
    .prepare('SELECT caller_symbol_id, callee_name, callee_symbol_id FROM code_calls WHERE repo_id = ?')
    .all(repoId);

  const callGraph = new Map(); // Caller_id → [{callee_id, callee_name}]
  for (const c of calls) {
    if (!callGraph.has(c.caller_symbol_id)) {callGraph.set(c.caller_symbol_id, []);}
    callGraph.get(c.caller_symbol_id).push({ callee_id: c.callee_symbol_id, callee_name: c.callee_name });
  }

  const symbolMap = new Map(symbols.map((s) => [s.id, s]));

  // Detect gateways from symbol signatures
  const gateways = [];
  for (const sym of symbols) {
    if (!sym.signature) {continue;}
    const sig = sym.signature;

    // HTTP detection
    if (!kind || kind === 'http') {
      for (const pat of _HTTP_PATTERNS) {
        pat.lastIndex = 0;
        const match = pat.exec(sig);
        if (match) {
          const method = match[1] ? match[1].toUpperCase() : 'ANY';
          const routePath = match[2] || '/';
          gateways.push({
            symbol_id: sym.id,
            name: sym.name,
            kind: 'http',
            method,
            path: routePath,
            file_path: sym.file_path,
            line: sym.start_line,
          });
          break;
        }
      }
    }

    // CLI detection
    if (!kind || kind === 'cli') {
      for (const pat of _CLI_PATTERNS) {
        pat.lastIndex = 0;
        const match = pat.exec(sig);
        if (match) {
          const routePath = match[1] || sym.name;
          gateways.push({
            symbol_id: sym.id,
            name: sym.name,
            kind: 'cli',
            method: 'CLI',
            path: routePath,
            file_path: sym.file_path,
            line: sym.start_line,
          });
          break;
        }
      }
    }
  }

  // If a specific symbol is requested, filter to chains containing it
  if (symbol) {
    const symRow = db.prepare('SELECT id, name FROM code_symbols WHERE repo_id = ? AND name = ?').get(repoId, symbol);
    if (!symRow) {return { chains: [], note: `Symbol "${symbol}" not found` };}

    // Trace upstream to find which gateway leads to this symbol
    const visited = new Set();
    const queue = [symRow.id];
    const parentMap = new Map();

    while (queue.length) {
      const current = queue.shift();
      if (visited.has(current)) {continue;}
      visited.add(current);
      const callers = db
        .prepare('SELECT caller_symbol_id FROM code_calls WHERE callee_symbol_id = ? AND repo_id = ?')
        .all(current, repoId);
      for (const c of callers) {
        if (!visited.has(c.caller_symbol_id)) {
          parentMap.set(c.caller_symbol_id, current);
          queue.push(c.caller_symbol_id);
        }
      }
    }

    // Find which gateways are in the visited set
    const relevantGateways = gateways.filter((g) => visited.has(g.symbol_id));
    if (relevantGateways.length === 0) {
      return { chains: [], note: `No signal chain found for "${symbol}"` };
    }

    // Reconstruct chains from each gateway to the target symbol
    const chains = relevantGateways.map((gw) => {
      const chain = [{ symbol_id: gw.symbol_id, name: gw.name, kind: gw.kind, method: gw.method, path: gw.path }];
      let current = gw.symbol_id;
      while (parentMap.has(current) && current !== symRow.id) {
        const next = parentMap.get(current);
        const nextSym = symbolMap.get(next);
        chain.push({ symbol_id: next, name: nextSym ? nextSym.name : `id:${next}`, kind: 'callee' });
        current = next;
      }
      return { gateway: gw, chain };
    });

    return { symbol: symRow.name, chains };
  }

  // Discovery mode: return all gateways with their callees traced N levels deep
  const chains = gateways.map((gw) => {
    const chain = [{ symbol_id: gw.symbol_id, name: gw.name, kind: gw.kind, method: gw.method, path: gw.path }];
    let current = gw.symbol_id;
    const visited = new Set([current]);

    for (let depth = 0; depth < maxDepth; depth++) {
      const callees = callGraph.get(current) || [];
      if (callees.length === 0) {break;}
      // Follow the first resolved callee (most common path)
      const resolved = callees.find((c) => c.callee_id) || callees[0];
      if (!resolved || visited.has(resolved.callee_id || 0)) {break;}
      const calleeSym = resolved.callee_id ? symbolMap.get(resolved.callee_id) : null;
      chain.push({
        symbol_id: resolved.callee_id,
        name: resolved.callee_name,
        kind: calleeSym ? calleeSym.kind : 'unknown',
      });
      if (resolved.callee_id) {visited.add(resolved.callee_id);}
      current = resolved.callee_id;
    }

    return { gateway: gw, chain };
  });

  return { chains, gateway_count: gateways.length };
}

// ══════════════════════════════════════════════════════════
// LAYER VIOLATIONS (architectural boundary checks)
// ══════════════════════════════════════════════════════════

function getLayerViolations(db, repoId, opts = {}) {
  const guard = _requireNativeDb(db);
  if (guard) {return guard;}
  let rules = opts.rules || null;

  // If no rules provided, look for .pimemory-layers.jsonc in repo root
  if (!rules) {
    const repo = db.prepare('SELECT path FROM code_repos WHERE id = ?').get(repoId);
    if (!repo) {return { error: 'Repo not found' };}

    const fs = require('fs');
    const configPath = path.join(repo.path, '.pimemory-layers.jsonc');
    if (!fs.existsSync(configPath)) {
      return {
        violations: [],
        note: 'No .pimemory-layers.jsonc config found. Create one to enable layer violation detection.',
      };
    }

    try {
      let content = fs.readFileSync(configPath, 'utf-8');
      // Strip JSONC comments
      content = content.replace(/\/\/.*$/gm, '');
      rules = JSON.parse(content);
    } catch (e) {
      return { error: `Failed to parse .pimemory-layers.jsonc: ${e.message}` };
    }
  }

  if (!rules || !rules.layers) {
    return { error: 'Invalid layer rules: missing "layers" array.' };
  }

  // Get all imports for this repo
  const imports = db
    .prepare(`
    SELECT cf_source.path as source_path, cf_target.path as target_path, ci.import_type
    FROM code_imports ci
    JOIN code_files cf_source ON cf_source.id = ci.source_file_id
    LEFT JOIN code_files cf_target ON cf_target.id = ci.target_file_id
    WHERE ci.repo_id = ? AND ci.target_file_id IS NOT NULL
  `)
    .all(repoId);

  // Determine which layer a file belongs to
  function fileLayer(filePath, layers) {
    for (const layer of layers) {
      for (const prefix of layer.paths) {
        if (filePath.includes(prefix)) {return layer.name;}
      }
    }
    return null; // Unaffiliated file
  }

  const violations = [];
  const layerMap = new Map();
  for (const layer of rules.layers) {
    layerMap.set(layer.name, new Set(layer.may_not_import || []));
  }

  for (const imp of imports) {
    const sourceLayer = fileLayer(imp.source_path, rules.layers);
    const targetLayer = fileLayer(imp.target_path, rules.layers);

    if (!sourceLayer || !targetLayer) {continue;} // Skip unaffiliated files
    if (sourceLayer === targetLayer) {continue;} // Same layer, ok

    const forbidden = layerMap.get(sourceLayer);
    if (forbidden && forbidden.has(targetLayer)) {
      violations.push({
        source: imp.source_path,
        source_layer: sourceLayer,
        target: imp.target_path,
        target_layer: targetLayer,
        rule: `${sourceLayer} may not import ${targetLayer}`,
      });
    }
  }

  return { violations, total: violations.length };
}

// ══════════════════════════════════════════════════════════
// UNTESTED SYMBOLS (v6)
// ══════════════════════════════════════════════════════════

function getUntestedSymbols(db, repoId, opts = {}) {
  const guard = _requireNativeDb(db);
  if (guard) {return guard;}
  const { minConfidence = 0.5, includePrivate = false } = opts;

  // 1. Identify test files
  const allFiles = db.prepare('SELECT id, path FROM code_files WHERE repo_id = ?').all(repoId);
  const testFileIds = new Set();
  for (const f of allFiles) {
    if (
      f.path.includes('.test.') || f.path.includes('.spec.') ||
      f.path.includes('/test/') || f.path.includes('/__tests__/')
    ) {
      testFileIds.add(f.id);
    }
  }

  // 2. Trace import graph from test files → production files (batch)
  const testImportedFiles = new Set();
  if (testFileIds.size > 0) {
    const testIdList = [...testFileIds];
    const batchImports = db.prepare(
      `SELECT target_file_id FROM code_imports WHERE source_file_id IN (${testIdList.map(() => '?').join(',')}) AND target_file_id IS NOT NULL`
    ).all(...testIdList);
    for (const imp of batchImports) {testImportedFiles.add(imp.target_file_id);}
  }

  // 3. Trace call graph from test functions → production symbols (batch)
  const testedSymbols = new Set();
  const indirectlyTested = new Set();

  if (testFileIds.size > 0) {
    const testSymbols = db.prepare(
      `SELECT id FROM code_symbols WHERE file_id IN (${
      [...testFileIds].map(() => '?').join(',')  }) AND repo_id = ?`
    ).all(...[...testFileIds, repoId]);

    if (testSymbols.length > 0) {
      const testSymIds = testSymbols.map((ts) => ts.id);

      // Batch: direct callees for all test symbols at once
      const directCallees = db.prepare(
        `SELECT caller_symbol_id, callee_symbol_id FROM code_calls WHERE caller_symbol_id IN (${testSymIds.map(() => '?').join(',')}) AND callee_symbol_id IS NOT NULL`
      ).all(...testSymIds);

      for (const dc of directCallees) {
        testedSymbols.add(dc.callee_symbol_id);
      }

      // Batch: indirect callees (level 2) for all direct callee IDs at once
      const directCalleeIds = [...testedSymbols];
      if (directCalleeIds.length > 0) {
        const indirectCallees = db.prepare(
          `SELECT caller_symbol_id, callee_symbol_id FROM code_calls WHERE caller_symbol_id IN (${directCalleeIds.map(() => '?').join(',')}) AND callee_symbol_id IS NOT NULL`
        ).all(...directCalleeIds);
        for (const ic of indirectCallees) {
          if (!testedSymbols.has(ic.callee_symbol_id)) {
            indirectlyTested.add(ic.callee_symbol_id);
          }
        }
      }
    }
  }

  // 4. Get all production symbols
  const allSymbols = db.prepare(
    'SELECT id, name, kind, file_path, start_line, file_id FROM code_symbols WHERE repo_id = ?'
  ).all(repoId);

  // Exclusions
  const entryPointPatterns = ['main.js', 'index.js', 'cli.js', 'app.js', 'server.js'];
  const excludedFileIds = new Set();
  for (const f of allFiles) {
    const basename = path.basename(f.path);
    if (entryPointPatterns.includes(basename)) {excludedFileIds.add(f.id);}
  }

  // Build results with per-symbol confidence
  const untested = [];
  for (const sym of allSymbols) {
    // Skip test symbols themselves
    if (testFileIds.has(sym.file_id)) {continue;}
    // Skip excluded patterns
    if (excludedFileIds.has(sym.file_id)) {continue;}
    // Skip private symbols unless requested
    if (!includePrivate && sym.name.startsWith('_')) {continue;}

    if (testedSymbols.has(sym.id)) {continue;}

    let confidence;
    if (indirectlyTested.has(sym.id)) {
      confidence = UNTETECTED_CONFIDENCE.INDIRECTLY_TESTED;
    } else if (testImportedFiles.has(sym.file_id)) {
      confidence = UNTETECTED_CONFIDENCE.TEST_IMPORTED_FILE;
    } else {
      confidence = UNTETECTED_CONFIDENCE.NO_TEST_SIGNAL;
    }

    if (confidence >= minConfidence) {
      untested.push({ ...sym, untested_confidence: confidence });
    }
  }

  return {
    untested,
    total_symbols: allSymbols.length,
    test_files_found: testFileIds.size,
    total_files: allFiles.length,
    tested_symbols: testedSymbols.size,
    indirectly_tested: indirectlyTested.size,
  };
}

// ══════════════════════════════════════════════════════════
// PR RISK PROFILING (v6)
// ══════════════════════════════════════════════════════════

function getPrRiskProfile(db, repoId, opts = {}) {
  const guard = _requireNativeDb(db);
  if (guard) {return guard;}
  const { branch = 'HEAD', base = 'main' } = opts;

  // Get changed files between base and branch
  const repo = db.prepare('SELECT path FROM code_repos WHERE id = ?').get(repoId);
  if (!repo) {return { error: 'Repo not found' };}

  let changedFiles = [];
  try {
    const { execSync } = require('child_process');
    const diffOutput = execSync(
      `git -C "${repo.path}" diff --name-only ${base}...${branch}`,
      { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    changedFiles = diffOutput ? diffOutput.split('\n').filter(Boolean) : [];
  } catch (_) {
    changedFiles = [];
  }

  if (changedFiles.length === 0) {
    return { signals: {}, risk_level: 'low', composite: 0.0, note: 'No changed files detected.' };
  }

  // Get changed symbols
  const changedSymbolIds = new Set();
  const changedSymbols = [];
  for (const filePath of changedFiles) {
    const syms = db.prepare(
      'SELECT id, name, kind, file_path FROM code_symbols WHERE repo_id = ? AND file_path = ?'
    ).all(repoId, filePath);
    for (const s of syms) {
      changedSymbolIds.add(s.id);
      changedSymbols.push(s);
    }
  }

  if (changedSymbolIds.size === 0) {
    return { signals: {}, risk_level: 'low', composite: 0.1, changed_files: changedFiles.length };
  }

  // Signal 1: Blast radius (30%) — batch computation for >20 symbols
  let blastRadiusScore = 0;
  try {
    if (changedSymbolIds.size > 20) {
      // Batch: recursive CTE for all changed symbols at once
      // Use parameterized query to prevent SQL injection
      const changedIdsArr = [...changedSymbolIds];
      const placeholders = changedIdsArr.map(() => '?').join(',');
      const rows = db.prepare(`
        WITH RECURSIVE call_tree AS (
          SELECT callee_symbol_id, caller_symbol_id, 1 as depth
          FROM code_calls WHERE repo_id = ? AND callee_symbol_id IN (${placeholders})
          UNION ALL
          SELECT cc.callee_symbol_id, cc.caller_symbol_id, ct.depth + 1
          FROM code_calls cc JOIN call_tree ct ON cc.callee_symbol_id = ct.caller_symbol_id
          WHERE ct.depth < 5
        )
        SELECT callee_symbol_id, COUNT(DISTINCT caller_symbol_id) as affected_callers
        FROM call_tree GROUP BY callee_symbol_id
      `).all(repoId, ...changedIdsArr);

      const maxCallers = Math.max(...rows.map(r => r.affected_callers), 1);
      blastRadiusScore = Math.min(1.0, maxCallers / PR_RISK.BLAST_RADIUS_NORMALIZER);
    } else {
      // Per-symbol blast radius for small PRs
      let maxCallers = 0;
      for (const sid of changedSymbolIds) {
        const br = getBlastRadius(db, repoId, {
          symbol: db.prepare('SELECT name FROM code_symbols WHERE id = ?').get(sid)?.name
        });
        const edgeCount = (br.edges || []).length;
        if (edgeCount > maxCallers) {maxCallers = edgeCount;}
      }
      blastRadiusScore = Math.min(1.0, maxCallers / PR_RISK.BLAST_RADIUS_NORMALIZER);
    }
  } catch (_) {}

  // Signal 2: Complexity (20%)
  let complexityScore = 0;
  try {
    const changedIdsArr = [...changedSymbolIds];
    const placeholders = changedIdsArr.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT MAX(sc.cyclomatic) as max_cc FROM symbol_complexity sc
       WHERE sc.symbol_id IN (${placeholders})`
    ).all(...changedIdsArr);
    const maxCc = rows[0]?.max_cc || 0;
    complexityScore = Math.min(1.0, maxCc / PR_RISK.COMPLEXITY_NORMALIZER);
  } catch (_) {}

  // Signal 3: Churn (20%)
  let churnScore = 0;
  try {
    let maxChurn = 0;
    for (const filePath of changedFiles) {
      const row = db.prepare(
        'SELECT commits FROM churn_metrics WHERE repo_id = ? AND file_path = ? AND window_days = 90'
      ).get(repoId, filePath);
      if (row && row.commits > maxChurn) {maxChurn = row.commits;}
    }
    churnScore = Math.min(1.0, maxChurn / PR_RISK.CHURN_NORMALIZER);
  } catch (_) {}

  // Signal 4: Test coverage (20%) — from untested detection
  let testCoverageScore = 0;
  try {
    const untestedData = getUntestedSymbols(db, repoId, { minConfidence: 0.5 });
    if (untestedData.total_files > 0 && untestedData.test_files_found > 0) {
      const untestedRatio = untestedData.untested.length / Math.max(untestedData.total_symbols, 1);
      testCoverageScore = Math.min(1.0, untestedRatio);
    }
  } catch (_) {}

  // Signal 5: Change volume (10%)
  let changeVolumeScore = 0;
  try {
    const { execSync } = require('child_process');
    const diffStat = execSync(
      `git -C "${repo.path}" diff --stat ${base}...${branch}`,
      { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    // Parse the last line which has the total: "X files changed, Y insertions(+), Z deletions(-)"
    const totalMatch = diffStat.match(/(\d+) insertions?.*?(\d+) deletions?/);
    if (totalMatch) {
      const totalLines = parseInt(totalMatch[1]) + (parseInt(totalMatch[2]) || 0);
      changeVolumeScore = Math.min(1.0, totalLines / PR_RISK.CHANGE_VOLUME_NORMALIZER);
    }
  } catch (_) {}

  // Composite score with weights
  const weights = PR_RISK.WEIGHTS;

  // If test coverage unavailable, redistribute weight
  let wBlastRadius = weights.blast_radius;
  let wComplexity = weights.complexity;
  let wChurn = weights.churn;
  const wTestCoverage = testCoverageScore > 0 ? weights.test_coverage : 0;
  const wChangeVolume = weights.change_volume;

  if (wTestCoverage === 0) {
    const adjustment = weights.test_coverage;
    wBlastRadius += adjustment * 0.5;
    wComplexity += adjustment * 0.25;
    wChurn += adjustment * 0.25;
  }

  const composite =
    blastRadiusScore * wBlastRadius +
    complexityScore * wComplexity +
    churnScore * wChurn +
    testCoverageScore * wTestCoverage +
    changeVolumeScore * wChangeVolume;

  const riskLevel =
    composite <= PR_RISK.RISK_LEVELS.LOW ? 'low' :
    composite <= PR_RISK.RISK_LEVELS.MEDIUM ? 'medium' :
    composite <= PR_RISK.RISK_LEVELS.HIGH ? 'high' : 'critical';

  return {
    signals: {
      blast_radius: Math.round(blastRadiusScore * 100) / 100,
      complexity: Math.round(complexityScore * 100) / 100,
      churn: Math.round(churnScore * 100) / 100,
      test_coverage: Math.round(testCoverageScore * 100) / 100,
      change_volume: Math.round(changeVolumeScore * 100) / 100,
    },
    composite: Math.round(composite * 100) / 100,
    risk_level: riskLevel,
    changed_files: changedFiles.length,
    changed_symbols: changedSymbolIds.size,
  };
}

module.exports = {
  buildImportGraph,
  buildCallGraph,
  buildComplexity,
  buildPageRank,
  clearPageRankCache,
  getImportGraph,
  getCallHierarchy,
  getBlastRadius,
  getDeadCode,
  getComplexity,
  getFileOutline,
  getHotspots,
  getDependencyCycles,
  getSymbolImportance,
  getCouplingMetrics,
  getExtractionCandidates,
  getClassHierarchy,
  getSignalChains,
  getLayerViolations,
  winnow,
  getUntestedSymbols,
  getPrRiskProfile,
  extractImportBindings,
};
