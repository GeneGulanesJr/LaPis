const { jsonOk, jsonCreated, jsonError } = require('../errors');

function writeVerdict(repo) {
  return async (req, res, ctx) => {
    const errors = validateVerdictPayload(ctx.body);
    if (errors.length > 0) {
      jsonError(res, 400, 'invalid_verdict', errors.join('; '));
      return;
    }

    {
const { sessionId, ...verdict } = ctx.body,
      id = `vv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      rows = repo.createVerdict({ id, sessionId, ...verdict });
    jsonCreated(res, rows[0] || { id, sessionId, ...verdict, timestamp: new Date().toISOString() });
  }
};
}

function classifyVerdict(repo) {
  return async (req, res, ctx) => {
    const { classification } = ctx.body;
    repo.classifyVerdict(ctx.params.id, classification);
    jsonOk(res, { ok: true });
  };
}

function getVerdicts(repo) {
  return async (req, res, ctx) => {
    const verdicts = repo.getVerdicts(ctx.params.milestoneId);
    jsonOk(res, verdicts);
  };
}

function validateVerdictPayload(body) {
  const errors = [];
  if (!body || typeof body !== 'object') {
    return ['body must be a JSON object'];
  }

  for (const field of ['sessionId', 'milestoneId', 'contractId', 'validatorType', 'verdict', 'findings']) {
    if (typeof body[field] !== 'string' || body[field].trim().length === 0) {
      errors.push(`${field} is required`);
    }
  }

  if (!['validator_scrutiny', 'validator_user_testing'].includes(body.validatorType)) {
    errors.push('validatorType must be validator_scrutiny or validator_user_testing');
  }

  if (!['pass', 'fail'].includes(body.verdict)) {
    errors.push('verdict must be pass or fail');
  }

  if (!Array.isArray(body.failedUnitIds)) {
    errors.push('failedUnitIds must be an array');
  } else if (body.failedUnitIds.some((id) => typeof id !== 'string' || id.trim().length === 0)) {
    errors.push('failedUnitIds must contain only non-empty strings');
  }

  return errors;
}

module.exports = { writeVerdict, classifyVerdict, getVerdicts, validateVerdictPayload };
