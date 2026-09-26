// src/judgment/adapters/jev.js
// TypeSafe System One (Jev) wire adapter — the ONLY file that knows Jev (spec §8, R1).
// Wire contract ported from RetellMCP qa/jev.mjs (live-verified 2026-09-25).
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

function createJevAdapter({ apiKey, endpoint, fetchImpl, model, timeoutMs, maxRetries } = {}) {
  const _endpoint = endpoint || process.env.LAPIS_JUDGE_ENDPOINT || 'https://api.typesafe.ai/v1/systemone';
  const _model = model || process.env.LAPIS_JUDGE_MODEL || 'jev-latest';
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
    name: 'jev',
    async probe() {
      if (!apiKey) return { ok: false, mode: 'missing-key' };
      return { ok: true, mode: 'ready', endpoint: _endpoint, model: _model };
    },
    async judge(questions) {
      // 1. missing key → unavailable BEFORE any work (P1 #2)
      if (!apiKey)
        return { status: 'unavailable', reason: 'TYPESAFE_API_KEY not set (machine-scoped; never project .env)' };
      // 2. validate + translate questions → invalid without fetching
      let wireQuestions;
      try {
        for (const q of questions) assertValidQuestion(q);
        wireQuestions = Object.fromEntries(questions.map((q) => [q.id, buildWireQuestion(q)]));
      } catch (e) {
        return { status: 'invalid', reason: e.message };
      }
      // 3. send — the wire takes one `state` object per request; per-question
      //    state objects are merged (later question fields win), questions
      //    reference state fields by name in instructions.
      const state = Object.assign({}, ...questions.map((q) => q.state));
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
      const raw = body && body.answers ? body.answers : null;
      if (!raw || typeof raw !== 'object') return { status: 'invalid', reason: 'reply missing answers object' };
      const answers = [];
      for (const q of questions) {
        const a = raw[q.id];
        if (!a || typeof a !== 'object') return { status: 'invalid', reason: `reply missing answer ${q.id}` };
        const confidence = normalizeScore(a.confidence);
        const kind = q.judgment.kind;
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
          const idx = Number(a.score);
          if (!Number.isInteger(idx) || idx < 0 || idx >= q.judgment.levels.length) {
            return { status: 'invalid', reason: `answer ${q.id}: score outside levels` };
          }
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

module.exports = { createJevAdapter, buildWireQuestion };
