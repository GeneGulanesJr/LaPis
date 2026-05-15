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

module.exports = { runAnalyzer, scopedError };
