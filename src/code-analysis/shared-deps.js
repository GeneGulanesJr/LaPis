// Src/code-analysis/shared-deps.js
// Shared imports used across code-analysis modules.
// Centralized to avoid duplicating require() calls in every module.

const path = require('path'),
  codeParser = require('../../parse-code'),
  {
    PAGERANK,
    HOTSPOT_THRESHOLDS,
    DEAD_CODE,
    COMPLEXITY,
    COUPLING,
    RESULT_LIMITS,
    UNDETECTED_CONFIDENCE,
    PR_RISK,
    CALL_GRAPH,
  } = require('../../constants'),
  { requireNativeDb: _requireNativeDb, SKIP_CALLEE_NAMES: _SKIP_CALLEE_NAMES } = require('../../utils');

module.exports = {
  path,
  codeParser,
  PAGERANK,
  HOTSPOT_THRESHOLDS,
  DEAD_CODE,
  COMPLEXITY,
  COUPLING,
  RESULT_LIMITS,
  UNDETECTED_CONFIDENCE,
  PR_RISK,
  CALL_GRAPH,
  _requireNativeDb,
  _SKIP_CALLEE_NAMES,
};
