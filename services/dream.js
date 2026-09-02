const { sqlJson, sqlRun, sqlRaw, jsonErrNoExit } = require('../db'), compactionDomain = require('../src/memory-domain/compaction');


function defaultDeps() {
  return { sqlJson, sqlRun, sqlRaw, jsonErrNoExit };
}

function runCompact(deps = defaultDeps()) {
  return compactionDomain.runCompact(deps);
}

function compact() {
  return runCompact();
}

function dream(deps, args) {
  return compactionDomain.dream(
    {
      ...deps,
      sqlRaw: deps.sqlRaw || sqlRaw,
    },
    args,
  );
}

function trustRecovery(args) {
  return compactionDomain.trustRecovery(defaultDeps(), args);
}

function runCompactCheap(deps = defaultDeps()) {
  return compactionDomain.runCompactCheap(deps);
}

function runVacuum(deps = defaultDeps()) {
  return compactionDomain.runVacuum(deps);
}

module.exports = { runCompact, runCompactCheap, runVacuum, compact, dream, trustRecovery };
