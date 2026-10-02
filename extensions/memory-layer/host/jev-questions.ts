// extensions/memory-layer/host/jev-questions.ts
// Question shapes for the post-compact Jev integration.
//
// (C) buildReclassifyQuestion — re-classify the re-injected slice against
//     pinned policies. Catches dropped policy citations.
// (A) buildVerdictQuestion — verdict on whether the slice still covers
//     what was lost in compaction. Catches dropped decisions.
//
// Both shapes are deterministic so tests can assert exact bodies.

import type { JevChoiceQuestion, JevScoreQuestion } from './jev-client.ts';

export function buildReclassifyQuestion(input: {
  pinnedPolicies: string[];
  reInjectedTitles: string[];
}): JevChoiceQuestion {
  const { pinnedPolicies, reInjectedTitles } = input;
  const policyList =
    pinnedPolicies.length > 0 ? pinnedPolicies.map((p) => `- ${p}`).join('\n') : '(no pinned policies declared)';
  const titleList =
    reInjectedTitles.length > 0 ? reInjectedTitles.map((t) => `- ${t}`).join('\n') : '(no re-injected memories)';

  return {
    kind: 'choice',
    question:
      `Re-injected memory titles after compaction:\n${titleList}\n\n` +
      `Pinned policies from AGENTS.md:\n${policyList}\n\n` +
      `Are all pinned policies still referenced or visible in the re-injected slice?\n` +
      `Answer "yes" if every policy above is referenced by at least one title or obviously implied.\n` +
      `Answer "partial" if some are referenced but coverage is incomplete.\n` +
      `Answer "no" if most or all are missing.`,
    options: [
      { key: 'yes', description: 'all pinned policies are referenced or visible' },
      { key: 'partial', description: 'some references, gaps possible' },
      { key: 'no', description: 'no references to pinned policies' },
    ],
  };
}

export function buildVerdictQuestion(input: { lostTopics: string[]; reInjectedTitles: string[] }): JevScoreQuestion {
  const { lostTopics, reInjectedTitles } = input;
  const lostList =
    lostTopics.length > 0
      ? lostTopics.map((t) => `- ${t}`).join('\n')
      : '(nothing was lost — compaction removed nothing)';
  const titleList =
    reInjectedTitles.length > 0 ? reInjectedTitles.map((t) => `- ${t}`).join('\n') : '(no re-injected memories)';

  return {
    kind: 'score',
    question:
      `Topics lost during compaction:\n${lostList}\n\n` +
      `Memories re-injected after compaction:\n${titleList}\n\n` +
      `How completely does the re-injected slice cover the lost topics?\n` +
      `0=incomplete (most lost topics missing), 1=partial (some present), ` +
      `2=mostly-complete (most present), 3=complete (all covered).`,
    levels: ['incomplete', 'partial', 'mostly-complete', 'complete'],
  };
}
