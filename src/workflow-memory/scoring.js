const { TRUST_DELTA } = require('../../constants');

const INITIAL_STEP_SUCCESS = 1.0;
const INITIAL_STEP_ATTEMPTS = 1;
const MIN_SUCCESS = 0.0;
const MAX_SUCCESS = 1.0;

function clampSuccess(value) {
  return Math.max(MIN_SUCCESS, Math.min(MAX_SUCCESS, value));
}

function successDelta(wasSuccessful) {
  return wasSuccessful ? TRUST_DELTA.STEP_SUCCESS : TRUST_DELTA.STEP_FAILURE;
}

function scoreStepOutcome({ currentSuccess = INITIAL_STEP_SUCCESS, currentAttempts = 0, success }) {
  const numericSuccess = Number(currentSuccess);
  const numericAttempts = Number(currentAttempts);
  return {
    success: clampSuccess(numericSuccess + successDelta(success)),
    attempts: numericAttempts + 1,
  };
}

module.exports = {
  INITIAL_STEP_SUCCESS,
  INITIAL_STEP_ATTEMPTS,
  MIN_SUCCESS,
  MAX_SUCCESS,
  clampSuccess,
  successDelta,
  scoreStepOutcome,
};
