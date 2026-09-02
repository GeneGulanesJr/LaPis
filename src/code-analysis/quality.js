const legacy = require('./legacy-core'), { createCodeIndexReadRepository } = require('./read-model'), { runAnalyzer } = require('./analyzer-runner');



function withRepo(db, analyzer, fn) {
  const codeIndex = createCodeIndexReadRepository(db),
    guard = codeIndex.guard();
  if (guard) {
    return guard;
  }
  return runAnalyzer(analyzer, () => fn(codeIndex));
}

function analyzeGetDeadCode(db, repoId, opts = {}) {
  return withRepo(db, 'dead-code', () => legacy.getDeadCode(db, repoId, opts));
}

function analyzeBuildComplexity(db, repoId) {
  return withRepo(db, 'complexity', () => legacy.buildComplexity(db, repoId));
}

function analyzeGetComplexity(db, repoId, symbolId) {
  return withRepo(db, 'complexity', () => legacy.getComplexity(db, repoId, symbolId));
}

function analyzeGetFileOutline(db, repoId, filePath) {
  return withRepo(db, 'outline', () => legacy.getFileOutline(db, repoId, filePath));
}

function analyzeGetUntestedSymbols(db, repoId, opts = {}) {
  return withRepo(db, 'untested', () => legacy.getUntestedSymbols(db, repoId, opts));
}

module.exports = {
  getDeadCode: analyzeGetDeadCode,
  buildComplexity: analyzeBuildComplexity,
  getComplexity: analyzeGetComplexity,
  getFileOutline: analyzeGetFileOutline,
  getUntestedSymbols: analyzeGetUntestedSymbols,
};
