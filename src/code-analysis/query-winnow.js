const legacy = require('./legacy-core'),
  { createCodeIndexReadRepository } = require('./read-model'),
  { runAnalyzer } = require('./analyzer-runner');

function analyzeWinnow(db, repoId, opts = {}) {
  const codeIndex = createCodeIndexReadRepository(db),
    guard = codeIndex.guard();
  if (guard) {
    return guard;
  }
  return runAnalyzer('winnow', () => legacy.winnow(db, repoId, opts));
}

module.exports = { winnow: analyzeWinnow };
