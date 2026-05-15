const legacy = require('./legacy-core');
const { createCodeIndexReadRepository } = require('./read-model');
const { runAnalyzer } = require('./analyzer-runner');

function analyzeWinnow(db, repoId, opts = {}) {
  const codeIndex = createCodeIndexReadRepository(db);
  const guard = codeIndex.guard();
  if (guard) {
    return guard;
  }
  return runAnalyzer('winnow', () => legacy.winnow(db, repoId, opts));
}

module.exports = { winnow: analyzeWinnow };
