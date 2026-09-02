'use strict';

const { jsonError, jsonOk } = require('../errors');

/**
 * Merge an optional top-level `project` into dispatch args without clobbering
 * an explicit args.project.
 */
function mergeDispatchArgs(body) {
  const args = body?.args && typeof body.args === 'object' && !Array.isArray(body.args) ? { ...body.args } : {};
  if (body?.project !== undefined && body?.project !== null && body?.project !== '' && args.project === undefined) {
    args.project = body.project;
  }
  return args;
}

function dispatchCommand(deps) {
  return async (req, res, ctx) => {
    const cmd = ctx.body?.cmd;
    if (!cmd || typeof cmd !== 'string') {
      return jsonError(res, 400, 'bad_request', 'Missing or invalid "cmd"');
    }

    const dispatchFn = deps.dispatch || require('../../cli/gateway').dispatch,
      result = await dispatchFn(cmd, mergeDispatchArgs(ctx.body));
    jsonOk(res, result);
  };
}

module.exports = { dispatchCommand, mergeDispatchArgs };
