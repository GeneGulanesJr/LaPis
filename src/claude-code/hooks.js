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
 * Phase 2 wired the high-value lifecycle: SessionStart, UserPromptSubmit,
 * Stop, SessionEnd. Phase 3 adds the tool-call cadence: PreToolUse guardrails
 * and PostToolUse tracking + tool-state mirroring.
 */

const { stripTuiArtifacts } = require('../mcp/translate-result'),
  dispatchClient = require('./dispatch-client'),
  stateStore = require('./state-store'),
  { handleSessionStart } = require('./handlers/session-start'),
  { handleUserPromptSubmit } = require('./handlers/user-prompt-submit'),
  { handleStop } = require('./handlers/stop'),
  { handleSessionEnd } = require('./handlers/session-end'),
  { handlePreToolUse } = require('./handlers/pre-tool-use'),
  { handlePostToolUse } = require('./handlers/post-tool-use'),
  HANDLERS = {
    SessionStart: handleSessionStart,
    UserPromptSubmit: handleUserPromptSubmit,
    Stop: handleStop,
    SessionEnd: handleSessionEnd,
    PreToolUse: handlePreToolUse,
    PostToolUse: handlePostToolUse,
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
    // Run with no pipe) resolve immediately with an empty payload.
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
 * Parse the optional role-filter flags after the event name. The install
 * config uses these to split one Claude Code event across two handlers (e.g.
 * PostToolUse `--skip git-trust` synchronous + `--only git-trust` async) so a
 * heavy dispatch can run in the background without double-firing.
 */
function parseRoleFilter(argv) {
  let only, skip;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--only' && argv[i + 1]) {
      only = argv[++i];
    } else if (argv[i] === '--skip' && argv[i + 1]) {
      skip = argv[++i];
    }
  }
  if (!only && !skip) {
    return undefined;
  }
  return { only, skip };
}

/**
 * Run a hook. argv is the slice AFTER `claude-code`, e.g. ['hook', 'SessionStart'].
 */
async function runHook(argv, opts = {}) {
  const subcommand = argv[0],
    event = argv[1];

  if (subcommand !== 'hook' || !event) {
    process.stderr.write('Usage: lapis claude-code hook <event> [--only <role>] [--skip <role>]\n');
    process.exitCode ||= 2;
    return;
  }

  {
    const roleFilter = parseRoleFilter(argv),
      // Parse stdin payload (best-effort; malformed → empty object).
      raw = opts.stdin !== undefined ? opts.stdin : await readStdin();
    let payload = {},
      output;
    if (raw && raw.trim()) {
      try {
        payload = JSON.parse(raw);
      } catch (e) {
        process.stderr.write(`claude-code: invalid stdin JSON: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    }

    // Event name precedence: explicit argv > payload.hook_event_name.
    {
      const resolvedEvent = event || payload.hook_event_name,
        handler = HANDLERS[resolvedEvent],
        resolvedDispatchClient = handler ? opts.dispatchClient || dispatchClient : undefined,
        dispatch = handler ? opts.dispatch || resolvedDispatchClient.dispatch : undefined,
        getKnownRepos = handler ? opts.getKnownRepos || resolvedDispatchClient.getKnownRepos : undefined,
        getKnownProjects = handler ? opts.getKnownProjects || resolvedDispatchClient.getKnownProjects : undefined,
        resolvedStateStore = handler ? opts.stateStore || stateStore : undefined;

      if (!handler) {
        // Unknown/unwired event (e.g. PreToolUse in Phase 2): no-op, never crash.
        return;
      }

      // Allow tests / alternate backends to inject the state store and dispatch
      // Client the same way they inject dispatch/getKnownRepos (#231). `dispatch`
      // And `getKnownRepos` fall back to the (possibly injected) client's methods.

      // EnsureDb once — mirrors src/mcp/server.js:118-130.
      if (opts.ensureDb !== false) {
        try {
          require('../../db').ensureDb();
        } catch (e) {
          process.stderr.write(
            `claude-code: database initialization failed: ${e instanceof Error ? e.message : String(e)}\n`,
          );
          process.exitCode ||= 1;
          return;
        }
      }

      try {
        output = await handler({
          payload,
          dispatch,
          dispatchClient: resolvedDispatchClient,
          getKnownRepos,
          getKnownProjects,
          stateStore: resolvedStateStore,
          roleFilter,
        });
      } catch (e) {
        // Hooks must fail open: log to stderr, do NOT set a non-zero exit.
        process.stderr.write(
          `claude-code ${resolvedEvent} handler error: ${e instanceof Error ? e.message : String(e)}\n`,
        );
        return;
      }

      if (output !== null && output !== undefined) {
        process.stdout.write(`${JSON.stringify(sanitizeOutput(output))}\n`);
      }
    }
  }
}

module.exports = { runHook, HANDLERS, sanitizeOutput, parseRoleFilter };
