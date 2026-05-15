const sesCmd = require('../../../commands/session');
const wsCmd = require('../../../commands/workspace');
const obsDA = require('../../../data-access/observations');

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
};

function register(commands, deps) {
  const { sqlJson, sqlRun, softDeleteObservation, _readTierConfig, TOOL_TIERS, ensureDb, DB_PATH, getEngine } = deps;

  commands.init = () => { ensureDb(); return { ok: true, db: DB_PATH, engine: getEngine() }; };
  commands.compact = () => sesCmd.compact();
  commands.dream = () => sesCmd.dream({ sqlJson, sqlRun, softDeleteObservation });
  commands['session-start'] = (args) => sesCmd.sessionStart({ sqlJson, sqlRun, _readTierConfig, TOOL_TIERS, commands, softDeleteObservation }, args);
  commands['session-end'] = (args) => sesCmd.sessionEnd({ sqlJson, sqlRun, softDeleteObservation }, args);
  commands['session-summary'] = (args) => sesCmd.sessionSummary({ sqlJson, jsonErrNoExit: deps.jsonErrNoExit }, args);
  commands['auto-recover'] = (args) => sesCmd.autoRecover({ sqlJson, sqlRun, jsonErrNoExit: deps.jsonErrNoExit, softDeleteObservation }, args);
  commands['recover-orphans'] = () => sesCmd.recoverOrphans({ sqlJson, sqlRun, softDeleteObservation });
  commands['trust-recovery'] = (args) => sesCmd.trustRecovery(args);
  commands['list-projects'] = () => wsCmd.listProjects(deps);
  commands['list-workspaces'] = () => wsCmd.listWorkspaces(deps);
  commands['create-workspace'] = (args) => wsCmd.createWorkspace(deps, args);
  commands['archive-workspace'] = (args) => wsCmd.archiveWorkspace(deps, args);
}

module.exports = { register, USAGE };
