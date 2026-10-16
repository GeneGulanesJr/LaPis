// Src/judgment/surface.js
// The one seam every opt-in judgment surface builds its judge through (recall,
// Dedupe, trust, guard, autosave, dream, context).
//
// Why it exists: each surface used to carry its own buildJudge(), and four of
// Them returned the createJudge() OBJECT ({provider, probe, judge}) instead of
// Its judge FUNCTION. Every live call then threw "judge is not a function"
// Inside the surface's own try/catch and silently fell back to the
// Non-judgment path; the unit tests stayed green because they inject a
// Function. #368 fixed context only. Building the judge here, once, returns the
// Function and gives every surface the same tight wire settings.
//
// Wire settings: ONE request per batch, capped at judgment.surface_timeout_ms
// (default 2000 ms) both at the contract race and at the wire (AbortController),
// And NO wire retries — a slow or failing provider costs one capped request and
// The caller falls back to exactly its non-judgment behavior. Consecutive
// Failures open the createJudge() breaker (judgment.breaker_threshold, default 3)
// For judgment.breaker_cooldown_ms (default 60 s), so a long-lived process (MCP
// Server, Pi) stops asking during an outage.

// Lazy: this file is required on every search/save dispatch (the enabled
// Checks live here); the judgment layer and the adapter load only when a
// Judge is actually built.
const { getConfig } = require('../../config'),
  DEFAULT_SURFACE_TIMEOUT_MS = 2000;

/**
 * SurfaceEnabled(surface) — should this process ask the judge for `surface`?
 * provider 'decision' + machine-scoped LIQUID_API_KEY + not local_only + the
 * surface not disabled (judgment.disables.<surface> or
 * LAPIS_JUDGE_DISABLE_<SURFACE>=1). Off = the caller's old code path, no
 * request and no log line.
 */
function surfaceEnabled(surface) {
  const cfg = getConfig().judgment || {};
  return (
    cfg.provider === 'decision' &&
    Boolean(process.env.LIQUID_API_KEY) &&
    !cfg.local_only &&
    !(cfg.disables && cfg.disables[surface])
  );
}

/** The per-request cap: judgment.surface_timeout_ms (LAPIS_JUDGE_SURFACE_TIMEOUT_MS), default 2000. */
function surfaceTimeoutMs() {
  const n = Number((getConfig().judgment || {}).surface_timeout_ms);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SURFACE_TIMEOUT_MS;
}

/**
 * BuildSurfaceJudge(args, { timeoutMs }) — returns the judge FUNCTION
 * judge(questions, { surface }) → Promise<Result> (never throws).
 *   args._judge     test injection: returned as-is. Nothing else is read from
 *                   args (callers pass CLI args / run options through, whose
 *                   own timeoutMs means something else).
 *   opts.timeoutMs  the per-request cap (default surfaceTimeoutMs()).
 */
function buildSurfaceJudge(args, opts = {}) {
  if (args && typeof args._judge === 'function') {
    return args._judge;
  }
  const { createJudge } = require('./index');
  const { createDecisionAdapter } = require('./adapters/decision'),
    config = getConfig(),
    cap = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : surfaceTimeoutMs(),
    judgment = { ...(config.judgment || {}), timeout_ms: cap },
    adapters =
      judgment.provider === 'decision'
        ? { decision: createDecisionAdapter({ apiKey: process.env.LIQUID_API_KEY, timeoutMs: cap, maxRetries: 0 }) }
        : {};
  return createJudge({ config: { ...config, judgment }, adapters }).judge;
}

module.exports = { surfaceEnabled, surfaceTimeoutMs, buildSurfaceJudge, DEFAULT_SURFACE_TIMEOUT_MS };
