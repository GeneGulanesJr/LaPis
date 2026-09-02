const gitAnalysis = require('../../git-analysis'), legacy = require('./legacy-core'), { createCodeIndexReadRepository } = require('./read-model'), { runAnalyzer } = require('./analyzer-runner');




function withRepo(db, analyzer, fn) {
  const codeIndex = createCodeIndexReadRepository(db),
    guard = codeIndex.guard();
  if (guard) {
    return guard;
  }
  return runAnalyzer(analyzer, () => fn(codeIndex));
}

function analyzeGetChurn(db, repoId, filePath = '__all__', days = 90, refresh = false) {
  return withRepo(db, 'churn', () => gitAnalysis.getChurn(db, repoId, filePath, days, refresh));
}

function analyzeGetProvenance(db, repoId, symbolName) {
  return withRepo(db, 'provenance', () => gitAnalysis.getProvenance(db, repoId, symbolName));
}

function analyzeGetHotspots(db, repoId, opts = {}) {
  return withRepo(db, 'hotspots', () => legacy.getHotspots(db, repoId, opts));
}

module.exports = {
  getChurn: analyzeGetChurn,
  getProvenance: analyzeGetProvenance,
  getHotspots: analyzeGetHotspots,
  isGitAvailable: gitAnalysis.isGitAvailable,
  classifyCommit: gitAnalysis.classifyCommit,
};
