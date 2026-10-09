// extensions/memory-layer/host/strategies/builtin-judg-strategies.ts
// Canonical singleton instances of the three built-in CompactionJudg
// strategies, plus the one function that registers them.
//
// Why singletons: pi caches extension modules but re-invokes the
// memoryLayer() factory per runtime (resume/fork). registerCompactionJudg()
// accepts same-instance re-registration and rejects different impls, so every
// registration path must register THESE instances — fresh instances would
// throw "already registered with a different impl" on every runtime after the
// first (issue #363).
//
// This module sits between compaction-judg.ts (the registry) and the strategy
// classes because the classes import from the registry module — hosting the
// singletons there would create an import cycle.

import { registerCompactionJudg, type CompactionJudg } from '../compaction-judg';
import { DefaultCompactionJudg } from './default-compaction-judg';
import { JevCompactionJudg } from './jev-compaction-judg';
import { NoopCompactionJudg } from './noop-compaction-judg';

export const BUILTIN_JUDG_STRATEGIES: ReadonlyArray<[string, CompactionJudg]> = [
  ['default', new DefaultCompactionJudg()],
  ['noop', new NoopCompactionJudg()],
  ['jev', new JevCompactionJudg()],
];

/** Register the built-in strategies. Idempotent; safe to call repeatedly. */
export function ensureBuiltinJudgStrategies(): void {
  for (const [name, impl] of BUILTIN_JUDG_STRATEGIES) {
    registerCompactionJudg(name, impl);
  }
}
