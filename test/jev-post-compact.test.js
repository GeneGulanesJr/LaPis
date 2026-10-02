import { describe, it, expect, beforeEach } from 'vitest';
import { runJevPostCompact } from '../extensions/memory-layer/hooks/jev-post-compact.ts';

describe('runJevPostCompact', () => {
  beforeEach(() => {
    process.env.JEV_DRY_RUN = '1';
  });

  it('returns an empty output when there is no project', async () => {
    const out = await runJevPostCompact({
      currentProject: '',
      sessionId: 1,
      pinnedPolicies: [],
      reInjectedTitles: [],
      lostTopics: [],
    });
    expect(out).toEqual({ messages: [] });
  });

  it('emits two messages (C + A) in dry-run mode', async () => {
    const out = await runJevPostCompact({
      currentProject: 'Documents',
      sessionId: 1,
      pinnedPolicies: ['no hardcoded secrets'],
      reInjectedTitles: ['phase 5 schema fallback'],
      lostTopics: [],
    });
    expect(out.messages).toHaveLength(2);
    const cMessage = out.messages.find((m) => m.kind === 'reclassify');
    expect(cMessage).toBeDefined();
    expect(cMessage.choice).toMatch(/^(yes|partial|no)$/);
    expect(cMessage.confidence).toBeGreaterThanOrEqual(0);
  });

  it('emits a verdict message for A with a valid label', async () => {
    const out = await runJevPostCompact({
      currentProject: 'Documents',
      sessionId: 1,
      pinnedPolicies: [],
      reInjectedTitles: ['bun chosen over npm'],
      lostTopics: ['decided to use bun instead of npm'],
    });
    const aMessage = out.messages.find((m) => m.kind === 'verdict');
    expect(aMessage).toBeDefined();
    expect(aMessage.score).toBeGreaterThanOrEqual(0);
    expect(aMessage.score).toBeLessThan(4);
    expect(aMessage.label).toMatch(/incomplete|partial|mostly-complete|complete/);
  });

  it('returns [] when JEV_ENABLED unset AND not in dry-run', async () => {
    delete process.env.JEV_DRY_RUN;
    delete process.env.JEV_ENABLED;
    const out = await runJevPostCompact({
      currentProject: 'Documents',
      sessionId: 1,
      pinnedPolicies: ['x'],
      reInjectedTitles: ['y'],
      lostTopics: [],
    });
    expect(out.messages).toEqual([]);
  });

  it('never throws — failures degrade to an empty output', async () => {
    // Force a non-dry-run with no API key set
    delete process.env.JEV_DRY_RUN;
    delete process.env.JEV_API_KEY;
    process.env.JEV_ENABLED = '1';

    const out = await runJevPostCompact({
      currentProject: 'Documents',
      sessionId: 1,
      pinnedPolicies: ['x'],
      reInjectedTitles: ['y'],
      lostTopics: [],
    });
    // No key → liveAsk throws → we swallow and return []
    expect(out.messages).toEqual([]);
  });
});
