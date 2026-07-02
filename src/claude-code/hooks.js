'use strict';

/**
 * Claude Code hooks bridge — top-level router.
 *
 * `lapis claude-code hook <event>` reads a JSON payload from stdin, dispatches
 * the matching lifecycle handler, and writes the Claude Code JSON decision to
 * stdout. Mirrors the transport-adapter boundary discipline of src/mcp/server.js:
 *   - owns ensureDb()
 *   - stdout carries ONLY the JSON decision
 *   - all diagnostics → stderr
 *   - hooks fail open (a crash logs to stderr + exits 0, never blocks Claude Code)
 *
 * Lifecycle events inject and summarize context; tool events enforce guardrails
 * and mirror state mutations that happen across Claude Code process boundaries.
 */

const { stripTuiArtifacts } = require('../mcp/translate-result');
const dispatchClient = require('./dispatch-client');
const stateStore = require('./state-store');
const { handleSessionStart } = require('./handlers/session-start');
const { handleUserPromptSubmit } = require('./handlers/user-prompt-submit');
const { handleStop } = require('./handlers/stop');
const { handleSessionEnd } = require('./handlers/session-end');
const { handlePreToolUse } = require('./handlers/pre-tool-use');
const { handlePostToolUse } = require('./handlers/post-tool-use');

const HANDLERS = {
  SessionStart: handleSessionStart,
  UserPromptSubmit: handleUserPromptSubmit,
  PreToolUse: handlePreToolUse,
  PostToolUse: handlePostToolUse,
  Stop: handleStop,
  SessionEnd: handleSessionEnd,
};

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    // Claude Code closes stdin after the payload; if stdin is a TTY (manual
    // run with no pipe) resolve immediately with an empty payload.
    if (process.stdin.isTTY) {
      resolve('');
    }
  });
}

/** Strip TUI artifacts from any string fields in the output envelope. */
function sanitizeOutput(output) {
  if (!output || typeof output !== 'object') {
    return output;
  }
  const hso = output.hookSpecificOutput;
  if (hso && typeof hso.additionalContext === 'string') {
    hso.additionalContext = stripTuiArtifacts(hso.additionalContext);
  }
  return output;
}

/**
 * Run a hook. argv is the slice AFTER `claude-code`, e.g. ['hook', 'SessionStart'].
 */
async function runHook(argv, opts = {}) {
  const subcommand = argv[0];
  const event = argv[1];

  if (subcommand !== 'hook' || !event) {
    process.stderr.write('Usage: lapis claude-code hook <event>\n');
    process.exitCode = process.exitCode || 2;
    return;
  }

  // Parse stdin payload (best-effort; malformed → empty object).
  const raw = opts.stdin !== undefined ? opts.stdin : await readStdin();
  let payload = {};
  if (raw && raw.trim()) {
    try {
      payload = JSON.parse(raw);
    } catch (e) {
      process.stderr.write(`claude-code: invalid stdin JSON: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }

  // Event name precedence: explicit argv > payload.hook_event_name.
  const resolvedEvent = event || payload.hook_event_name;
  const handler = HANDLERS[resolvedEvent];

  if (!handler) {
    // Unknown/unwired event (e.g. PreToolUse in Phase 2): no-op, never crash.
    return;
  }

  const dispatch = opts.dispatch || dispatchClient.dispatch;
  const getKnownRepos = opts.getKnownRepos || dispatchClient.getKnownRepos;

  // ensureDb once — mirrors src/mcp/server.js:118-130.
  if (opts.ensureDb !== false) {
    try {
      require('../../db').ensureDb();
    } catch (e) {
      process.stderr.write(
        `claude-code: database initialization failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      return;
    }
  }

  let output;
  try {
    output = await handler({ payload, dispatch, dispatchClient, getKnownRepos, stateStore });
  } catch (e) {
    // Hooks must fail open: log to stderr, do NOT set a non-zero exit.
    process.stderr.write(`claude-code ${resolvedEvent} handler error: ${e instanceof Error ? e.message : String(e)}\n`);
    return;
  }

  if (output !== null && output !== undefined) {
    process.stdout.write(`${JSON.stringify(sanitizeOutput(output))}\n`);
  }
}

module.exports = { runHook, HANDLERS, sanitizeOutput };
