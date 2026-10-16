// extensions/memory-layer/host/decision-client.ts
// Thin wrapper for Liquid AI's Decisions API (System One models `d1` / `d1-ultra`).
//
// Wire shape (verified against the live API 2026-10-16):
//   POST https://api.liquid.ai/decisions/v1/systemone
//   Headers: Authorization: Bearer ${LIQUID_API_KEY}
//   Body: { model: "d1-ultra", state: {}, questions: { q: { type, instructions, criteria } } }
//     choice → criteria = { key: description, ... }   (at least 2 options)
//     score  → criteria = [level, ...]                 (2–10 levels)
//   Response: { answers: { q: { type: "choice", choice, probabilities, confidence } } }
//          or { answers: { q: { type: "score", score, legend, probabilities, confidence } } }
//
// A one-option choice (or a one-level score) has only one possible answer and
// the API rejects it with HTTP 422, so it is answered locally with confidence 1
// and no request is made.
//
// Gating:
//   DECISION_DRY_RUN=1  -> return canned answers (used by tests + local dev)
//   DECISION_ENABLED=1  -> enable real calls (default OFF; fail-closed if no API key)
//   DECISION_MODEL      -> `d1-ultra` (default) or `d1`
//
// Auth: LIQUID_API_KEY is read from the environment at request time. It is
// machine-scoped (lives in ~/.zshenv per memory #26577).

export const DECISION_ENDPOINT = process.env.DECISION_ENDPOINT || 'https://api.liquid.ai/decisions/v1/systemone';
export const DECISION_MODEL = process.env.DECISION_MODEL || 'd1-ultra';

/**
 * Read a DECISION_* setting, falling back to its pre-rename JEV_* name.
 * Deprecated alias kept for one release so existing shells keep working —
 * remove next release. Endpoint/model/key have no alias: their old values
 * pointed at the previous provider.
 */
export function decisionEnv(
  suffix: 'ENABLED' | 'DRY_RUN' | 'COMPACTION_ENABLED' | 'TIMEOUT_MS' | 'MAX_RETRIES',
): string | undefined {
  const v = process.env[`DECISION_${suffix}`];
  return v !== undefined && v !== '' ? v : process.env[`JEV_${suffix}`];
}

function timeoutMs(): number {
  return Number(decisionEnv('TIMEOUT_MS') || 8000);
}

function maxRetries(): number {
  return Number(decisionEnv('MAX_RETRIES') || 2);
}

export type DecisionChoiceQuestion = {
  kind: 'choice';
  question: string;
  options: Array<{ key: string; description: string }>;
};

export type DecisionScoreQuestion = {
  kind: 'score';
  question: string;
  levels: string[];
};

export type DecisionQuestion = DecisionChoiceQuestion | DecisionScoreQuestion;

export type DecisionChoiceAnswer = { choice: string; confidence: number };
export type DecisionScoreAnswer = { score: number; confidence: number };
export type DecisionAnswer = DecisionChoiceAnswer | DecisionScoreAnswer;

export function isDecisionDryRun(): boolean {
  return decisionEnv('DRY_RUN') === '1';
}

function dryRunAnswer(q: DecisionQuestion): DecisionAnswer {
  if (q.kind === 'choice') {
    const mid = Math.floor(q.options.length / 2);
    const confidence = q.options.length === 1 ? 1.0 : 0.8;
    return { choice: q.options[mid].key, confidence };
  }
  if (q.kind === 'score') {
    const mid = Math.floor(q.levels.length / 2);
    const confidence = q.levels.length === 1 ? 1.0 : 0.8;
    return { score: mid, confidence };
  }
  throw new Error(`unknown question kind: ${(q as any).kind}`);
}

/** Only one possible answer → answer locally (the API 422s on these). */
function singleOptionAnswer(q: DecisionQuestion): DecisionAnswer | null {
  if (q.kind === 'choice' && q.options.length === 1) return { choice: q.options[0].key, confidence: 1 };
  if (q.kind === 'score' && q.levels.length === 1) return { score: 0, confidence: 1 };
  return null;
}

/** Translate a client question into the /systemone wire question. */
export function toWireQuestion(q: DecisionQuestion): { type: string; instructions: string; criteria: unknown } {
  if (q.kind === 'choice') {
    return {
      type: 'choice',
      instructions: q.question,
      criteria: Object.fromEntries(q.options.map((o) => [o.key, o.description])),
    };
  }
  if (q.kind === 'score') return { type: 'score', instructions: q.question, criteria: q.levels };
  throw new Error(`unknown question kind: ${(q as any).kind}`);
}

async function liveAsk(question: DecisionQuestion): Promise<DecisionAnswer> {
  const apiKey = process.env.LIQUID_API_KEY;
  if (!apiKey) {
    throw new Error('LIQUID_API_KEY is not set; set it in ~/.zshenv or run with DECISION_DRY_RUN=1');
  }

  const retries = maxRetries();
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs());
    try {
      const res = await fetch(DECISION_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model: DECISION_MODEL, state: {}, questions: { q: toWireQuestion(question) } }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok && res.status >= 500 && attempt < retries) {
        lastErr = new Error(`Decision ${res.status}`);
        continue;
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Decision ${res.status}: ${text.slice(0, 200)}`);
      }

      const json = (await res.json()) as { answers?: Record<string, any> };
      const answer = json.answers?.q;
      if (!answer) throw new Error('Decision returned empty answers');

      if (question.kind === 'choice') {
        return {
          choice: answer.choice,
          confidence: Number(answer.confidence ?? 0),
        };
      }
      return {
        score: Number(answer.score ?? 0),
        confidence: Number(answer.confidence ?? 0),
      };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (attempt >= retries) break;
    }
  }
  throw new Error(`Decision request failed after ${retries + 1} attempts: ${lastErr?.message ?? 'unknown'}`);
}

export async function decisionAsk(question: DecisionQuestion): Promise<DecisionAnswer> {
  if (isDecisionDryRun()) return dryRunAnswer(question);
  const local = singleOptionAnswer(question);
  if (local) return local;
  return liveAsk(question);
}
