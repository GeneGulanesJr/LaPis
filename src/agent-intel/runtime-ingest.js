// Module boundary:
// Ingests Istanbul/NYC coverage JSON and stores runtime hotness per symbol.
// Must not mutate code indexes or memory.

const path = require('path');
const fs = require('fs');

/**
 * Istanbul coverage JSON shape:
 * {
 *   "/path/to/file.js": {
 *     "path": "/path/to/file.js",
 *     "statementMap": { "0": { "start": {...}, "end": {...} } },
 *     "fnMap": { "0": { "name": "fnName", "line": 5, "loc": {...} } },
 *     "s": { "0": 10, "1": 5 },  // statement hits
 *     "f": { "0": 3 }            // function hits
 *   }
 * }
 */

const TRAFFIC_THRESHOLDS = {
  hot: 1000,    // >= 1000 hits in coverage period
  warm: 100,    // >= 100 hits
  cold: 0,      // < 100 hits
};

function classifyTraffic(hitCount) {
  if (hitCount >= TRAFFIC_THRESHOLDS.hot) return 'hot';
  if (hitCount >= TRAFFIC_THRESHOLDS.warm) return 'warm';
  return 'cold';
}

function parseCoverageFile(coveragePath) {
  const raw = fs.readFileSync(coveragePath, 'utf-8');
  return JSON.parse(raw);
}

function extractFunctionHits(coverageData) {
  const results = [];
  for (const [filePath, data] of Object.entries(coverageData)) {
    if (!data || !data.fnMap || !data.f) continue;
    
    const fnMap = data.fnMap;
    const hitCounts = data.f;
    
    for (const [idx, fn] of Object.entries(fnMap)) {
      const hitCount = hitCounts[idx] || 0;
      results.push({
        filePath,
        functionName: fn.name || `anonymous_${idx}`,
        lineStart: fn.line,
        hitCount,
        traffic: classifyTraffic(hitCount),
      });
    }
  }
  return results;
}

function ingestCoverage(db, repoId, coveragePath, sourceFile = '') {
  if (!fs.existsSync(coveragePath)) {
    return { error: `Coverage file not found: ${coveragePath}` };
  }

  const coverageData = parseCoverageFile(coveragePath);
  const functions = extractFunctionHits(coverageData);

  // Pre-fetch symbol_id mapping for this repo to link runtime data to code symbols
  const symbolLookup = new Map();
  try {
    const symbols = db.prepare(`
      SELECT id, name, qualified_name, file_path
      FROM code_symbols
      WHERE repo_id = ?
    `).all(repoId);
    for (const sym of symbols) {
      const key = `${sym.file_path}:${sym.name}`;
      symbolLookup.set(key, sym.id);
      // Also index by qualified name
      if (sym.qualified_name) {
        symbolLookup.set(`${sym.file_path}:${sym.qualified_name}`, sym.id);
      }
    }
  } catch {
    // code_symbols table may not exist yet - continue without linking
  }

  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO runtime_symbols
      (repo_id, symbol_id, file_path, function_name, line_start, hit_count, traffic, last_seen, source_file)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
  `);

  const upsert = db.transaction((fnList) => {
    let inserted = 0;
    let linked = 0;
    for (const fn of fnList) {
      // Look up symbol_id from code_symbols
      let symbolId = null;
      const key = `${fn.filePath}:${fn.functionName}`;
      if (symbolLookup.has(key)) {
        symbolId = symbolLookup.get(key);
        linked++;
      }

      insertStmt.run(repoId, symbolId, fn.filePath, fn.functionName, fn.lineStart, fn.hitCount, fn.traffic, sourceFile);
      inserted++;
    }
    return { inserted, linked };
  });

  const result = upsert(functions);

  return {
    functions_ingested: result.inserted,
    symbols_linked: result.linked,
    traffic_breakdown: {
      hot: functions.filter(f => f.traffic === 'hot').length,
      warm: functions.filter(f => f.traffic === 'warm').length,
      cold: functions.filter(f => f.traffic === 'cold').length,
    },
    source_file: coveragePath,
  };
}

function getHotSymbols(db, repoId, limit = 20) {
  const rows = db.prepare(`
    SELECT rs.*, cs.qualified_name, cs.kind
    FROM runtime_symbols rs
    LEFT JOIN code_symbols cs ON cs.id = rs.symbol_id
    WHERE rs.repo_id = ? AND rs.traffic IN ('hot', 'warm')
    ORDER BY rs.hit_count DESC
    LIMIT ?
  `).all(repoId, limit);

  return rows;
}

function getColdSymbols(db, repoId, limit = 20) {
  const rows = db.prepare(`
    SELECT rs.*, cs.qualified_name, cs.kind
    FROM runtime_symbols rs
    LEFT JOIN code_symbols cs ON cs.id = rs.symbol_id
    WHERE rs.repo_id = ? AND rs.traffic = 'cold'
    ORDER BY rs.hit_count ASC
    LIMIT ?
  `).all(repoId, limit);

  return rows;
}

module.exports = {
  ingestCoverage,
  getHotSymbols,
  getColdSymbols,
  classifyTraffic,
  TRAFFIC_THRESHOLDS,
};
