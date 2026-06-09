const recoveryService = require('../services/recovery');
const sessionsService = require('../services/sessions');
const dreamService = require('../services/dream');

function sessionStart(deps, args) {
  return sessionsService.sessionStart(
    {
      sqlJson: deps.sqlJson,
      sqlRun: deps.sqlRun,
      autoRecoverInternal: (sessionId) => recoveryService.autoRecoverInternal(deps, sessionId),
      _readTierConfig: deps._readTierConfig,
      TOOL_TIERS: deps.TOOL_TIERS,
      commands: deps.commands,
    },
    args,
  );
}

function sessionEnd(deps, args) {
  return sessionsService.sessionEnd(
    {
      sqlJson: deps.sqlJson,
      sqlRun: deps.sqlRun,
      trustRecovery: dreamService.trustRecovery,
      runCompact: dreamService.runCompact,
    },
    args,
  );
}

function sessionSummary(deps, args) {
  return sessionsService.sessionSummary(
    {
      sqlJson: deps.sqlJson,
      jsonErrNoExit: deps.jsonErrNoExit,
      findLatestSession: sessionsService.findLatestSession,
    },
    args,
  );
}

function autoRecover(deps, args) {
  return recoveryService.autoRecover(deps, args);
}

function recoverOrphans(deps) {
  return recoveryService.recoverOrphans(deps);
}

function dream(deps, args) {
  return dreamService.dream(
    {
      sqlJson: deps.sqlJson,
      sqlRun: deps.sqlRun,
      softDeleteObservation: (id) => deps.softDeleteObservation(id),
    },
    args,
  );
}

function compact() {
  return dreamService.compact();
}

function trustRecovery(args) {
  return dreamService.trustRecovery(args);
}

module.exports = {
  sessionStart,
  sessionEnd,
  sessionSummary,
  autoRecover,
  recoverOrphans,
  dream,
  compact,
  trustRecovery,
};
