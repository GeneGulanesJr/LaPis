const wfCmd = require('../../../commands/workflow');

const USAGE = {};

function register(commands, deps) {
  const { sqlJson, sqlRun, jsonErrNoExit, repositories } = deps;
  const workflowRepository = repositories && repositories.workflow;

  commands['save-workflow'] = (args) =>
    wfCmd.saveWorkflow({ sqlJson, sqlRun, jsonErrNoExit, workflowRepository }, args);
  commands['record-step'] = (args) => wfCmd.recordStep({ sqlJson, sqlRun, jsonErrNoExit, workflowRepository }, args);
  commands['step-outcome'] = (args) => wfCmd.stepOutcome({ sqlJson, sqlRun, jsonErrNoExit, workflowRepository }, args);
  commands['get-workflow'] = (args) => wfCmd.getWorkflow({ sqlJson, jsonErrNoExit, workflowRepository }, args);
}

module.exports = { register, USAGE };
