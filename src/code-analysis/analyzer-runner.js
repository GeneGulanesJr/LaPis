const { createCodeIndexReadRepository } = require('./read-model');

function scopedError(analyzer, error) {
  return {
    error: error?.message || String(error),
    analyzer,
    scoped: true,
  };
}

function runAnalyzer(analyzer, fn) {
  try {
    return fn();
  } catch (error) {
    return scopedError(analyzer, error);
  }
}

function withRepo(db, analyzer, fn) {
  const codeIndex = createCodeIndexReadRepository(db),
    guard = codeIndex.guard();
  if (guard) {
    return guard;
  }
  return runAnalyzer(analyzer, () => fn(codeIndex));
}

module.exports = { runAnalyzer, scopedError, withRepo };
