const { INITIAL_STEP_ATTEMPTS, INITIAL_STEP_SUCCESS } = require('./scoring');
const { parseWorkflowSteps } = require('./steps');

function saveWorkflow(deps, { id, name, project, stepsRaw }) {
  const { workflowRepository, jsonErrNoExit } = deps;
  if (!id || !name) {
    return jsonErrNoExit('Missing --id and --name');
  }

  workflowRepository.insertWorkflow({ id, name, project });

  const steps = parseWorkflowSteps(stepsRaw);
  steps.forEach((command, index) => {
    workflowRepository.upsertStep({
      workflow: id,
      stepNum: index + 1,
      command,
      success: INITIAL_STEP_SUCCESS,
      attempts: INITIAL_STEP_ATTEMPTS,
    });
  });

  return { ok: true, stepsSaved: steps.length };
}

function getWorkflow(deps, { id }) {
  const { workflowRepository, jsonErrNoExit } = deps;
  if (!id) {
    return jsonErrNoExit('Missing --id');
  }

  const meta = workflowRepository.findWorkflow(id);
  if (meta.length === 0) {
    return { error: 'Workflow not found' };
  }

  const steps = workflowRepository.listWorkflowSteps(id);
  return { ...meta[0], steps };
}

module.exports = { saveWorkflow, getWorkflow };
