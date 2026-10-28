const recoveryService = require('../services/recovery'),
  sessionsService = require('../src/memory-domain/sessions'),
  dreamService = require('../services/dream');

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
      runCompactCheap: dreamService.runCompactCheap,
      runVacuum: dreamService.runVacuum,
      checkpointWal: dreamService.checkpointWal,
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

async function dream(deps, args) {
  // Slice 1 annotation: judge-verify dream candidates (advisory, default-off).
  // Inert unless LAPIS_JUDGE_PROVIDER=decision + LIQUID_API_KEY + surface enabled.
  // Runs before dream: dream soft-deletes the very candidates it reviews.
  const review = await require('../src/memory-domain/dream-decision').maybeDreamDecisionReview({
      sqlJson: deps.sqlJson,
    }),
    result = dreamService.dream(
      {
        sqlJson: deps.sqlJson,
        sqlRun: deps.sqlRun,
        softDeleteObservation: (id) => deps.softDeleteObservation(id),
      },
      args,
    );
  if (review) result.dreamDecisionReview = review;
  return result;
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
