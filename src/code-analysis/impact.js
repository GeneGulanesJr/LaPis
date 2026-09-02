const legacy = require('./legacy-core'),
  { createCodeIndexReadRepository } = require('./read-model'),
  { runAnalyzer } = require('./analyzer-runner');

function withRepo(db, analyzer, fn) {
  const codeIndex = createCodeIndexReadRepository(db),
    guard = codeIndex.guard();
  if (guard) {
    return guard;
  }
  return runAnalyzer(analyzer, () => fn(codeIndex));
}

function analyzeGetBlastRadius(db, repoId, opts = {}) {
  return withRepo(db, 'blast-radius', () => {
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE name = 'code_relations'").all();
      if (tables.length > 0) {
        return legacy.getAffectedGraph(db, repoId, opts);
      }
    } catch {}
    return legacy.getBlastRadius(db, repoId, opts);
  });
}

function analyzeBuildPageRank(db, repoId) {
  return withRepo(db, 'importance', () => legacy.buildPageRank(db, repoId));
}

function analyzeGetSymbolImportance(db, repoId, opts = {}) {
  return withRepo(db, 'importance', () => legacy.getSymbolImportance(db, repoId, opts));
}

function analyzeGetCouplingMetrics(db, repoId, opts = {}) {
  return withRepo(db, 'coupling', () => legacy.getCouplingMetrics(db, repoId, opts));
}

function analyzeGetExtractionCandidates(db, repoId, opts = {}) {
  return withRepo(db, 'extractable', () => legacy.getExtractionCandidates(db, repoId, opts));
}

function analyzeGetLayerViolations(db, repoId, opts = {}) {
  return withRepo(db, 'layer-violations', () => legacy.getLayerViolations(db, repoId, opts));
}

module.exports = {
  getBlastRadius: analyzeGetBlastRadius,
  buildPageRank: analyzeBuildPageRank,
  getSymbolImportance: analyzeGetSymbolImportance,
  getCouplingMetrics: analyzeGetCouplingMetrics,
  getExtractionCandidates: analyzeGetExtractionCandidates,
  getLayerViolations: analyzeGetLayerViolations,
};
