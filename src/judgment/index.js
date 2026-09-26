// src/judgment/index.js
// Registry + total-function judge() (spec §7). judge() NEVER throws — that is
// the structural guarantee that host flows can never block on judgment failure
// (RetellMCP P1 #2 made impossible by construction).

const { createHeuristicAdapter } = require('./adapters/heuristic');

/** Resolve the adapter for a provider name. Unknown → null (caller → unavailable). */
function pickAdapter(provider, adapters) {
  if (provider === 'heuristic') return createHeuristicAdapter();
  if (provider === 'off') return null;
  return adapters && adapters[provider] ? adapters[provider] : null;
}

/**
 * createJudge({ config, adapters })
 *   config:    getConfig() (uses .judgment section)
 *   adapters:  { jev?: JudgeAdapter } — registered provider adapters
 * Returns { provider, probe(), judge(questions, {surface}?) }.
 */
function createJudge({ config, adapters } = {}) {
  const cfg = () => (config && config.judgment) || {};
  const providerName = () => {
    const c = cfg();
    if (c.local_only) return 'heuristic'; // kill switch forces the off-path
    return c.provider || 'heuristic';
  };

  // Breaker state (per judge instance; CLI processes are short-lived anyway)
  let consecutiveFailures = 0;
  let openUntil = 0;

  async function probe() {
    const a = pickAdapter(providerName(), adapters);
    if (!a) return { ok: false, mode: providerName() };
    return a.probe ? a.probe() : { ok: true, mode: 'unknown' };
  }

  async function judge(questions, { surface } = {}) {
    const c = cfg();
    try {
      if (c.local_only) {
        return { status: 'unavailable', reason: 'LAPIS_JUDGE_LOCAL_ONLY=1 — heuristic path forced' };
      }
      if (surface && c.disables && c.disables[surface]) {
        return { status: 'unavailable', reason: `surface '${surface}' disabled (LAPIS_JUDGE_DISABLE_*)` };
      }
      const provider = c.provider || 'heuristic';
      if (provider === 'off') {
        return { status: 'unavailable', reason: 'judgment provider off' };
      }
      const adapter = pickAdapter(provider, adapters);
      if (!adapter) {
        return { status: 'unavailable', reason: `unknown judgment provider '${provider}'` };
      }
      if (Date.now() < openUntil) {
        return { status: 'unavailable', reason: `breaker open (opens again in ${openUntil - Date.now()}ms)` };
      }
      // Contract-level timeout: adapters own their wire timeouts; this guards
      // against an adapter that never resolves.
      const timeoutMs = Number(c.timeout_ms ?? 5000);
      const result = await Promise.race([
        Promise.resolve(adapter.judge(questions)),
        new Promise((resolve) =>
          setTimeout(() => resolve({ status: 'unavailable', reason: `judge timeout after ${timeoutMs}ms` }), timeoutMs),
        ),
      ]);
      if (result && result.status === 'ok') {
        consecutiveFailures = 0;
      } else {
        consecutiveFailures += 1;
        if (consecutiveFailures >= Number(c.breaker_threshold ?? 3)) {
          openUntil = Date.now() + Number(c.breaker_cooldown_ms ?? 60000);
          consecutiveFailures = 0;
        }
      }
      return result;
    } catch (e) {
      // THE guarantee: even a broken adapter/adapter-registry can only ever
      // produce an unavailable result. Nothing above can throw past this line.
      consecutiveFailures += 1;
      if (consecutiveFailures >= Number(c.breaker_threshold ?? 3)) {
        openUntil = Date.now() + Number(c.breaker_cooldown_ms ?? 60000);
        consecutiveFailures = 0;
      }
      return { status: 'unavailable', reason: `judge error contained: ${e.message}` };
    }
  }

  return { provider: providerName(), probe, judge };
}

module.exports = { createJudge, pickAdapter };
