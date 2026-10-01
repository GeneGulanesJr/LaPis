// test/jev-compaction-planner.smoke.test.js
// End-to-end smoke test for the Jev-driven compaction planner.
//
// Runs the planner hook handler against a synthetic preparation with mixed
// messages (user / assistant tool-call / tool-result / decision) and asserts
// the resulting CompactionResult has the expected shape:
//
//   - summary contains <keep> blocks for verbatim-kept messages
//   - details.strategy === "jev"
//   - details.verdicts length matches messagesToSummarize length
//   - cut-point rule enforced (tool-call ↔ tool-result pair stays together)
//      - a summary containing `<keep>` blocks for kept messages
//      - details.verdicts array matching the input length
//      - firstKeptEntryId equal to the input
//      - tokensBefore equal to the input
//
// Exits 0 on success, 1 on any assertion failure.

process.env.JEV_DRY_RUN = '1';
process.env.JEV_ENABLED = '1';
process.env.PI_COMPACTION_JUDG_ENABLED = '1';
process.env.PI_COMPACTION_JUDG = 'jev';

// Use the built dist for the source — vitest already required it but we want
// a standalone ESM run here. Build a minimal mock of the pi ExtensionAPI.

import { createJevCompactionPlanner } from '../extensions/memory-layer/hooks/jev-compaction-planner.ts';
import { JevCompactionJudg } from '../extensions/memory-layer/host/strategies/jev-compaction-judg.ts';
import { registerCompactionJudg } from '../extensions/memory-layer/host/compaction-judg.ts';
import { VERDICT_LABELS } from '../extensions/memory-layer/host/compaction-judg.ts';

const handlers = new Map();
const fakePi = {
  on(event, handler) {
    handlers.set(event, handler);
    return () => handlers.delete(event);
  },
};

createJevCompactionPlanner().register(fakePi);

const handler = handlers.get('session_before_compact');
if (!handler) {
  console.error('FAIL: planner did not register session_before_compact');
  process.exit(1);
}

// --- synthetic preparation ----------------------------------------------

const firstKeptEntryId = 'entry-7';
const messagesToSummarize = [
  // 0: user instruction (low value — summarize)
  { role: 'user', content: 'please also bump the version' },
  // 1: assistant tool-call (high value — keep, forces next tool-result keep)
  {
    role: 'assistant',
    content: [{ type: 'text', text: 'Reading current package.json' }, { type: 'toolCall', name: 'read', args: { path: 'package.json' } }],
  },
  // 2: tool result (must stay with the call above)
  { role: 'toolResult', content: '{ "version": "0.1.0" }' },
  // 3: assistant text-only decision (high value — keep verbatim)
  {
    role: 'assistant',
    content: [{ type: 'text', text: 'DECISION: ship v0.1.0 with the new schema; do NOT bump to 0.2 yet.' }],
  },
  // 4: user follow-up (low value — summarize)
  { role: 'user', content: 'ok proceeding' },
  // 5: assistant empty ack (drop)
  { role: 'assistant', content: [{ type: 'text', text: '👍' }] },
];

const event = {
  type: 'session_before_compact',
  reason: 'manual',
  preparation: {
    firstKeptEntryId,
    messagesToSummarize,
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 145_000,
    previousSummary: 'Earlier in this session: chose SQLite for storage, set up vitest.',
    fileOps: { readFiles: ['package.json', 'tsconfig.json'], modifiedFiles: ['src/index.ts'] },
    settings: {
      enabled: true,
      reserveTokens: 16384,
      keepRecentTokens: 20000,
      model: 'claude-opus-4-6',
    },
  },
  signal: undefined,
};

// --- run the handler -----------------------------------------------------

const result = await handler(event, { cwd: process.cwd() });

// --- assertions ----------------------------------------------------------

import { describe, it, expect } from 'vitest';

describe('planner end-to-end (synthetic event)', () => {
  it('produces a CompactionResult with the expected shape', () => {
    expect(result.compaction).toBeDefined();
    expect(result.compaction.firstKeptEntryId).toBe(firstKeptEntryId);
    expect(result.compaction.tokensBefore).toBe(145_000);
    expect(typeof result.compaction.summary).toBe('string');
    expect(result.compaction.summary.length).toBeGreaterThan(0);
  });

  it('summary carries over the previous-summary content', () => {
    expect(result.compaction.summary).toContain('Earlier in this session');
  });

  it('summary has the standard headers', () => {
    expect(result.compaction.summary).toContain('## Step decisions');
    expect(result.compaction.summary).toContain('### File operations');
  });

  it('summary contains at least one <keep> block', () => {
    expect(/<keep idx="\d+"/.test(result.compaction.summary)).toBe(true);
  });

  it('details.strategy is "jev"', () => {
    expect(result.compaction.details.strategy).toBe('jev');
  });

  it('details.verdicts length matches messagesToSummarize', () => {
    expect(result.compaction.details.verdicts.length).toBe(messagesToSummarize.length);
  });

  it('every verdict is in the [0, 3] range', () => {
    for (const v of result.compaction.details.verdicts) {
      expect(v.verdict).toBeGreaterThanOrEqual(0);
      expect(v.verdict).toBeLessThanOrEqual(3);
      expect(v.confidence).toBeGreaterThanOrEqual(0);
      expect(v.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('enforces cut-point rule: tool-call ↔ tool-result must stay together', () => {
    const verdicts = result.compaction.details.verdicts;
    const v1 = verdicts[1].verdict; // assistant tool-call
    const v2 = verdicts[2].verdict; // tool-result
    // Either both kept or neither; pi's compaction rule requires attachment.
    expect(v1 >= 2 && v2 >= 2).toBeTruthy();
  });
});
// Run after assertions to surface the smoke artifact in the local console
console.log('Smoke test summary (first 600 chars):');
console.log('---');
console.log((result?.compaction?.summary ?? '').slice(0, 600));
console.log('---');