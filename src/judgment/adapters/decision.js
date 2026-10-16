// src/judgment/adapters/decision.js
// Liquid AI Decisions API (System One) wire adapter — the ONLY file that knows
// the provider wire (spec §8, R1). POST https://api.liquid.ai/decisions/v1/systemone,
// body { model, state, questions }; models `d1` and `d1-ultra` (default).
// Wire contract first ported from RetellMCP's System One client (live-verified
// 2026-09-25); the same request/response shapes were re-verified live against
// Liquid on 2026-10-16. Known wire limits: a `choice` needs at least 2 options
// (one-option choices are answered locally below, never sent), a `score` takes
// 2–10 levels, a request takes at most 128 questions, and each question's
// prompt (instructions + state) is capped at 32,768 tokens / 250,000 bytes.
// Rules honored here: R2 normalization at the boundary, R3 validation (malformed
// OK → invalid), P1 #2 (missing key → unavailable before fetch).

const { assertValidQuestion, assertValidAnswers } = require('../contract');
const { normalizeScore } = require('../internal');

/** Translate one Question into the wire question shape. Throws on impossible translation. */
function buildWireQuestion(q) {
  const j = q.judgment;
  if (j.kind === 'probability') {
    return { type: 'noul', instructions: `${q.instructions} Claim: ${j.claim}` };
  }
  if (j.kind === 'classify') {
    // criteria = plain key→key map (RetellMCP convention). Polarity is NOT leaked
    // into the prompt — dangerous-marking is interpreted only by evaluate.js (R4).
    const criteria = Object.fromEntries(j.enum.map((k) => [k, k]));
    return { type: 'choice', instructions: q.instructions, criteria };
  }
  // grade
  return { type: 'score', instructions: q.instructions, criteria: j.levels };
}

/**
 * A classify with exactly one enum value has only one possible answer. The
 * Decisions API rejects a one-option `choice` (HTTP 422 "A Choice needs at
 * least 2 options."), so it is answered locally — pick = the option,
 * confidence 1 — and never sent.
 */
function isSingleOptionChoice(q) {
  return q.judgment.kind === 'classify' && q.judgment.enum.length === 1;
}

function createDecisionAdapter({ apiKey, endpoint, fetchImpl, model, timeoutMs, maxRetries } = {}) {
  const _endpoint = endpoint || process.env.LAPIS_JUDGE_ENDPOINT || 'https://api.liquid.ai/decisions/v1/systemone';
  const _model = model || process.env.LAPIS_JUDGE_MODEL || 'd1-ultra';
  const _timeoutMs = Number(timeoutMs ?? process.env.LAPIS_JUDGE_TIMEOUT_MS ?? 8000);
  const _maxRetries = Number(maxRetries ?? process.env.LAPIS_JUDGE_MAX_RETRIES ?? 2);
  const _fetch = fetchImpl || globalThis.fetch;

  async function post(body) {
    let lastErr;
    for (let attempt = 0; attempt <= _maxRetries; attempt++) {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), _timeoutMs);
        try {
          return await _fetch(_endpoint, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: ctl.signal,
          });
        } finally {
          clearTimeout(timer);
        }
      } catch (e) {
        lastErr = e;
        if (attempt < _maxRetries) await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
    }
    throw lastErr;
  }

  return {
    name: 'decision',
    async probe() {
      if (!apiKey) return { ok: false, mode: 'missing-key' };
      return { ok: true, mode: 'ready', endpoint: _endpoint, model: _model };
    },
    async judge(questions) {
      // 1. missing key → unavailable BEFORE any work (P1 #2)
      if (!apiKey)
        return { status: 'unavailable', reason: 'LIQUID_API_KEY not set (machine-scoped; never project .env)' };
      // 2. validate + translate questions → invalid without fetching
      let wireQuestions, remote;
      try {
        for (const q of questions) assertValidQuestion(q);
        remote = questions.filter((q) => !isSingleOptionChoice(q));
        wireQuestions = Object.fromEntries(remote.map((q) => [q.id, buildWireQuestion(q)]));
      } catch (e) {
        return { status: 'invalid', reason: e.message };
      }
      // 3. send — the wire takes one `state` object per request; per-question
      //    state objects are merged (later question fields win), questions
      //    reference state fields by name in instructions. When every question
      //    is a one-option choice there is nothing to ask: no request is made.
      let raw = {};
      if (remote.length > 0) {
        const state = Object.assign({}, ...remote.map((q) => q.state));
        let res;
        try {
          res = await post({ model: _model, state, questions: wireQuestions });
        } catch (e) {
          return { status: 'unavailable', reason: `network: ${e.message}` };
        }
        if (!res.ok) {
          const text = await res.text().catch(() => '<no body>');
          return { status: 'unavailable', reason: `HTTP ${res.status}: ${text}` };
        }
        // 4. validate + normalize the reply (R3) — malformed OK → invalid
        let body;
        try {
          body = await res.json();
        } catch (e) {
          return { status: 'invalid', reason: `reply not JSON: ${e.message}` };
        }
        raw = body && body.answers ? body.answers : null;
        if (!raw || typeof raw !== 'object') return { status: 'invalid', reason: 'reply missing answers object' };
      }
      const answers = [];
      for (const q of questions) {
        if (isSingleOptionChoice(q)) {
          answers.push({ id: q.id, pick: q.judgment.enum[0], confidence: 1 });
          continue;
        }
        const a = raw[q.id];
        if (!a || typeof a !== 'object') return { status: 'invalid', reason: `reply missing answer ${q.id}` };
        const kind = q.judgment.kind;
        // Live wire (System One 2026-09-26, re-verified on Liquid 2026-10-16):
        // noul replies OMIT confidence — derive it at the
        // boundary as distance-from-indecision (contract: distribution concentration).
        let confidence = normalizeScore(a.confidence);
        if (kind === 'probability' && confidence === null) {
          const pForConf = normalizeScore(a.noul);
          confidence = pForConf === null ? null : Math.abs(pForConf - 0.5) * 2;
        }
        if (confidence === null) return { status: 'invalid', reason: `answer ${q.id}: bad confidence` };
        if (kind === 'probability') {
          const p = normalizeScore(a.noul);
          if (p === null) return { status: 'invalid', reason: `answer ${q.id}: bad noul` };
          answers.push({ id: q.id, p, confidence });
        } else if (kind === 'classify') {
          if (typeof a.choice !== 'string' || !q.judgment.enum.includes(a.choice)) {
            return { status: 'invalid', reason: `answer ${q.id}: choice outside enum` };
          }
          answers.push({ id: q.id, pick: a.choice, confidence });
        } else {
          // Live wire (both backends): score is a FLOAT (probability-weighted position,
          // e.g. 1.82 of levels 0..2) — round to nearest level index, clamped.
          const rawScore = Number(a.score);
          if (!Number.isFinite(rawScore)) return { status: 'invalid', reason: `answer ${q.id}: bad score` };
          const idx = Math.min(q.judgment.levels.length - 1, Math.max(0, Math.round(rawScore)));
          answers.push({ id: q.id, level: idx, confidence });
        }
      }
      // Final contract check (defense in depth)
      try {
        assertValidAnswers(questions, answers);
      } catch (e) {
        return { status: 'invalid', reason: e.message };
      }
      return { status: 'ok', answers };
    },
  };
}

module.exports = { createDecisionAdapter, buildWireQuestion };
