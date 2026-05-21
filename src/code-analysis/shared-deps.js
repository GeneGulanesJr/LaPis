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
  UNTETECTED_CONFIDENCE,
  PR_RISK,
  CALL_GRAPH,
} = require('../../constants');
const {
  requireNativeDb: _requireNativeDb,
  SKIP_CALLEE_NAMES: _SKIP_CALLEE_NAMES,
} = require('../../utils');

// PERF: Direct char comparison replaces substring allocation in nesting depth loop.
// Shared function eliminates code duplication between complexity-impl and incremental-builders.
// Do NOT revert to body.substring(). See audit finding: substring allocation per char.
function computeNestingDepth(body) {
  let maxDepth = 0;
  let currentDepth = 0;
  let inString = false;
  let stringChar = '';
  let templateDepth = 0;

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    const prev = i > 0 ? body[i - 1] : '';

    if (!inString && templateDepth === 0 && (ch === '"' || ch === "'")) {
      inString = true;
      stringChar = ch;
      continue;
    }
    if (inString && ch === stringChar && prev !== '\\') {
      inString = false;
      continue;
    }
    if (!inString && ch === '`') {
      templateDepth++;
      continue;
    }
    if (templateDepth === 1 && ch === '`') {
      templateDepth--;
      continue;
    }

    if (!inString || templateDepth > 0) {
      if (ch === '{') {
        currentDepth++;
        maxDepth = Math.max(maxDepth, currentDepth);
      }
      if (ch === '}') {
        if (templateDepth > 0 && body[i + 1] === '}') {
          currentDepth++;
          maxDepth = Math.max(maxDepth, currentDepth);
        }
        if (currentDepth > 0) {
          currentDepth--;
        }
      }
    }
  }

  return maxDepth;
}

module.exports = {
  path,
  codeParser,
  PAGERANK,
  HOTSPOT_THRESHOLDS,
  DEAD_CODE,
  COMPLEXITY,
  COUPLING,
  RESULT_LIMITS,
  UNTETECTED_CONFIDENCE,
  PR_RISK,
  CALL_GRAPH,
  _requireNativeDb,
  _SKIP_CALLEE_NAMES,
  computeNestingDepth,
};
