// src/judgment/adapters/heuristic.js
// The default provider: judgments off. Returning `unavailable` (not throwing,
// not ok-with-empty) is what makes "off" a first-class, exercised path — every
// call site's fallback runs identically in tests and production defaults.

function createHeuristicAdapter() {
  return {
    name: 'heuristic',
    async probe() {
      return { ok: true, mode: 'off' };
    },
    async judge() {
      return { status: 'unavailable', reason: 'judgments off (heuristic provider)' };
    },
  };
}

module.exports = { createHeuristicAdapter };
