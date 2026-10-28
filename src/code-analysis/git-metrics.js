const gitAnalysis = require('../../git-analysis'),
  legacy = require('./legacy-core'),
  { withRepo } = require('./analyzer-runner');

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
