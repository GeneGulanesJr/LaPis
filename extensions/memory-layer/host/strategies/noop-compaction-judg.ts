// extensions/memory-layer/host/strategies/noop-compaction-judg.ts
// Escape-hatch strategy. Marks every message as "summarize" so the planner
// never overrides pi's built-in compaction behavior. Used when:
//   - The feature is disabled (compaction.judg unset, or "default")
//   - The configured strategy fails to load
//   - The user wants Jev-driven decisions temporarily turned off without changing settings

import type { CompactionJudg, DecideKeepInput, DecideKeepResult } from '../compaction-judg';

export class NoopCompactionJudg implements CompactionJudg {
  readonly name = 'noop';

  async decideKeep(_input: DecideKeepInput): Promise<DecideKeepResult> {
    // Verdict=1 = "summarize": the planner treats this as "let pi decide",
    // which is identical to the built-in compaction summary call.
    return { verdict: 1, confidence: 1, reason: 'noop: defer to pi default' };
  }
}
