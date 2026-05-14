const workflowDA = require('../data-access/workflows');

function saveWorkflow(deps, args) {
  return workflowDA.saveWorkflow(deps, {
    id: args.id,
    name: args.name,
    project: args.project || null,
    stepsRaw: args.steps || null,
  });
}

function recordStep(deps, args) {
  return workflowDA.recordStep(deps, {
    workflow: args.workflow,
    step: parseInt(args.step),
    command: args.command,
  });
}

function stepOutcome(deps, args) {
  return workflowDA.stepOutcome(deps, {
    workflow: args.workflow,
    step: parseInt(args.step),
    success: args.success === 'true',
    workaround: args.workaround || null,
  });
}

function getWorkflow(deps, args) {
  return workflowDA.getWorkflow(deps, { id: args.id });
}

module.exports = { saveWorkflow, recordStep, stepOutcome, getWorkflow };