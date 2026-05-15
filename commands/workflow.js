const workflowMemory = require('../src/workflow-memory');
const { createWorkflowRepository } = require('../src/platform/storage/repositories/workflow');

function getWorkflowServiceDeps(deps) {
  return {
    jsonErrNoExit: deps.jsonErrNoExit,
    workflowRepository: deps.workflowRepository || createWorkflowRepository(deps),
  };
}

function saveWorkflow(deps, args) {
  return workflowMemory.saveWorkflow(getWorkflowServiceDeps(deps), {
    id: args.id,
    name: args.name,
    project: args.project || null,
    stepsRaw: args.steps || null,
  });
}

function recordStep(deps, args) {
  return workflowMemory.recordStep(getWorkflowServiceDeps(deps), {
    workflow: args.workflow,
    step: parseInt(args.step, 10),
    command: args.command,
  });
}

function stepOutcome(deps, args) {
  return workflowMemory.stepOutcome(getWorkflowServiceDeps(deps), {
    workflow: args.workflow,
    step: parseInt(args.step, 10),
    success: args.success === 'true',
    workaround: args.workaround || null,
  });
}

function getWorkflow(deps, args) {
  return workflowMemory.getWorkflow(getWorkflowServiceDeps(deps), { id: args.id });
}

module.exports = { saveWorkflow, recordStep, stepOutcome, getWorkflow, getWorkflowServiceDeps };
