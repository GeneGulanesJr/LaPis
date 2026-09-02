// Src/code-analysis/coupling-impl.js
// PageRank computation, coupling metrics, symbol importance, extraction candidates.

const { _requireNativeDb, PAGERANK, COUPLING } = require('./shared-deps'),
  // ══════════════════════════════════════════════════════════
  // PAGERANK CACHE
  // ══════════════════════════════════════════════════════════

  MAX_PAGE_RANK_CACHE_SIZE = PAGERANK.MAX_CACHE_SIZE,
  _pageRankCache = new Map(); // RepoId → { ranks: Map, symbolMap: Map, n: number }

function _prCacheGet(repoId) {
  if (!_pageRankCache.has(repoId)) {
    return undefined;
  }
  // Move to end (most recently used)
  const entry = _pageRankCache.get(repoId);
  _pageRankCache.delete(repoId);
  _pageRankCache.set(repoId, entry);
  return entry;
}

function _prCacheSet(repoId, value) {
  if (_pageRankCache.has(repoId)) {
    _pageRankCache.delete(repoId);
  }
  if (_pageRankCache.size >= MAX_PAGE_RANK_CACHE_SIZE) {
    // Evict oldest (first inserted)
    const oldest = _pageRankCache.keys().next().value;
    _pageRankCache.delete(oldest);
  }
  _pageRankCache.set(repoId, value);
}

function buildPageRank(db, repoId) {
  // Check cache
  const cached = _prCacheGet(repoId),
    guard = !cached ? _requireNativeDb(db) : undefined;
  if (cached) {
    return cached;
  }

  if (guard) {
    return { error: guard.error };
  }

  // Build call graph: caller → [callees]
  const calls = db
      .prepare(`
    SELECT cc.caller_symbol_id, cc.callee_symbol_id
    FROM code_calls cc
    JOIN code_symbols cs ON cs.id = cc.caller_symbol_id
    WHERE cc.repo_id = ? AND cc.callee_symbol_id IS NOT NULL AND cs.repo_id = ?
  `)
      .all(repoId, repoId),
    symbols = db.prepare('SELECT id, name, kind, file_path FROM code_symbols WHERE repo_id = ?').all(repoId),
    symbolSet = new Set(symbols.map((s) => s.id)),
    symbolMap = new Map(symbols.map((s) => [s.id, s])),
    // Build outgoing edges map
    outEdges = new Map(),
    d = PAGERANK.DAMPING_FACTOR,
    n = symbolSet.size,
    baseRank = (1 - d) / n;
  for (const call of calls) {
    if (symbolSet.has(call.caller_symbol_id) && symbolSet.has(call.callee_symbol_id)) {
      if (!outEdges.has(call.caller_symbol_id)) {
        outEdges.set(call.caller_symbol_id, []);
      }
      outEdges.get(call.caller_symbol_id).push(call.callee_symbol_id);
    }
  }

  // PERF(issue #132): Double-buffer PageRank — pre-allocate two Maps and swap instead of
  // Allocating a fresh Map each iteration. For N symbols × 10 iterations this eliminates
  // 10 full-size Map allocations and N×10 constructor insertions, replacing them with
  // In-place value resets on an already-sized hash table.
  // Do NOT replace with single-map in-place update; PageRank requires reading prior-iteration
  // Values (ranks) while writing new values (newRanks) simultaneously.

  let ranks = new Map(),
    newRanks = new Map();
  for (const id of symbolSet) {
    ranks.set(id, 1 / n);
    newRanks.set(id, baseRank);
  }

  for (let i = 0; i < PAGERANK.ITERATIONS; i++) {
    for (const id of symbolSet) {
      newRanks.set(id, baseRank);
    }

    for (const [callerId, calleeIds] of outEdges) {
      const outDegree = calleeIds.length;
      if (outDegree > 0) {
        const rankShare = ranks.get(callerId) / outDegree;
        for (const calleeId of calleeIds) {
          newRanks.set(calleeId, newRanks.get(calleeId) + d * rankShare);
        }
      }
    }

    const tmp = ranks;
    ranks = newRanks;
    newRanks = tmp;
  }

  {
    const result = { ranks, symbolMap, n };
    _prCacheSet(repoId, result);
    return result;
  }
}

// Clear PageRank cache (for testing / reindex)
function clearPageRankCache(repoId) {
  if (repoId) {
    _pageRankCache.delete(repoId);
  } else {
    _pageRankCache.clear();
  }
}

// ══════════════════════════════════════════════════════════
// SYMBOL IMPORTANCE (PageRank on call graph)
// ══════════════════════════════════════════════════════════

function getSymbolImportance(db, repoId, opts = {}) {
  const guard = _requireNativeDb(db),
    topN = !guard ? opts.top || 20 : undefined,
    scope = !guard ? opts.scope || null : undefined,
    pr = !guard ? buildPageRank(db, repoId) : undefined,
    { ranks, symbolMap, n: totalSymbols } = !guard && !pr.error ? pr : undefined;
  if (guard) {
    return guard;
  }
  if (pr.error) {
    return pr;
  }

  // Apply scope filter if provided
  let entries = [...ranks.entries()];
  if (scope) {
    entries = entries.filter(([id]) => {
      const sym = symbolMap.get(id);
      if (sym) {
        return sym.file_path.startsWith(scope);
      }
      return false;
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
// COUPLING METRICS (afferent/efferent/instability per file)
// ══════════════════════════════════════════════════════════

function getCouplingMetrics(db, repoId, opts = {}) {
  const guard = _requireNativeDb(db);
  if (guard) {
    return guard;
  }
  const filePath = opts.file || null,
    minCa = opts.minCa || 0,
    sortBy = opts.sortBy || 'instability', // 'instability', 'afferent', 'efferent'
    // Afferent coupling (Ca): files that import this file
    afferentRows = db
      .prepare(`
    SELECT tf.path as file_path, COUNT(DISTINCT ci.source_file_id) as ca
    FROM code_imports ci
    JOIN code_files tf ON tf.id = ci.target_file_id
    WHERE ci.repo_id = ? AND ci.target_file_id IS NOT NULL
    GROUP BY tf.path
  `)
      .all(repoId),
    // Efferent coupling (Ce): files this file imports
    efferentRows = db
      .prepare(`
    SELECT sf.path as file_path, COUNT(DISTINCT ci.target_file_id) as ce
    FROM code_imports ci
    JOIN code_files sf ON sf.id = ci.source_file_id
    WHERE ci.repo_id = ? AND ci.target_file_id IS NOT NULL AND ci.import_type != 're-export'
    GROUP BY sf.path
  `)
      .all(repoId),
    afferentMap = new Map(afferentRows.map((r) => [r.file_path, r.ca])),
    efferentMap = new Map(efferentRows.map((r) => [r.file_path, r.ce])),
    // Get all files in repo
    allFiles = db.prepare('SELECT path FROM code_files WHERE repo_id = ?').all(repoId),
    results = [];

  for (const f of allFiles) {
    if (filePath && f.path !== filePath && !f.path.endsWith(filePath)) {
      // Skip non-matching files
    } else {
      const ca = afferentMap.get(f.path) || 0,
        ce = efferentMap.get(f.path) || 0,
        total = ca + ce,
        instability = total === 0 ? 0 : Math.round((ce / total) * 100) / 100;
      let category = 'balanced';
      if (instability <= COUPLING.STABLE_THRESHOLD) {
        category = 'stable';
      } else if (instability >= COUPLING.UNSTABLE_THRESHOLD) {
        category = 'unstable';
      }

      if (ca >= minCa) {
        results.push({ file_path: f.path, afferent: ca, efferent: ce, instability, category });
      }
    }
  }

  let sortKey = 'instability';
  if (sortBy === 'afferent') {
    sortKey = 'afferent';
  } else if (sortBy === 'efferent') {
    sortKey = 'efferent';
  }
  results.sort((a, b) => b[sortKey] - a[sortKey]);

  return { metrics: results };
}

// ══════════════════════════════════════════════════════════
// EXTRACTION CANDIDATES (complexity × caller spread)
// ══════════════════════════════════════════════════════════

function getExtractionCandidates(db, repoId, opts = {}) {
  const guard = _requireNativeDb(db);
  if (guard) {
    return guard;
  }
  const minComplexity = opts.minComplexity || 5,
    minCallers = opts.minCallers || 2,
    topN = opts.top || 20,
    // Find symbols with high complexity that are called from multiple files
    rows = db
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
      .all(repoId, minComplexity, minCallers, topN),
    // Parse caller_files from GROUP_CONCAT
    results = rows.map((r) => ({
      ...r,
      caller_files: r.caller_files ? r.caller_files.split(',') : [],
    }));

  return { candidates: results };
}

module.exports = {
  buildPageRank,
  clearPageRankCache,
  getSymbolImportance,
  getCouplingMetrics,
  getExtractionCandidates,
};
