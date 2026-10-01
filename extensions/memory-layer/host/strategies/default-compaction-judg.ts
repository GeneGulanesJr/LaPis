// extensions/memory-layer/host/strategies/default-compaction-judg.ts
// Pass-through strategy. Sentences default-compaction means "no per-message judgment";
// the planner should NOT use this — it should return `{ cancel: true }` or
// pass through to pi's built-in compaction unchanged.
//
// This exists as a registry name so users can explicitly opt OUT of any custom
// strategy via `compaction.judg: "default"` in settings.

import type { CompactionJudg, DecideKeepInput, DecideKeepResult } from '../compaction-judg';

export class DefaultCompactionJudg implements CompactionJudg {
  readonly name = 'default';

  async decideKeep(_input: DecideKeepInput): Promise<DecideKeepResult> {
    // If the planner is asking this strategy for a verdict, the user has
    // explicitly chosen `default`. Return verdict=1 (summarize) for every
    // message — semantically identical to pi's holistic summary.
    return { verdict: 1, confidence: 1, reason: 'default: holistic summary' };
  }
}
