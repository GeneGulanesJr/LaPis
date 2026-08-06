const sesCmd = require('../../../commands/session');
const wsCmd = require('../../../commands/workspace');
const cleanupCmd = require('../../../scripts/cleanup-sessions');

const USAGE = {
  init: '',
  compact: '',
  dream: '',
  'session-start': '--project X',
  'session-end': '--id ID --memories N --auto true',
  'session-summary': '[--project X]',
  'auto-recover': '--session ID',
  'recover-orphans': '',
  'list-projects': '',
  'list-workspaces': '',
  'create-workspace': '--name X',
  'archive-workspace': '--name X',
  'trust-recovery': '[--repo X]',
  'cleanup-sessions': '[--project X] [--dry-run] [--yes] [--keep-last N] [--include-dream] [--bypass-age-gates]',
};

function register(commands, deps) {
  const {
    sqlJson,
    sqlRun,
    softDeleteObservation,
    _readTierConfig,
    TOOL_TIERS,
    ensureDb,
    DB_PATH,
    getEngine,
    withTransaction,
  } = deps;

  commands.init = () => {
    ensureDb();
    return { ok: true, db: DB_PATH, engine: getEngine() };
  };
  commands.compact = () => sesCmd.compact();
  commands.dream = (args) => sesCmd.dream({ sqlJson, sqlRun, softDeleteObservation }, args);
  commands['session-start'] = (args) =>
    sesCmd.sessionStart({ sqlJson, sqlRun, _readTierConfig, TOOL_TIERS, commands, softDeleteObservation }, args);
  commands['session-end'] = (args) => sesCmd.sessionEnd({ sqlJson, sqlRun, softDeleteObservation }, args);
  commands['session-summary'] = (args) => sesCmd.sessionSummary({ sqlJson, jsonErrNoExit: deps.jsonErrNoExit }, args);
  commands['auto-recover'] = (args) =>
    sesCmd.autoRecover({ sqlJson, sqlRun, jsonErrNoExit: deps.jsonErrNoExit, softDeleteObservation }, args);
  commands['recover-orphans'] = () => sesCmd.recoverOrphans({ sqlJson, sqlRun, softDeleteObservation });
  commands['trust-recovery'] = (args) => sesCmd.trustRecovery(args);
  commands['list-projects'] = () => wsCmd.listProjects(deps);
  commands['list-workspaces'] = () => wsCmd.listWorkspaces(deps);
  commands['create-workspace'] = (args) => wsCmd.createWorkspace(deps, args);
  commands['archive-workspace'] = (args) => wsCmd.archiveWorkspace(deps, args);
  commands['cleanup-sessions'] = (args) => {
    return cleanupCmd.cleanupSessions(
      { sqlJson, sqlRun, withTransaction, softDeleteObservation },
      {
        keepLast: args['keep-last'] ? parseInt(args['keep-last'], 10) : 10,
        project: args.project || null,
        yes: args.yes === true,
        includeDream: args['include-dream'] === true,
        bypassAgeGates: args['bypass-age-gates'] === true,
      },
    );
  };
}

module.exports = { register, USAGE };
