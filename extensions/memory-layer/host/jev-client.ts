// extensions/memory-layer/host/jev-client.ts
// Thin wrapper for TypeSafe AI's Jev (System One model).
//
// Wire shape (verified against live API by RetellMCP/qa/jev.mjs):
//   POST https://api.typesafe.ai/v1/systemone
//   Headers: Authorization: Bearer ${JEV_API_KEY}
//   Body: { model: "jev-latest", questions: [...] }
//   Response: { answers: [{ choice, confidence }] } or { answers: [{ score, confidence }] }
//
// Gating:
//   JEV_DRY_RUN=1  -> return canned answers (used by tests + local dev)
//   JEV_ENABLED=1  -> enable real calls (default OFF; fail-closed if no API key)
//
// Auth: JEV_API_KEY is read from the environment at request time. It is
// machine-scoped (lives in ~/.zshenv per memory #26577).

export const JEV_ENDPOINT = process.env.JEV_ENDPOINT || 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = process.env.JEV_MODEL || 'jev-latest';

function timeoutMs(): number {
  return Number(process.env.JEV_TIMEOUT_MS || 8000);
}

function maxRetries(): number {
  return Number(process.env.JEV_MAX_RETRIES || 2);
}

export type JevChoiceQuestion = {
  kind: 'choice';
  question: string;
  options: Array<{ key: string; description: string }>;
};

export type JevScoreQuestion = {
  kind: 'score';
  question: string;
  levels: string[];
};

export type JevQuestion = JevChoiceQuestion | JevScoreQuestion;

export type JevChoiceAnswer = { choice: string; confidence: number };
export type JevScoreAnswer = { score: number; confidence: number };
export type JevAnswer = JevChoiceAnswer | JevScoreAnswer;

export function isJevDryRun(): boolean {
  return process.env.JEV_DRY_RUN === '1';
}

function dryRunAnswer(q: JevQuestion): JevAnswer {
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

async function liveAsk(question: JevQuestion): Promise<JevAnswer> {
  const apiKey = process.env.JEV_API_KEY;
  if (!apiKey) {
    throw new Error(
      'JEV_API_KEY is not set; set it in ~/.zshenv or run with JEV_DRY_RUN=1',
    );
  }

  const retries = maxRetries();
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs());
    try {
      const res = await fetch(JEV_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model: JEV_MODEL, questions: [question] }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok && res.status >= 500 && attempt < retries) {
        lastErr = new Error(`Jev ${res.status}`);
        continue;
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Jev ${res.status}: ${text.slice(0, 200)}`);
      }

      const json = (await res.json()) as { answers: any[] };
      const answer = json.answers?.[0];
      if (!answer) throw new Error('Jev returned empty answers');

      if (question.kind === 'choice') {
        return {
          choice:
            typeof answer.choice === 'string' ? answer.choice : answer.choice?.key,
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
  throw new Error(
    `Jev request failed after ${retries + 1} attempts: ${lastErr?.message ?? 'unknown'}`,
  );
}

export async function jevAsk(question: JevQuestion): Promise<JevAnswer> {
  if (isJevDryRun()) return dryRunAnswer(question);
  return liveAsk(question);
}
