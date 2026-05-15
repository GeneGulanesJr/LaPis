const workflowMemory = require('../src/workflow-memory');
const { createWorkflowRepository } = require('../src/platform/storage/repositories/workflow');

function workflowDeps(deps) {
  return {
    jsonErrNoExit: deps.jsonErrNoExit,
    workflowRepository: deps.workflowRepository || createWorkflowRepository(deps),
  };
}

function saveWorkflow(deps, params) {
  return workflowMemory.saveWorkflow(workflowDeps(deps), params);
}

function recordStep(deps, params) {
  return workflowMemory.recordStep(workflowDeps(deps), params);
}

function stepOutcome(deps, params) {
  return workflowMemory.stepOutcome(workflowDeps(deps), params);
}

function getWorkflow(deps, params) {
  return workflowMemory.getWorkflow(workflowDeps(deps), params);
}

module.exports = { saveWorkflow, recordStep, stepOutcome, workflowDeps, getWorkflow };
