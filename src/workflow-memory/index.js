const workflows = require('./workflows');
const steps = require('./steps');
const scoring = require('./scoring');

module.exports = {
  ...workflows,
  recordStep: steps.recordStep,
  stepOutcome: steps.stepOutcome,
  workflows,
  steps,
  scoring,
};
