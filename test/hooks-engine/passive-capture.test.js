const {
  buildAutoDecisionPayload,
  shouldCheckpoint,
  shouldDream,
  isAutoDecisionCoolingDown,
} = require('../../src/hooks-engine/passive-capture');

describe('hooks-engine passive-capture: buildAutoDecisionPayload', () => {
  const capture = { match: true, confidence: 'high', pattern: { type: 'decision', label: 'Design decision' } };

  test('builds payload from a matched capture', () => {
    const payload = buildAutoDecisionPayload({
      text: 'Some long reasoning here.\nThen a conclusion line.',
      capture,
      project: 'myproj',
      sessionId: 7,
    });
    expect(payload.type).toBe('decision');
    expect(payload.scope).toBe('project');
    expect(payload.project).toBe('myproj');
    expect(payload.title).toContain('Design decision');
    expect(payload.content).toContain('confidence: high');
    expect(payload.content).toContain('Session 7');
  });

  test('returns null when capture did not match', () => {
    expect(
      buildAutoDecisionPayload({ text: 'x', capture: { match: false, confidence: 'low' }, project: 'p', sessionId: 1 }),
    ).toBeNull();
  });

  test('returns null for low confidence', () => {
    expect(
      buildAutoDecisionPayload({
        text: 'x',
        capture: { match: true, confidence: 'low', pattern: { type: 'x', label: 'y' } },
        project: 'p',
        sessionId: 1,
      }),
    ).toBeNull();
  });
});

describe('hooks-engine passive-capture: gating helpers', () => {
  test('shouldCheckpoint fires on interval boundary, not 0', () => {
    expect(shouldCheckpoint(0, 10)).toBe(false);
    expect(shouldCheckpoint(10, 10)).toBe(true);
    expect(shouldCheckpoint(20, 10)).toBe(true);
    expect(shouldCheckpoint(15, 10)).toBe(false);
  });

  test('shouldDream fires once at threshold', () => {
    expect(shouldDream(50, false)).toBe(true);
    expect(shouldDream(50, true)).toBe(false);
    expect(shouldDream(40, false)).toBe(false);
    expect(shouldDream(100, false, 50)).toBe(false);
  });

  test('isAutoDecisionCoolingDown respects cooldown window', () => {
    const now = 100000;
    expect(isAutoDecisionCoolingDown(now - 30000, now, 60000)).toBe(true);
    expect(isAutoDecisionCoolingDown(now - 70000, now, 60000)).toBe(false);
  });
});
