'use strict';

/**
 * Hooks-engine — barrel
 *
 * Transport-agnostic, pure-JS extraction of the Pi extension's hook logic.
 * Consumed by the TS Pi extension (thin re-exports / delegating adapters) and,
 * in later phases, by the Claude Code hooks bridge.
 *
 * No imports from extensions/ or Pi ExtensionAPI live here. Only node built-ins
 * and ../../constants (CONTEXT).
 */

module.exports = {
  ...require('./pattern-matcher'),
  ...require('./prompt-classifiers'),
  ...require('./context-builder'),
  ...require('./preflight-assembly'),
  ...require('./passive-capture'),
  ...require('./session-summary'),
  ...require('./guardrail-utils'),
  ...require('./project'),
  ...require('./tool-response-parse'),
};
