// extensions/memory-layer/hooks/decision-post-compact.ts
// Runs after `session_compact` re-injects memory context. Two-question shape:
// (C) reclassify the re-injected slice against pinned policies
// (A) verdict on completeness of the re-injected slice given lost topics
//
// Gating:
//   DECISION_ENABLED=1   -> opt-in to live calls (default OFF)
//   DECISION_DRY_RUN=1   -> return canned answers (tests + local dev)
//
// The hook MUST NEVER throw — failures degrade to { messages: [] } so the
// re-injection path is never blocked.

import { decisionAsk, decisionEnv, isDecisionDryRun } from '../host/decision-client.ts';
import { buildReclassifyQuestion, buildVerdictQuestion } from '../host/decision-questions.ts';

export type PostCompactInput = {
  currentProject: string;
  sessionId: number;
  pinnedPolicies: string[];
  reInjectedTitles: string[];
  lostTopics: string[];
};

export type PostCompactMessage =
  | { kind: 'reclassify'; choice: string; confidence: number }
  | { kind: 'verdict'; score: number; label: string };

export type PostCompactOutput = { messages: PostCompactMessage[] };

function isDecisionEnabled(): boolean {
  return decisionEnv('ENABLED') === '1';
}

const VERDICT_LABELS = ['incomplete', 'partial', 'mostly-complete', 'complete'];

/** The API returns a float score (e.g. 1.72): round to the nearest level, clamped. */
export function verdictLabel(score: number): string {
  if (!Number.isFinite(score)) return 'unknown';
  const idx = Math.min(VERDICT_LABELS.length - 1, Math.max(0, Math.round(score)));
  return VERDICT_LABELS[idx];
}

export async function runDecisionPostCompact(input: PostCompactInput): Promise<PostCompactOutput> {
  if (!input.currentProject) return { messages: [] };
  if (!isDecisionEnabled() && !isDecisionDryRun()) return { messages: [] };

  try {
    const cAnswer = await decisionAsk(buildReclassifyQuestion(input));
    const aAnswer = await decisionAsk(buildVerdictQuestion(input));

    const messages: PostCompactMessage[] = [];

    if (cAnswer && 'choice' in cAnswer) {
      messages.push({
        kind: 'reclassify',
        choice: cAnswer.choice,
        confidence: cAnswer.confidence,
      });
    }

    if (aAnswer && 'score' in aAnswer) {
      messages.push({
        kind: 'verdict',
        score: aAnswer.score,
        label: verdictLabel(aAnswer.score),
      });
    }

    return { messages };
  } catch {
    // Hook MUST NEVER throw — compaction re-injection is the critical path.
    return { messages: [] };
  }
}
