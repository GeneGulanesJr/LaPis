// extensions/memory-layer/host/jev-lost-topics.ts
// Pure set-difference helper for the Jev post-compact integration.
//
// diffLostTopics(before, after) returns the titles that were visible BEFORE
// compaction but are missing AFTER re-injection — i.e., topics the
// compaction dropped. Used as input to the Jev verdict question (A), which
// scores how completely the re-injected slice covers what was lost.
//
// Pure function, no I/O. Title-only diff (matches the Jev question shape).
// When `before` is null/empty, returns [] — there's no baseline to diff
// against, so the caller should pass lostTopics=[] to Jev (no signal).

export function diffLostTopics(before: string[] | null, after: string[]): string[] {
  if (!before || before.length === 0) return [];
  const afterSet = new Set(after);
  const lost: string[] = [];
  const seen = new Set<string>();
  for (const t of before) {
    if (afterSet.has(t)) continue;
    if (seen.has(t)) continue; // dedupe in case before has duplicates
    seen.add(t);
    lost.push(t);
  }
  return lost;
}
