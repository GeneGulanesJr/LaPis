const astPatterns = require('../../ast-patterns'),
  { createCodeIndexReadRepository } = require('./read-model'),
  { runAnalyzer } = require('./analyzer-runner');

function analyzeScanAstPatterns(db, repoId, opts = {}) {
  const codeIndex = createCodeIndexReadRepository(db),
    guard = codeIndex.guard();
  if (guard) {
    return guard;
  }
  return runAnalyzer('ast-patterns', () => astPatterns.scanAstPatterns(db, repoId, opts));
}

module.exports = { ...astPatterns, scanAstPatterns: analyzeScanAstPatterns };
