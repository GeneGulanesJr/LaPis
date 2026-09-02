const legacy = require('./legacy-core'), { createCodeIndexReadRepository } = require('./read-model'), { runAnalyzer } = require('./analyzer-runner');



function withRepo(db, analyzer, fn) {
  const codeIndex = createCodeIndexReadRepository(db),
    guard = codeIndex.guard();
  if (guard) {
    return guard;
  }
  return runAnalyzer(analyzer, () => fn(codeIndex));
}

function analyzeBuildImportGraph(db, repoId) {
  return withRepo(db, 'import-graph', () => legacy.buildImportGraph(db, repoId));
}

function analyzeBuildCallGraph(db, repoId, opts = {}) {
  return withRepo(db, 'call-graph', () => legacy.buildCallGraph(db, repoId, opts));
}

function analyzeGetImportGraph(db, repoId, opts = {}) {
  return withRepo(db, 'import-graph', () => legacy.getImportGraph(db, repoId, opts));
}

function analyzeGetCallHierarchy(db, repoId, opts = {}) {
  return withRepo(db, 'call-hierarchy', () => legacy.getCallHierarchy(db, repoId, opts));
}

function analyzeGetDependencyCycles(db, repoId) {
  return withRepo(db, 'cycles', () => legacy.getDependencyCycles(db, repoId));
}

function analyzeGetClassHierarchy(db, repoId, opts = {}) {
  return withRepo(db, 'hierarchy', () => legacy.getClassHierarchy(db, repoId, opts));
}

function analyzeGetSignalChains(db, repoId, opts = {}) {
  return withRepo(db, 'signal-chains', () => legacy.getSignalChains(db, repoId, opts));
}

module.exports = {
  buildImportGraph: analyzeBuildImportGraph,
  buildCallGraph: analyzeBuildCallGraph,
  getImportGraph: analyzeGetImportGraph,
  getCallHierarchy: analyzeGetCallHierarchy,
  getDependencyCycles: analyzeGetDependencyCycles,
  getClassHierarchy: analyzeGetClassHierarchy,
  getSignalChains: analyzeGetSignalChains,
  extractImportBindings: legacy.extractImportBindings,
};
