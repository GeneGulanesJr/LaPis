// Src/code-analysis/import-graph-impl.js
// Import extraction, import graph building, and related queries:
// Blast radius, dependency cycles, hotspots, winnow.

const { path, _requireNativeDb, RESULT_LIMITS, HOTSPOT_THRESHOLDS } = require('./shared-deps');

// We need buildPageRank from coupling-impl for winnow
// Circular dep resolved via lazy require below
let _couplingImpl = null;
function _getCoupling() {
  if (!_couplingImpl) {
    _couplingImpl = require('./coupling-impl');
  }
  return _couplingImpl;
}

// Escape SQL LIKE wildcard characters (%, _) in user input.
function _likeEscape(str) {
  return str.replace(/!/g, '!!').replace(/%/g, '!%').replace(/_/g, '!_');
}

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
      // eslint-disable-next-line no-continue
      continue;
    }

    m = line.match(/^import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/);
    if (m) {
      bindings.push({ localName: m[1], originalName: '*', modulePath: m[2], line: i + 1 });
      // eslint-disable-next-line no-continue
      continue;
    }

    const namedMatch = line.match(/^import\s+(?:([\w]+)\s*,\s*)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/);
    if (namedMatch) {
      if (namedMatch[1]) {
        bindings.push({ localName: namedMatch[1], originalName: 'default', modulePath: namedMatch[3], line: i + 1 });
      }
      const names = namedMatch[2]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const nameStr of names) {
        const asMatch = nameStr.match(/^(\w+)\s+as\s+(\w+)$/);
        if (asMatch) {
          bindings.push({ localName: asMatch[2], originalName: asMatch[1], modulePath: namedMatch[3], line: i + 1 });
        } else {
          bindings.push({ localName: nameStr, originalName: nameStr, modulePath: namedMatch[3], line: i + 1 });
        }
      }
      // eslint-disable-next-line no-continue
      continue;
    }

    const reExportNamed = line.match(/^export\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/);
    if (reExportNamed) {
      const names = reExportNamed[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const nameStr of names) {
        const asMatch = nameStr.match(/^(\w+)\s+as\s+(\w+)$/);
        if (asMatch) {
          bindings.push({
            localName: asMatch[2],
            originalName: asMatch[1],
            modulePath: reExportNamed[2],
            line: i + 1,
            isReExport: true,
          });
        } else {
          bindings.push({
            localName: nameStr,
            originalName: nameStr,
            modulePath: reExportNamed[2],
            line: i + 1,
            isReExport: true,
          });
        }
      }
      // eslint-disable-next-line no-continue
      continue;
    }

    m = line.match(/^(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (m) {
      bindings.push({ localName: m[1], originalName: '*', modulePath: m[2], line: i + 1 });
      // eslint-disable-next-line no-continue
      continue;
    }

    const destructureRequire = line.match(
      /^(?:const|let|var)\s+\{([^}]+)\}\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/,
    );
    if (destructureRequire) {
      const names = destructureRequire[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const nameStr of names) {
        const asMatch = nameStr.match(/^(\w+)\s*:\s*(\w+)$/);
        if (asMatch) {
          bindings.push({
            localName: asMatch[2],
            originalName: asMatch[1],
            modulePath: destructureRequire[2],
            line: i + 1,
          });
        } else {
          bindings.push({ localName: nameStr, originalName: nameStr, modulePath: destructureRequire[2], line: i + 1 });
        }
      }
      // eslint-disable-next-line no-continue
      continue;
    }
  }

  return bindings;
}

function resolveImportTarget(db, repoId, sourceFilePath, targetModule) {
  if (!targetModule.startsWith('.') && !targetModule.startsWith('/')) {
    return null;
  }

  const sourceDir = path.dirname(sourceFilePath);
  const resolved = path.resolve(sourceDir, targetModule);

  const candidates = [
    resolved,
    `${resolved}.js`,
    `${resolved}.mjs`,
    `${resolved}.cjs`,
    `${resolved}.ts`,
    `${resolved}.mts`,
    `${resolved}.cts`,
    `${resolved}.tsx`,
    path.join(resolved, 'index.js'),
    path.join(resolved, 'index.ts'),
    path.join(resolved, 'index.tsx'),
  ];

  for (const candidate of candidates) {
    const row = db.prepare('SELECT id FROM code_files WHERE repo_id = ? AND path = ?').get(repoId, candidate);
    if (row) {
      return row.id;
    }
  }
  return null;
}

function resolveImportTargetLocal(filePathMap, sourceFilePath, targetModule) {
  if (!targetModule.startsWith('.') && !targetModule.startsWith('/')) {
    return null;
  }

  const sourceDir = path.dirname(sourceFilePath);
  const resolved = path.resolve(sourceDir, targetModule);

  const candidates = [
    resolved,
    `${resolved}.js`,
    `${resolved}.mjs`,
    `${resolved}.cjs`,
    `${resolved}.ts`,
    `${resolved}.mts`,
    `${resolved}.cts`,
    `${resolved}.tsx`,
    path.join(resolved, 'index.js'),
    path.join(resolved, 'index.ts'),
    path.join(resolved, 'index.tsx'),
  ];

  for (const candidate of candidates) {
    const id = filePathMap.get(candidate);
    if (id !== undefined) {
      return id;
    }
  }
  return null;
}

function buildImportGraph(db, repoId) {
  const guard = _requireNativeDb(db);
  if (guard) {
    return guard;
  }
  db.prepare('DELETE FROM code_imports WHERE repo_id = ?').run(repoId);

  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO code_imports (repo_id, source_file_id, target_module, target_file_id, import_type, line_number) VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const files = db.prepare('SELECT id, path FROM code_files WHERE repo_id = ?').all(repoId);
  const contentStmt = db.prepare('SELECT content FROM code_files WHERE id = ?');

  const filePathMap = new Map();
  for (const file of files) {
    filePathMap.set(file.path, file.id);
  }

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
    for (const file of files) {
      const contentRow = contentStmt.get(file.id);
      if (contentRow && contentRow.content) {
        const imports = extractImportsFromSource(contentRow.content);
        for (const imp of imports) {
          const targetFileId = resolveImportTargetLocal(filePathMap, file.path, imp.target_module);
          insertStmt.run(repoId, file.id, imp.target_module, targetFileId, imp.import_type, imp.line_number);
          totalEdges++;
        }
      }
    }
  });

  return { success: true, edges: totalEdges };
}

function getImportGraph(db, repoId, opts) {
  const guard = _requireNativeDb(db);
  if (guard) {
    return guard;
  }
  const { file, direction = 'both', depth = 1 } = opts;

  if (depth <= 1 && file) {
    const fileRow = db
      .prepare("SELECT id FROM code_files WHERE repo_id = ? AND path LIKE ? ESCAPE '!'")
      .get(repoId, `%${_likeEscape(file)}%`);
    if (!fileRow) {
      return { error: `File not found: ${file}` };
    }

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
    const fileRow = db
      .prepare("SELECT id FROM code_files WHERE repo_id = ? AND path LIKE ? ESCAPE '!'")
      .get(repoId, `%${_likeEscape(file)}%`);
    if (!fileRow) {
      return { error: `File not found: ${file}` };
    }

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
// BLAST RADIUS
// ══════════════════════════════════════════════════════════

function getBlastRadius(db, repoId, opts) {
  const guard = _requireNativeDb(db);
  if (guard) {
    return guard;
  }
  const { symbol, depth = 3, minConfidence = 0.7 } = opts;
  if (!symbol) {
    return { error: 'Missing --symbol' };
  }

  const symRow = db
    .prepare('SELECT id, name, file_id, file_path FROM code_symbols WHERE repo_id = ? AND name = ?')
    .all(repoId, symbol);
  if (symRow.length === 0) {
    return { error: `Symbol "${symbol}" not found` };
  }
  if (symRow.length > 1) {
    return { error: `Multiple symbols named "${symbol}"`, candidates: symRow };
  }

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
// HOTSPOTS (complexity × churn)
// ══════════════════════════════════════════════════════════

function getHotspots(db, repoId, opts = {}) {
  const guard = _requireNativeDb(db);
  if (guard) {
    return guard;
  }
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
  if (guard) {
    return guard;
  }
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
    if (!adj.has(e.source)) {
      adj.set(e.source, []);
    }
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
      if (scc.length > 1) {
        sccs.push(scc);
      }
    }
  }

  for (const v of allNodes) {
    if (!indices.has(v)) {
      strongconnect(v);
    }
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

// ══════════════════════════════════════════════════════════
// WINNOW — Multi-axis symbol query (AND-intersected filters)
// ══════════════════════════════════════════════════════════

function winnow(db, repoId, opts = {}) {
  const guard = _requireNativeDb(db);
  if (guard) {
    return guard;
  }

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

  // Get PageRank data — lazy require to avoid circular deps
  const pr = _getCoupling().buildPageRank(db, repoId);
  if (pr.error) {
    return pr;
  }
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
    } catch {
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

  // Ensure the JOIN needed for the chosen sort axis exists (even without a min*
  // filter) and expose the column the comparator sorts on. Without these columns
  // in the SELECT, the sort comparators read `undefined` and become no-ops.
  const selectCols = ['s.id', 's.name', 's.kind', 's.file_path', 's.signature', 's.start_line', 's.end_line'];

  if (sortBy === 'complexity') {
    if (!joins.some((j) => j.includes('symbol_complexity'))) {
      joins.push('LEFT JOIN symbol_complexity sc ON sc.symbol_id = s.id');
    }
    selectCols.push('sc.cyclomatic');
  } else if (sortBy === 'churn') {
    if (!joins.some((j) => j.includes('churn_metrics'))) {
      joins.push('LEFT JOIN churn_metrics cm ON cm.file_path = s.file_path AND cm.repo_id = s.repo_id');
    }
    selectCols.push('cm.commits');
  } else if (sortBy === 'callers') {
    if (!joins.some((j) => j.includes('cc_cnt'))) {
      joins.push(`LEFT JOIN (
        SELECT callee_symbol_id, COUNT(DISTINCT caller_symbol_id) as caller_count
        FROM code_calls WHERE repo_id = ? AND callee_symbol_id IS NOT NULL
        GROUP BY callee_symbol_id
      ) cc_cnt ON cc_cnt.callee_symbol_id = s.id`);
      params.unshift(repoId);
    }
    selectCols.push('cc_cnt.caller_count');
  }

  // Build the SQL
  const sql = `
    SELECT ${selectCols.join(', ')}
    FROM code_symbols s
    ${joins.join('\n    ')}
    WHERE ${conditions.join(' AND ')}
  `;

  // Apply name regex filter in SQL if possible, otherwise filter in JS
  const rows = db.prepare(sql).all(...params);

  // Filter by name regex if needed
  let filteredRows = rows;
  if (nameRegexObj) {
    filteredRows = rows.filter((r) => nameRegexObj.test(r.name));
  }

  // Annotate with PageRank
  const enriched = filteredRows
    .map((row) => {
      const prData = symbolMap.get(row.id);
      const rank = prData ? pr.ranks.get(row.id) || 0 : 0;
      return {
        ...row,
        pagerank: Math.round(rank * 1000000) / 1000000,
      };
    })
    .filter((row) => minPageRank == null || row.pagerank >= Number(minPageRank));

  // Sort
  const sortFn =
    {
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

module.exports = {
  extractImportsFromSource,
  extractImportBindings,
  resolveImportTarget,
  buildImportGraph,
  getImportGraph,
  getBlastRadius,
  getHotspots,
  getDependencyCycles,
  winnow,
};
