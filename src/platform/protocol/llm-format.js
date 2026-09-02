const { buildAnalysisEnvelope } = require('./envelope'), wireFormat = require('./compact-format'),
  DEFAULT_STRIP_FIELDS = ['symbol_id', 'id'];


function compactAnalysis(data, opts = {}) {
  return wireFormat.compactResponse(data, { stripFields: opts.stripFields || DEFAULT_STRIP_FIELDS });
}

function autoCompactAnalysis(data, opts = {}) {
  if (wireFormat.autoFormat(data) !== 'compact') {
    return data;
  }
  return compactAnalysis(data, opts);
}

function formatAnalysisForLlm(toolName, data, repoRow, startTime, format, deps) {
  const wrapped = buildAnalysisEnvelope(toolName, data, repoRow, startTime, deps);
  if (format === 'compact') {
    wrapped.data = compactAnalysis(wrapped.data, { stripFields: DEFAULT_STRIP_FIELDS });
  } else if (format === 'auto') {
    wrapped.data = autoCompactAnalysis(wrapped.data, { stripFields: DEFAULT_STRIP_FIELDS });
  }
  return wrapped;
}

module.exports = { DEFAULT_STRIP_FIELDS, compactAnalysis, autoCompactAnalysis, formatAnalysisForLlm };
