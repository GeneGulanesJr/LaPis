// Src/code-analysis/shared-deps.js
// Shared imports used across code-analysis modules.
// Centralized to avoid duplicating require() calls in every module.

const path = require('path');
const codeParser = require('../../parse-code');
const {
  PAGERANK,
  HOTSPOT_THRESHOLDS,
  DEAD_CODE,
  COMPLEXITY,
  COUPLING,
  RESULT_LIMITS,
  UNDETECTED_CONFIDENCE,
  PR_RISK,
  CALL_GRAPH,
} = require('../../constants');
const { requireNativeDb: _requireNativeDb, SKIP_CALLEE_NAMES: _SKIP_CALLEE_NAMES } = require('../../utils');

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
