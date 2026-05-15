const { sqlJson, sqlRun, sqlRaw, jsonErrNoExit } = require('../db');
const compactionDomain = require('../src/memory-domain/compaction');

function defaultDeps() {
  return { sqlJson, sqlRun, sqlRaw, jsonErrNoExit };
}

function runCompact(deps = defaultDeps()) {
  return compactionDomain.runCompact(deps);
}

function compact() {
  return runCompact();
}

function dream(deps) {
  return compactionDomain.dream({
    ...deps,
    sqlRaw: deps.sqlRaw || sqlRaw,
  });
}

function trustRecovery(args) {
  return compactionDomain.trustRecovery(defaultDeps(), args);
}

module.exports = { runCompact, compact, dream, trustRecovery };
