// src/token-saver/classify-decision.js
// Slice F: guard classify cascade — regex-first, judgment on ambiguous only.
//
// classifyCommand() is SYNC and DEFINITIVE for every command a COMMAND_RULES
// regex matches. Its ONLY ambiguous verdict is the documented default
// 'generic' ("matched no rule"). This module re-asks just that ambiguous case
// as ONE 'classify' judgment (surface 'guard') over the real COMMAND_RULES
// taxonomy. Any judgment failure degrades to the sync classification exactly
// (FAIL-SAFE: never more permissive than today's conservative default).
// Never throws.
//
// SHAPE DECISION (read from the code): the sync result is a plain STRING
// (a COMMAND_RULES type, consumed as the COMPRESSORS map key in
// compress-output.js and embedded in token-saver result objects). A string
// cannot carry `source: 'judgment'` — so classifyCommandDetailed() returns
// { type, source, confidence? } (provenance observable for tests/metrics) and
// the public classifyCommandWithJudge() returns exactly `.type`: the SAME
// string shape as the sync classifier, judgment-informed when confident.

// When on, it runs inside `lapis run <command>` BEFORE the command, only for a
// command no COMMAND_RULES regex matched: ONE request, capped at
// judgment.surface_timeout_ms with no retries (src/judgment/surface.js).

const { classifyCommand } = require('./classify-command');
const { surfaceEnabled, buildSurfaceJudge } = require('../judgment/surface');
const { CONFIDENT_THRESHOLD, capText } = require('../judgment/internal');
const { logSurfaceCall, capReason, round3 } = require('../judgment/log');

// The file's real taxonomy: every COMMAND_RULES type + the 'generic' default.
// 'generic' stays in the enum so the judge can answer "none of the above" —
// which then reproduces today's classification byte-for-byte.
const COMMAND_CLASSES = ['git-diff', 'git-status', 'test', 'install', 'file-read', 'list', 'search', 'logs', 'generic'];

/**
 * Guard: should the token-saver consult judgment for ambiguous command
 * classification? Default-off — requires provider=decision + machine-scoped key +
 * 'guard' surface not disabled. Mirrors dreamDecisionEnabled/searchDecisionEnabled.
 */
function guardDecisionEnabled() {
  return surfaceEnabled('guard');
}

/**
 * classifyCommandDetailed(commandArgs, { judge, floor }) — async cascade.
 * Returns { type, source: 'sync'|'judgment', confidence? }. NEVER throws:
 * even a throwing sync classifier degrades to 'generic'.
 */
async function classifyCommandDetailed(commandArgs, { judge, floor } = {}) {
  let syncType;
  try {
    syncType = classifyCommand(commandArgs);
  } catch {
    return { type: 'generic', source: 'sync' }; // sync itself failed; conservative default
  }
  // DEFINITIVE = a positive COMMAND_RULES match (any type other than the
  // documented default). The judge is NEVER consulted for these.
  if (syncType !== 'generic') return { type: syncType, source: 'sync' };
  if (!judge) return { type: syncType, source: 'sync' };
  const started = Date.now();
  // One log line per consulted judgment: the pick and confidence only — the
  // command text never goes to the log.
  const log = (fields) => logSurfaceCall('guard', started, fields);
  try {
    const result = await judge(
      [
        {
          id: 'guard-0',
          judgment: { kind: 'classify', enum: COMMAND_CLASSES },
          instructions:
            'Classify this bash command by what it does, for read-output triage ' +
            '(browse-vs-targeted-vs-other). git-diff = shows repository changes (git diff); ' +
            'git-status = git status; test = runs a test suite; install = installs or adds ' +
            'dependencies; file-read = prints or previews file contents; list = lists ' +
            'directory contents; search = searches file contents; logs = tails or reads ' +
            'service/application logs. Choose the single best class; choose generic if the ' +
            'command fits none of these or you are unsure (mutations, builds, network calls, ' +
            'long-running jobs).',
          state: { command: capText(commandArgs.join(' '), 500) },
        },
      ],
      { surface: 'guard' },
    );
    if (!result || result.status !== 'ok') {
      log({ status: (result && result.status) || 'unavailable', reason: capReason(result && result.reason) });
      return { type: syncType, source: 'sync' };
    }
    const a = result.answers && result.answers.find((x) => x && x.id === 'guard-0');
    const minConf = typeof floor === 'number' ? floor : CONFIDENT_THRESHOLD;
    if (
      !a ||
      a.pick === undefined ||
      a.pick === 'generic' || // "none of the above" = judgment confirms today's default
      !COMMAND_CLASSES.includes(a.pick) ||
      typeof a.confidence !== 'number' ||
      a.confidence < minConf
    ) {
      log({ status: 'ok', pick: a ? a.pick : null, confidence: round3(a && a.confidence), used: false });
      return { type: syncType, source: 'sync' };
    }
    log({ status: 'ok', pick: a.pick, confidence: round3(a.confidence), used: true });
    return { type: a.pick, source: 'judgment', confidence: a.confidence };
  } catch (e) {
    log({ status: 'error', reason: capReason(e && e.message) });
    return { type: syncType, source: 'sync' };
  }
}

/**
 * classifyCommandWithJudge(commandArgs, { judge, floor }) — same return SHAPE
 * as the sync classifyCommand (a type string). Judgment-informed string only
 * when: judge ok + pick inside the taxonomy + confidence ≥ floor (default
 * CONFIDENT_THRESHOLD = 0.6). Otherwise the sync result, unchanged.
 */
async function classifyCommandWithJudge(commandArgs, opts = {}) {
  return (await classifyCommandDetailed(commandArgs, opts)).type;
}

/**
 * maybeClassifyCommand(commandArgs, args) — the ONE guarded entry point for
 * the seam (src/token-saver/index.js). Disabled → plain sync classification,
 * byte-identical to pre-judgment behavior. Enabled → the cascade, all
 * failures already contained. args._judge passes through for tests.
 */
async function maybeClassifyCommand(commandArgs, args = {}) {
  if (!guardDecisionEnabled()) return classifyCommand(commandArgs);
  // Only the test seam is read from args: here args are executeAndCompress()
  // options, whose timeoutMs is the COMMAND's timeout, not the judge's.
  return classifyCommandWithJudge(commandArgs, { judge: buildSurfaceJudge({ _judge: args && args._judge }) });
}

module.exports = {
  classifyCommandWithJudge,
  classifyCommandDetailed,
  maybeClassifyCommand,
  guardDecisionEnabled,
  COMMAND_CLASSES,
};
