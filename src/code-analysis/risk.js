const legacy = require('./legacy-core'),
  { withRepo } = require('./analyzer-runner');

function analyzeGetPrRiskProfile(db, repoId, opts = {}) {
  return withRepo(db, 'pr-risk', () => legacy.getPrRiskProfile(db, repoId, opts));
}

module.exports = { getPrRiskProfile: analyzeGetPrRiskProfile };
