import { describe, it, expect, beforeEach } from 'vitest';

process.env.JEV_DRY_RUN = '1';
process.env.PI_COMPACTION_JUDG_ENABLED = '1';
process.env.PI_COMPACTION_JUDG = 'jev';

import {
  readPlannerSettings,
  enforceCutPointRules,
} from '../extensions/memory-layer/hooks/jev-compaction-planner.ts';
import {
  registerCompactionJudg,
  __resetJudgRegistryForTests,
  resolveCompactionJudg,
} from '../extensions/memory-layer/host/compaction-judg.ts';
import { JevCompactionJudg } from '../extensions/memory-layer/host/strategies/jev-compaction-judg.ts';
import { NoopCompactionJudg } from '../extensions/memory-layer/host/strategies/noop-compaction-judg.ts';
import { DefaultCompactionJudg } from '../extensions/memory-layer/host/strategies/default-compaction-judg.ts';

// ---------------------------------------------------------------------------
// Settings resolution
// ---------------------------------------------------------------------------

describe('readPlannerSettings', () => {
  beforeEach(() => {
    delete process.env.PI_COMPACTION_JUDG;
    delete process.env.PI_COMPACTION_JUDG_ENABLED;
    delete process.env.PI_COMPACTION_JUDG_PATH;
    delete process.env.PI_COMPACTION_JUDG_THRESHOLD;
    delete process.env.PI_COMPACTION_JUDG_DRY_RUN;
    delete process.env.JEV_COMPACTION_ENABLED;
  });

  it('returns enabled=false when no compaction config is present', () => {
    const s = readPlannerSettings({});
    expect(s.enabled).toBe(false);
    expect(s.name).toBe(null);
    expect(s.thresholdTokens).toBe(100_000);
  });

  it('honors compaction.judg setting when set to a real strategy', () => {
    const s = readPlannerSettings({ compaction: { judg: 'jev' } });
    expect(s.enabled).toBe(true);
    expect(s.name).toBe('jev');
  });

  it('does NOT enable when compaction.judg is "default" or "noop"', () => {
    const a = readPlannerSettings({ compaction: { judg: 'default' } });
    const b = readPlannerSettings({ compaction: { judg: 'noop' } });
    expect(a.enabled).toBe(false);
    expect(b.enabled).toBe(false);
  });

  it('respects env PI_COMPACTION_JUDG over settings when both are set', () => {
    const s = readPlannerSettings({ compaction: { judg: 'foo' } });
    process.env.PI_COMPACTION_JUDG = 'jev';
    const s2 = readPlannerSettings({ compaction: { judg: 'foo' } });
    expect(s.name).toBe('foo');
    expect(s2.name).toBe('jev');
  });

  it('honors custom threshold', () => {
    const s = readPlannerSettings({ compaction: { judg: 'jev', judgThresholdTokens: 50_000 } });
    expect(s.thresholdTokens).toBe(50_000);
  });

  it('clamps invalid threshold to default 100_000', () => {
    const s = readPlannerSettings({ compaction: { judg: 'jev', judgThresholdTokens: -1 } });
    expect(s.thresholdTokens).toBe(100_000);
  });
});

// ---------------------------------------------------------------------------
// Registry + strategies
// ---------------------------------------------------------------------------

describe('compaction-judg registry', () => {
  beforeEach(() => {
    __resetJudgRegistryForTests();
  });

  it('rejects duplicate registration', () => {
    registerCompactionJudg('x', new NoopCompactionJudg());
    expect(() => registerCompactionJudg('x', new NoopCompactionJudg())).toThrow(/already registered/);
  });

  it('rejects impl missing decideKeep()', () => {
    expect(() =>
      registerCompactionJudg('broken', { name: 'broken' } as any),
    ).toThrow(/decideKeep/);
  });

  it('resolves registered strategies', async () => {
    registerCompactionJudg('noop', new NoopCompactionJudg());
    registerCompactionJudg('default', new DefaultCompactionJudg());
    registerCompactionJudg('jev', new JevCompactionJudg());
    expect((await resolveCompactionJudg('noop'))!.name).toBe('noop');
    expect((await resolveCompactionJudg('default'))!.name).toBe('default');
    expect((await resolveCompactionJudg('jev'))!.name).toBe('jev');
  });

  it('returns undefined for unknown names that are not paths', async () => {
    expect(await resolveCompactionJudg('not-a-real-strategy')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Per-strategy behavior
// ---------------------------------------------------------------------------

describe('strategy implementations', () => {
  it('JevCompactionJudg returns a valid verdict + reason under dry-run', async () => {
    const j = new JevCompactionJudg();
    const r = await j.decideKeep({
      message: { role: 'user', content: 'hello' } as any,
      messageIndex: 0,
      totalMessages: 1,
      fileOps: { readFiles: [], modifiedFiles: [] } as any,
      tokensBefore: 50_000,
      model: 'test-model',
    });
    expect([0, 1, 2, 3]).toContain(r.verdict);
    expect(r.confidence).toBeGreaterThanOrEqual(0);
    expect(r.confidence).toBeLessThanOrEqual(1);
    expect(r.reason).toMatch(/^jev:/);
  });

  it('DefaultCompactionJudg always returns verdict=1', async () => {
    const d = new DefaultCompactionJudg();
    const r = await d.decideKeep({
      message: { role: 'user', content: 'x' } as any,
      messageIndex: 0,
      totalMessages: 1,
      fileOps: { readFiles: [], modifiedFiles: [] } as any,
      tokensBefore: 0,
      model: 'm',
    });
    expect(r.verdict).toBe(1);
  });

  it('NoopCompactionJudg always returns verdict=1', async () => {
    const n = new NoopCompactionJudg();
    const r = await n.decideKeep({
      message: { role: 'user', content: 'x' } as any,
      messageIndex: 0,
      totalMessages: 1,
      fileOps: { readFiles: [], modifiedFiles: [] } as any,
      tokensBefore: 0,
      model: 'm',
    });
    expect(r.verdict).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Cut-point enforcement
// ---------------------------------------------------------------------------

describe('enforceCutPointRules', () => {
  const toolResultMessage = { role: 'toolResult', content: 'tool output' } as any;
  const toolCallMessage = { role: 'assistant', content: [{ type: 'toolCall', name: 'read' }] } as any;
  const userMessage = { role: 'user', content: 'please read x' } as any;

  it('promotes a tool-call keep to force the next tool result to keep-verbatim', () => {
    const verdicts = [
      { verdict: 2, confidence: 1, reason: 'keep' }, // assistant with tool call
      { verdict: 0, confidence: 1, reason: 'drop' }, // tool result
    ];
    const out = enforceCutPointRules(verdicts, [toolCallMessage, toolResultMessage]);
    expect(out[0].verdict).toBe(2);
    expect(out[1].verdict).toBe(2); // promoted from 0
    expect(out[1].reason).toMatch(/forced/);
  });

  it('promotes a tool-result keep to force the preceding tool-call keep', () => {
    const verdicts = [
      { verdict: 0, confidence: 1, reason: 'drop' }, // tool call
      { verdict: 2, confidence: 1, reason: 'keep' }, // tool result
    ];
    const out = enforceCutPointRules(verdicts, [toolCallMessage, toolResultMessage]);
    expect(out[0].verdict).toBe(2); // promoted
    expect(out[1].verdict).toBe(2);
  });

  it('promotes both neighbors when verdict=3 (keep-with-tools)', () => {
    const verdicts = [
      { verdict: 0, confidence: 1 },
      { verdict: 3, confidence: 1, reason: 'keep-with-tools' }, // tool call
      { verdict: 0, confidence: 1 }, // tool result
    ];
    const out = enforceCutPointRules(verdicts, [userMessage, toolCallMessage, toolResultMessage]);
    expect(out[0].verdict).toBeGreaterThanOrEqual(2);
    expect(out[1].verdict).toBe(3);
    expect(out[2].verdict).toBeGreaterThanOrEqual(2);
  });

  it('does not demote messages — only promotes', () => {
    const verdicts = [
      { verdict: 2, confidence: 1 },
      { verdict: 2, confidence: 1 },
      { verdict: 2, confidence: 1 },
    ];
    const out = enforceCutPointRules(verdicts, [userMessage, userMessage, userMessage]);
    expect(out.every((v) => v.verdict === 2)).toBe(true);
  });

  it('returns an empty array unchanged', () => {
    expect(enforceCutPointRules([], [])).toEqual([]);
  });
});