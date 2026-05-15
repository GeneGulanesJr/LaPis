const { INITIAL_STEP_ATTEMPTS, INITIAL_STEP_SUCCESS } = require('./scoring');

function parseWorkflowSteps(stepsRaw) {
  if (!stepsRaw) {
    return [];
  }

  return stepsRaw
    .split(/\\n|\n/)
    .map((step) => step.trim())
    .filter(Boolean);
}

function normalizeStepNumber(step) {
  const parsed = typeof step === 'number' ? step : parseInt(step, 10);
  return Number.isNaN(parsed) ? NaN : parsed;
}

function recordStep(deps, { workflow, step, command }) {
  const { workflowRepository, jsonErrNoExit } = deps;
  const stepNumber = normalizeStepNumber(step);

  if (!workflow || Number.isNaN(stepNumber) || !command) {
    return jsonErrNoExit('Missing --workflow, --step, --command');
  }

  workflowRepository.upsertStep({
    workflow,
    stepNum: stepNumber,
    command,
    success: INITIAL_STEP_SUCCESS,
    attempts: INITIAL_STEP_ATTEMPTS,
  });
  return { ok: true };
}

function stepOutcome(deps, { workflow, step, success, workaround }) {
  const { workflowRepository, jsonErrNoExit } = deps;
  const stepNumber = normalizeStepNumber(step);

  if (!workflow || Number.isNaN(stepNumber)) {
    return jsonErrNoExit('Missing --workflow and --step');
  }

  if (success) {
    workflowRepository.recordStepSuccess({ workflow, stepNum: stepNumber });
  } else {
    workflowRepository.recordStepFailure({ workflow, stepNum: stepNumber, workaround: workaround || null });
  }

  const updated = workflowRepository.findStepOutcome({ workflow, stepNum: stepNumber });
  return updated.length > 0 ? { ok: true, ...updated[0] } : { ok: true };
}

module.exports = { parseWorkflowSteps, normalizeStepNumber, recordStep, stepOutcome };
