// extensions/memory-layer/hooks/jev-post-compact.ts
// Runs after `session_compact` re-injects memory context. Two-question shape:
// (C) reclassify the re-injected slice against pinned policies
// (A) verdict on completeness of the re-injected slice given lost topics
//
// Gating:
//   JEV_ENABLED=1   -> opt-in to live calls (default OFF)
//   JEV_DRY_RUN=1   -> return canned answers (tests + local dev)
//
// The hook MUST NEVER throw — failures degrade to { messages: [] } so the
// re-injection path is never blocked.

import { jevAsk, isJevDryRun } from '../host/jev-client.ts';
import { buildReclassifyQuestion, buildVerdictQuestion } from '../host/jev-questions.ts';

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

function isJevEnabled(): boolean {
  return process.env.JEV_ENABLED === '1';
}

const VERDICT_LABELS = ['incomplete', 'partial', 'mostly-complete', 'complete'];

export async function runJevPostCompact(input: PostCompactInput): Promise<PostCompactOutput> {
  if (!input.currentProject) return { messages: [] };
  if (!isJevEnabled() && !isJevDryRun()) return { messages: [] };

  try {
    const cAnswer = await jevAsk(buildReclassifyQuestion(input));
    const aAnswer = await jevAsk(buildVerdictQuestion(input));

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
        label: VERDICT_LABELS[aAnswer.score] ?? 'unknown',
      });
    }

    return { messages };
  } catch {
    // Hook MUST NEVER throw — compaction re-injection is the critical path.
    return { messages: [] };
  }
}
