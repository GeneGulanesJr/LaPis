// Module boundary:
// Computes blast radius for a symbol: direct/transitive callers, affected routes, tests, and risk score.
// Wraps existing call-graph analysis with a simpler interface and runtime weighting.

function blastRadius(db, repoId, symbolName, options = {}) {
  const { includeRuntime = true } = options,
    // Find the symbol
    symbolRow = db
      .prepare(`
    SELECT id, name, qualified_name, kind, file_path
    FROM code_symbols
    WHERE repo_id = ? AND (name = ? OR qualified_name = ?)
    LIMIT 1
  `)
      .get(repoId, symbolName, symbolName);

  if (!symbolRow) {
    return { error: `Symbol not found: ${symbolName}` };
  }

  // Direct callers
  {
const directCallers = db
      .prepare(`
    SELECT DISTINCT cs.id, cs.name, cs.qualified_name, cs.kind, cs.file_path
    FROM code_calls cc
    JOIN code_symbols cs ON cs.id = cc.caller_symbol_id
    WHERE cc.repo_id = ? AND cc.callee_symbol_id = ?
  `)
      .all(repoId, symbolRow.id),
    // Transitive callers (2 hops)
    transitiveCallers = db
      .prepare(`
    SELECT DISTINCT cs2.id, cs2.name, cs2.qualified_name, cs2.kind, cs2.file_path
    FROM code_calls cc1
    JOIN code_symbols cs1 ON cs1.id = cc1.caller_symbol_id
    JOIN code_calls cc2 ON cc2.callee_symbol_id = cs1.id
    JOIN code_symbols cs2 ON cs2.id = cc2.caller_symbol_id
    WHERE cc1.repo_id = ? AND cc1.callee_symbol_id = ?
      AND cs2.id != ?
  `)
      .all(repoId, symbolRow.id, symbolRow.id), totalCallers = directCallers.length + transitiveCallers.length;

  // Tests that likely call this symbol.
  // Previous implementation matched test files whose path string contained the
  // Symbol's name — that's a heuristic on the file path, not on call-graph
  // Evidence. It systematically excluded tests like `test/api.test.js` that
  // Import and exercise the symbol, and only matched tests whose file path
  // Happened to embed the symbol name. Use the call graph instead: find any
  // File that contains a symbol whose caller chain reaches the target.
  let likelyTests = [],
  docsAffected = (() => {

    try {
      likelyTests = db
        .prepare(
          `
          SELECT DISTINCT cf.path
          FROM code_calls cc
          JOIN code_symbols caller ON caller.id = cc.caller_symbol_id
          JOIN code_files cf ON cf.id = caller.file_id
          WHERE cc.repo_id = ?
            AND cc.callee_symbol_id = ?
            AND (LOWER(cf.path) LIKE '%test%' OR LOWER(cf.path) LIKE '%spec%')
          UNION
          SELECT DISTINCT cf.path
          FROM code_imports ci
          JOIN code_symbols sym ON sym.file_id = ci.source_file_id
          JOIN code_calls cc ON cc.caller_symbol_id = sym.id
          JOIN code_files cf ON cf.id = ci.source_file_id
          WHERE ci.repo_id = ?
            AND cc.callee_symbol_id = ?
            AND (LOWER(cf.path) LIKE '%test%' OR LOWER(cf.path) LIKE '%spec%')
          LIMIT 20
        `,
        )
        .all(repoId, symbolRow.id, repoId, symbolRow.id);
    } catch {
      likelyTests = [];
    }
  
    // Docs that reference this symbol
    
  return ([]);
})(),
  runtime = (() => {
try {
      const docsWithSymbol = db
        .prepare(`
        SELECT ds.title, df.path as file_path
        FROM doc_sections ds
        JOIN doc_files df ON df.id = ds.file_id
        WHERE ds.repo_id = ? AND ds.content LIKE ?
        LIMIT 10
      `)
        .all(repoId, `%${symbolRow.name}%`);
      docsAffected = docsWithSymbol.map((d) => d.file_path);
    } catch {
      // Doc_sections may not have required structure - graceful degradation
    }
  
    // Runtime hotness (if available)
    
  return (null);
})(), risk = 'low',
    riskScore = 0;if (includeRuntime) {
    try {
      // Try to match by symbol_id first, then by function_name and file_path
      let runtimeData = db
        .prepare(`
        SELECT hit_count, traffic, last_seen
        FROM runtime_symbols
        WHERE repo_id = ? AND symbol_id = ?
      `)
        .get(repoId, symbolRow.id);

      // If not found by symbol_id, try matching by function_name
      if (!runtimeData) {
        runtimeData = db
          .prepare(`
          SELECT hit_count, traffic, last_seen
          FROM runtime_symbols
          WHERE repo_id = ? AND function_name = ? AND file_path LIKE ?
        `)
          .get(repoId, symbolRow.name, `%${symbolRow.file_path}`);
      }

      if (runtimeData) {
        runtime = {
          hit_count: runtimeData.hit_count,
          traffic: runtimeData.traffic,
          last_seen: runtimeData.last_seen,
        };
      }
    } catch {
      // Runtime_symbols table may not exist yet
    }
  }

  // Compute risk based on blast + runtime
  
  

  if (totalCallers >= 20) {
    risk = 'critical';
    riskScore = 90;
  } else if (totalCallers >= 10) {
    risk = 'high';
    riskScore = 70;
  } else if (totalCallers >= 5) {
    risk = 'medium';
    riskScore = 40;
  }

  // Upgrade risk if hot runtime
  if (runtime && runtime.traffic === 'hot' && risk !== 'critical') {
    risk = risk === 'low' ? 'medium' : risk === 'medium' ? 'high' : 'critical';
    riskScore = Math.min(100, riskScore + 20);
  }

  {
const reason =
    runtime && runtime.traffic === 'hot'
      ? `Hot runtime path with ${totalCallers} total callers.`
      : `${totalCallers} total callers (${directCallers.length} direct, ${transitiveCallers.length} transitive).`;

  return {
    symbol: symbolRow.name,
    qualified_name: symbolRow.qualified_name,
    file: symbolRow.file_path,
    kind: symbolRow.kind,
    direct_callers: directCallers.length,
    transitive_callers: transitiveCallers.length,
    total_callers: totalCallers,
    routes_affected: likelyTests.length > 0 ? ['(inferred from test files)'] : [],
    tests_likely_affected: likelyTests.map((t) => t.path),
    docs_affected: docsAffected,
    runtime,
    risk,
    risk_score: riskScore,
    reason,
  };
}
}
}

module.exports = { blastRadius };
