'use strict';

/**
 * Hooks-engine: the judge for Slice 2 judgment-backed auto-save.
 *
 * shouldAutoCaptureWithJudge() (pattern-matcher.js, pure) calls its `judge`
 * as a FUNCTION. The Pi passive-capture hook used to hand it the createJudge()
 * OBJECT, so every call threw inside the cascade's try/catch and auto-save fell
 * back to regex-only on every message. buildAutosaveJudge() returns the
 * function from the shared seam (src/judgment/surface.js: one request capped at
 * judgment.surface_timeout_ms, no retries, breaker), wrapped to write one
 * judgment-log line per call (pick + confidence, never the message text).
 *
 * Returns null when the 'autosave' surface is off (provider not 'decision', no
 * LIQUID_API_KEY, local_only, judgment.disables.autosave or
 * LAPIS_JUDGE_DISABLE_AUTOSAVE=1): the cascade then runs regex-only, exactly
 * as before, with no request and no log line.
 */

const { surfaceEnabled, buildSurfaceJudge } = require('../judgment/surface');

function buildAutosaveJudge(args) {
  if (!surfaceEnabled('autosave')) {
    return null;
  }
  const judge = buildSurfaceJudge(args);
  return async function autosaveJudge(questions, opts) {
    const { logSurfaceCall, capReason, round3 } = require('../judgment/log'),
      started = Date.now(),
      result = await judge(questions, opts);
    try {
      const a = result && result.status === 'ok' && Array.isArray(result.answers) ? result.answers[0] : null;
      logSurfaceCall(
        'autosave',
        started,
        a
          ? { status: 'ok', pick: a.pick, confidence: round3(a.confidence) }
          : {
              status: (result && result.status) || 'unavailable',
              reason: capReason(result && result.reason),
            },
      );
    } catch {
      // Logging must never affect auto-save.
    }
    return result;
  };
}

module.exports = { buildAutosaveJudge };
