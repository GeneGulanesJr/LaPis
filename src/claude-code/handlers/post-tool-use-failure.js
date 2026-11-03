'use strict';

/**
 * Claude Code PostToolUseFailure handler (async, Bash only). A Bash command
 * that exits non-zero fires this instead of PostToolUse, and failing checks
 * are the ones that matter: `error` carries "Exit code N\n<output>". Silent.
 */

const path = require('node:path'),
  { resolveCwd } = require('../../hooks-engine/project'),
  { captureChecks } = require('./post-tool-use');

async function handlePostToolUseFailure({ payload, dispatch }) {
  if (payload.tool_name !== 'Bash' || payload.is_interrupt) {
    return null;
  }
  const input = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {},
    output = [payload.error, payload.tool_response?.stdout, payload.tool_response?.stderr]
      .filter((s) => typeof s === 'string' && s)
      .join('\n');
  await captureChecks({ command: input.command, output, dispatch, cwd: path.resolve(resolveCwd(payload.cwd)) });
  return null;
}

module.exports = { handlePostToolUseFailure };
