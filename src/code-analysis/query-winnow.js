const legacy = require('./legacy-core'),
  { withRepo } = require('./analyzer-runner');

function analyzeWinnow(db, repoId, opts = {}) {
  return withRepo(db, 'winnow', () => legacy.winnow(db, repoId, opts));
}

module.exports = { winnow: analyzeWinnow };
