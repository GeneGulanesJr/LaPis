const legacy = require('./legacy-core'),
  { createCodeIndexReadRepository } = require('./read-model'),
  { runAnalyzer } = require('./analyzer-runner');

function analyzeGetPrRiskProfile(db, repoId, opts = {}) {
  const codeIndex = createCodeIndexReadRepository(db),
    guard = codeIndex.guard();
  if (guard) {
    return guard;
  }
  return runAnalyzer('pr-risk', () => legacy.getPrRiskProfile(db, repoId, opts));
}

module.exports = { getPrRiskProfile: analyzeGetPrRiskProfile };
