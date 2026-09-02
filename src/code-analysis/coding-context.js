// Unified before-edit coding context built from the existing code index analyzers.

const graph = require('./graph'), impact = require('./impact'), quality = require('./quality'), gitMetrics = require('./git-metrics'),
  DEFAULT_DEPTH = 2,
  DEFAULT_TOP = 10;




function getCodingContext(db, repoId, opts = {}) {
  const symbolQuery = normalizeText(opts.symbol),
    fileQuery = normalizeFile(opts.file),
    depth = clampInt(opts.depth, DEFAULT_DEPTH, 1, 5),
    top = clampInt(opts.top, DEFAULT_TOP, 1, 50);

  if (!symbolQuery && !fileQuery) {
    return { error: 'Missing --symbol or --file' };
  }

  const repo = db.prepare('SELECT id, name, path, head_commit FROM code_repos WHERE id = ?').get(repoId);
  if (!repo) {
    return { error: `Repo id ${repoId} not found` };
  }

  const target = symbolQuery
    ? resolveSymbolTarget(db, repoId, symbolQuery, fileQuery || null)
    : resolveFileTarget(db, repoId, fileQuery);

  if (target.error) {
    return target;
  }

  const partialErrors = [],
    outline = runPartial(partialErrors, 'outline', () =>
      target.file ? quality.getFileOutline(db, repoId, target.file) : null,
    ),
    imports = runPartial(partialErrors, 'deps', () =>
      target.file ? graph.getImportGraph(db, repoId, { file: target.file, direction: 'both', depth }) : null,
    ),
    churn = runPartial(partialErrors, 'churn', () =>
      target.file
        ? gitMetrics.getChurn(db, repoId, target.file, opts.days ? clampInt(opts.days, 90, 1, 3650) : 90, false)
        : null,
    ),
    coupling = runPartial(partialErrors, 'coupling', () =>
      target.file ? impact.getCouplingMetrics(db, repoId, { file: target.file, sortBy: 'instability' }) : null,
    );

  let callers = null,
    callees = null,
    blastRadius = null,
    complexity = null,
    provenance = null;

  if (target.symbol) {
    callers = runPartial(partialErrors, 'callers', () =>
      graph.getCallHierarchy(db, repoId, { symbol: target.symbol, direction: 'callers', depth }),
    );
    callees = runPartial(partialErrors, 'callees', () =>
      graph.getCallHierarchy(db, repoId, { symbol: target.symbol, direction: 'callees', depth }),
    );
    blastRadius = runPartial(partialErrors, 'blast-radius', () =>
      impact.getBlastRadius(db, repoId, { symbol: target.symbol, depth }),
    );
    complexity = runPartial(partialErrors, 'complexity', () =>
      target.symbol_id ? quality.getComplexity(db, repoId, target.symbol_id) : null,
    );
    provenance = runPartial(partialErrors, 'provenance', () => gitMetrics.getProvenance(db, repoId, target.symbol));
  } else {
    blastRadius = runPartial(partialErrors, 'blast-radius', () =>
      impact.getBlastRadius(db, repoId, { file: target.file, maxDepth: depth }),
    );
  }

  {
const likelyTests = findLikelyTests(db, repoId, target, top),
    relatedFiles = collectRelatedFiles({ target, imports, callers, callees, blastRadius, likelyTests }, top),
    summary = summarizeContext({
      target,
      callers,
      callees,
      blastRadius,
      complexity,
      imports,
      coupling,
      churn,
      likelyTests,
    });

  return {
    repo: repo.name,
    target,
    summary,
    recommended_next: recommendedNext(summary, target),
    outline: compactOutline(outline, top),
    callers: compactCallHierarchy(callers, 'callers', top),
    callees: compactCallHierarchy(callees, 'callees', top),
    blast_radius: compactBlastRadius(blastRadius, top),
    deps: compactDeps(imports, top),
    complexity: compactComplexity(complexity),
    churn: compactChurn(churn),
    coupling: compactCoupling(coupling),
    provenance: compactProvenance(provenance),
    likely_tests: likelyTests,
    related_files: relatedFiles,
    partial_errors: partialErrors,
  };
}
}

function resolveSymbolTarget(db, repoId, symbolQuery, fileHint) {
  const rows = db
    .prepare(
      `SELECT id, name, qualified_name, kind, file_path, file_id, start_line, end_line, signature
       FROM code_symbols
       WHERE repo_id = ? AND (name = ? OR qualified_name = ?)
       ORDER BY length(qualified_name), file_path, start_line`,
    )
    .all(repoId, symbolQuery, symbolQuery);

  if (rows.length === 0) {
    return { error: `Symbol "${symbolQuery}" not found` };
  }
  if (rows.length === 1) {
    const row = rows[0];
    return {
      symbol: row.name,
      qualified_name: row.qualified_name,
      kind: row.kind,
      file: row.file_path,
      file_id: row.file_id,
      symbol_id: row.id,
      start_line: row.start_line,
      end_line: row.end_line,
      signature: row.signature || '',
    };
  }

  // Multiple matches — disambiguate by ranking candidates
  {
const preferredKinds = new Set([
      'function',
      'method',
      'class',
      'interface',
      'enum',
      'type_alias',
      'arrow_function',
      'function_expression',
      'constructor',
    ]),
    normalizedHint = fileHint ? fileHint.replace(/\\/g, '/').toLowerCase() : null,
    ranked = rows.map((row) => {
      let score = 0;
      // Strongly prefer if in the hinted file
      if (normalizedHint && row.file_path) {
        const normPath = row.file_path.replace(/\\/g, '/').toLowerCase();
        if (
          normPath === normalizedHint ||
          normPath.endsWith(`/${normalizedHint}`) ||
          normalizedHint.endsWith(`/${normPath}`)
        ) {
          score += 1000;
        }
      }
      // Prefer function/method/class over variable/local
      if (preferredKinds.has(row.kind)) {
        score += 100;
      }
      // Prefer shorter qualified names (more specific, e.g. ClassName.method vs bare method)
      score -= (row.qualified_name || '').length;
      // Slightly prefer symbols earlier in the repo (lower file path)
      score -= row.file_path.length * 0.01;
      return { row, score };
    }),
  best = (() => {

  
    ranked.sort((a, b) => b.score - a.score);
    
  return (ranked[0].row);
})(); return {
    symbol: best.name,
    qualified_name: best.qualified_name,
    kind: best.kind,
    file: best.file_path,
    file_id: best.file_id,
    symbol_id: best.id,
    start_line: best.start_line,
    end_line: best.end_line,
    signature: best.signature || '',
    disambiguated: true,
    alternative_count: rows.length - 1,
  };
}
}

function resolveFileTarget(db, repoId, fileQuery) {
  const row = findFile(db, repoId, fileQuery);
  if (!row) {
    return { error: `File "${fileQuery}" not found` };
  }

  {
const symbols = db
    .prepare(
      `SELECT id, name, qualified_name, kind, start_line, end_line
       FROM code_symbols
       WHERE repo_id = ? AND file_id = ?
       ORDER BY start_line
       LIMIT 50`,
    )
    .all(repoId, row.id);

  return {
    file: row.path,
    file_id: row.id,
    symbols: symbols.map((sym) => ({
      symbol: sym.name,
      qualified_name: sym.qualified_name,
      kind: sym.kind,
      start_line: sym.start_line,
      end_line: sym.end_line,
    })),
  };
}
}

function findFile(db, repoId, fileQuery) {
  const exact = db.prepare('SELECT id, path FROM code_files WHERE repo_id = ? AND path = ?').get(repoId, fileQuery);
  if (exact) {
    return exact;
  }

  return db
    .prepare(
      "SELECT id, path FROM code_files WHERE repo_id = ? AND path LIKE ? ESCAPE '!' ORDER BY length(path) LIMIT 1",
    )
    .get(repoId, `%${likeEscape(fileQuery)}`);
}

function findLikelyTests(db, repoId, target, top) {
  const tests = new Map(),
    add = (path, reason, line = null) => {
      if (!path) {
        return;
      }
      if (!tests.has(path)) {
        tests.set(path, { file: path, reasons: [], line });
      }
      const item = tests.get(path);
      if (!item.reasons.includes(reason)) {
        item.reasons.push(reason);
      }
      if (!item.line && line) {
        item.line = line;
      }
    },
  baseName = (() => {

  
    if (target.symbol_id) {
      const callers = db
        .prepare(
          `SELECT DISTINCT cf.path, cc.line_number
           FROM code_calls cc
           JOIN code_symbols cs ON cs.id = cc.caller_symbol_id
           JOIN code_files cf ON cf.id = cs.file_id
           WHERE cc.repo_id = ? AND cc.callee_symbol_id = ? AND ${testPathSql('cf.path')}
           ORDER BY cf.path
           LIMIT ?`,
        )
        .all(repoId, target.symbol_id, top);
      for (const row of callers) {
        add(row.path, 'calls target symbol', row.line_number);
      }
    }
  
    if (target.file_id) {
      const importers = db
        .prepare(
          `SELECT DISTINCT sf.path, ci.line_number
           FROM code_imports ci
           JOIN code_files sf ON sf.id = ci.source_file_id
           WHERE ci.repo_id = ? AND ci.target_file_id = ? AND ${testPathSql('sf.path')}
           ORDER BY sf.path
           LIMIT ?`,
        )
        .all(repoId, target.file_id, top);
      for (const row of importers) {
        add(row.path, 'imports target file', row.line_number);
      }
    }
  
    
  return (basenameWithoutExt(target.file || target.symbol || ''));
})();if (baseName) {
    const nameMatches = db
      .prepare(
        `SELECT path FROM code_files
         WHERE repo_id = ? AND ${testPathSql('path')} AND path LIKE ? ESCAPE '!'
         ORDER BY path
         LIMIT ?`,
      )
      .all(repoId, `%${likeEscape(baseName)}%`, top);
    for (const row of nameMatches) {
      add(row.path, 'name matches target');
    }
  }

  return [...tests.values()].slice(0, top);
}

function summarizeContext({
  target,
  callers,
  callees,
  blastRadius,
  complexity,
  imports,
  coupling,
  churn,
  likelyTests,
}) {
  const callerCount = Array.isArray(callers?.callers) ? callers.callers.length : 0,
    calleeCount = Array.isArray(callees?.callees) ? callees.callees.length : 0,
    affectedFiles = countAffectedFiles(blastRadius),
    dependencyEdges = Array.isArray(imports?.edges)
      ? imports.edges.length
      : (imports?.upstream?.length || 0) + (imports?.downstream?.length || 0),
    complexityLevel = complexity?.assessment || null,
    churnPerWeek = typeof churn?.churn_per_week === 'number' ? churn.churn_per_week : null,
    couplingRows = Array.isArray(coupling?.files) ? coupling.files : coupling?.metrics || [],
    instability = couplingRows[0] ? couplingRows[0].instability : null, reasons = [];

  let risk = 'low', reviewBar = 'normal';
  
  if (affectedFiles >= 10 || callerCount >= 10) {
    risk = 'high';
    reasons.push('large blast radius');
  } else if (affectedFiles >= 3 || callerCount >= 3 || dependencyEdges >= 5) {
    risk = 'medium';
    reasons.push('multiple dependent files or callers');
  }
  if (complexityLevel === 'high') {
    risk = 'high';
    reasons.push('high complexity');
  } else if (complexityLevel === 'medium' && risk === 'low') {
    risk = 'medium';
    reasons.push('medium complexity');
  }
  if (likelyTests.length === 0 && (target.symbol || target.symbols?.length)) {
    if (risk === 'low') {
      risk = 'medium';
    }
    reasons.push('no likely tests found');
  }
  if (churnPerWeek !== null && churnPerWeek >= 1 && risk !== 'high') {
    risk = 'medium';
    reasons.push('recent churn');
  }

  
  if (risk === 'high') {
    reviewBar = 'high';
  } else if (risk === 'medium') {
    reviewBar = 'normal-plus';
  }

  return {
    risk,
    review_bar: reviewBar,
    direct_callers: callerCount,
    direct_callees: calleeCount,
    affected_files: affectedFiles,
    dependency_edges: dependencyEdges,
    likely_tests: likelyTests.length,
    complexity: complexityLevel,
    churn_per_week: churnPerWeek,
    instability,
    reasons,
  };
}

function recommendedNext(summary, target) {
  const steps = [];
  if (target.file) {
    steps.push(`Read targeted lines in ${target.file}${target.start_line ? ` around ${target.start_line}` : ''}.`);
  }
  if (summary.direct_callers > 0) {
    steps.push('Check caller expectations before changing the public contract.');
  }
  if (summary.likely_tests > 0) {
    steps.push('Run or update the likely tests listed in this context.');
  } else {
    steps.push('Identify or add focused tests before changing behavior.');
  }
  if (summary.risk === 'high') {
    steps.push('Keep the diff narrow and review affected files before editing.');
  }
  return steps;
}

function collectRelatedFiles({ target, imports, callers, callees, blastRadius, likelyTests }, top) {
  const files = new Set();
  if (target.file) {
    files.add(target.file);
  }
  for (const test of likelyTests || []) {
    files.add(test.file);
  }
  for (const edge of imports?.edges || []) {
    if (edge.source) {
      files.add(edge.source);
    }
    if (edge.target && !edge.target.startsWith('.')) {
      files.add(edge.target);
    }
  }
  for (const item of imports?.upstream || []) {
    files.add(item.path);
  }
  for (const item of imports?.downstream || []) {
    files.add(item.path);
  }
  for (const item of callers?.callers || []) {
    files.add(item.file_path);
  }
  for (const item of callees?.callees || []) {
    files.add(item.file_path);
  }
  for (const item of normalizedAffectedFiles(blastRadius)) {
    files.add(item);
  }
  return [...files].filter(Boolean).slice(0, top);
}

function runPartial(errors, name, fn) {
  try {
    const result = fn();
    if (result && result.error) {
      errors.push({ analyzer: name, error: result.error });
      return null;
    }
    return result;
  } catch (err) {
    errors.push({ analyzer: name, error: err && err.message ? err.message : String(err) });
    return null;
  }
}

function compactOutline(outline, top) {
  if (!outline) {
    return null;
  }
  if (outline.directory || outline.not_found) {
    return outline;
  }
  return {
    file: outline.file,
    classes: (outline.classes || []).slice(0, top).map((cls) => ({
      name: cls.name,
      methods: (cls.methods || []).slice(0, top),
    })),
    standalone: (outline.standalone || []).slice(0, top),
  };
}

function compactCallHierarchy(result, key, top) {
  if (!result) {
    return null;
  }
  return {
    symbol: result.symbol,
    direction: result.direction,
    depth: result.depth,
    [key]: (result[key] || []).slice(0, top),
  };
}

function compactBlastRadius(result, top) {
  if (!result) {
    return null;
  }
  return {
    symbol: result.symbol || null,
    file: result.file || result.seed_file || null,
    affected_files: normalizedAffectedFileEntries(result).slice(0, top),
    affected_symbols: (result.affected_symbols || []).slice(0, top),
    callers: (result.callers || []).slice(0, top),
    file_importers: (result.file_importers || []).slice(0, top),
  };
}

function compactDeps(result, top) {
  if (!result) {
    return null;
  }
  return {
    edges: (result.edges || []).slice(0, top),
    upstream: (result.upstream || []).slice(0, top),
    downstream: (result.downstream || []).slice(0, top),
  };
}

function compactComplexity(result) {
  if (!result || Array.isArray(result)) {
    return null;
  }
  return {
    name: result.name,
    file_path: result.file_path,
    cyclomatic: result.cyclomatic,
    nesting_depth: result.nesting_depth,
    lines_of_code: result.lines_of_code,
    assessment: result.assessment,
  };
}

function compactChurn(result) {
  if (!result || result.error) {
    return null;
  }
  return {
    file: result.file,
    commits: result.commits,
    unique_authors: result.unique_authors,
    churn_per_week: result.churn_per_week,
    last_modified: result.last_modified,
  };
}

function compactCoupling(result) {
  if (!result || result.error) {
    return null;
  }
  if (Array.isArray(result.files)) {
    return { files: result.files.slice(0, 10) };
  }
  return result;
}

function compactProvenance(result) {
  if (!result || result.error) {
    return null;
  }
  return {
    symbol: result.symbol,
    last_touched: result.last_touched,
    commit_count: result.commit_count,
    authors: result.authors,
  };
}

function countAffectedFiles(result) {
  return normalizedAffectedFiles(result).length;
}

function normalizedAffectedFiles(result) {
  return normalizedAffectedFileEntries(result)
    .map((item) => item.path || item)
    .filter(Boolean);
}

function normalizedAffectedFileEntries(result) {
  if (!result || !Array.isArray(result.affected_files)) {
    return [];
  }
  return result.affected_files.map((item) => (typeof item === 'string' ? { path: item } : item));
}

function testPathSql(column) {
  return `(${column} LIKE '%/test/%' OR ${column} LIKE '%/__tests__/%' OR ${column} LIKE 'test/%' OR ${column} LIKE '%test.%' OR ${column} LIKE '%spec.%')`;
}

function normalizeText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeFile(value) {
  return normalizeText(value)?.replace(/\\/g, '/') || null;
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function basenameWithoutExt(file) {
  const base = String(file).split('/').pop() || '';
  return base.replace(/\.[^.]+$/, '');
}

function likeEscape(value) {
  return String(value).replace(/[!%_]/g, (m) => `!${m}`);
}

module.exports = {
  getCodingContext,
};
