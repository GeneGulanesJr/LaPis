const astPatterns = require('../../ast-patterns'),
  { withRepo } = require('./analyzer-runner');

function analyzeScanAstPatterns(db, repoId, opts = {}) {
  return withRepo(db, 'ast-patterns', () => astPatterns.scanAstPatterns(db, repoId, opts));
}

module.exports = { ...astPatterns, scanAstPatterns: analyzeScanAstPatterns };
