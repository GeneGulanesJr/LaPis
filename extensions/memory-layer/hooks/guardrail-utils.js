'use strict';

// Thin re-export of the pure engine module.
// Consumers: extensions/memory-layer/hooks/tool-guardrails.ts (functions +
// Constants) and test/tool-guardrails.test.js (functions only).
const engine = require('../../../src/hooks-engine/guardrail-utils.js');

module.exports = {
  isPipedOutputFilter: engine.isPipedOutputFilter,
  isTargetedSymbolLookup: engine.isTargetedSymbolLookup,
  isTargetedTextFileLookup: engine.isTargetedTextFileLookup,
  isRawCodeDiscoveryCommand: engine.isRawCodeDiscoveryCommand,
  isSearchCommandStage: engine.isSearchCommandStage,
  extractPathArgs: engine.extractPathArgs,
  CONFIG_FILENAMES: engine.CONFIG_FILENAMES,
  RAW_CODE_DISCOVERY_RE: engine.RAW_CODE_DISCOVERY_RE,
  CODE_PATH_HINT_RE: engine.CODE_PATH_HINT_RE,
};
