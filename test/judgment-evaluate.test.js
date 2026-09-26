// vitest globals enabled — no import
const { evaluate } = require('../src/judgment/evaluate');

const blockBad = {
  id: 'check',
  judgment: { kind: 'classify', enum: ['safe', 'unsafe'], dangerous: 'unsafe' },
  instructions: 'i',
  state: { a: 1 },
};
const probQ = {
  id: 'sup',
  judgment: { kind: 'probability', claim: 'A superseded by B' },
  instructions: 'i',
  state: { a: 1 },
};

describe('evaluate', () => {
  it('blocks dangerous picks at/above the confidence floor', () => {
    const r = evaluate({ questions: [blockBad], answers: [{ id: 'check', pick: 'unsafe', confidence: 0.9 }], threshold: 0.6 });
    expect(r.blocked.map((b) => b.id)).toEqual(['check']);
    expect(r.ok).toBe(false);
  });
  it('warns (not blocks) on sub-floor dangerous picks (RetellMCP P1 lesson)', () => {
    const r = evaluate({ questions: [blockBad], answers: [{ id: 'check', pick: 'unsafe', confidence: 0.4 }], threshold: 0.6 });
    expect(r.blocked).toEqual([]);
    expect(r.warned.map((w) => w.id)).toEqual(['check']);
    expect(r.ok).toBe(true);
  });
  it('escalates missing/unknown confidence instead of silently passing (§7 missing evidence)', () => {
    const r = evaluate({ questions: [blockBad], answers: [{ id: 'check', pick: 'unsafe', confidence: 0.4 }], threshold: 0.6, strictConfidence: true });
    expect(r.escalated.length).toBe(1);
  });
  it('blocks probability when claim is true (p > 0.5) at/above floor', () => {
    const r = evaluate({ questions: [probQ], answers: [{ id: 'sup', p: 0.93, confidence: 0.9 }], threshold: 0.6 });
    expect(r.blocked.map((b) => b.id)).toEqual(['sup']);
    const clean = evaluate({ questions: [probQ], answers: [{ id: 'sup', p: 0.1, confidence: 0.9 }], threshold: 0.6 });
    expect(clean.ok).toBe(true);
    expect(clean.blocked).toEqual([]);
  });
  it('safe picks never block regardless of confidence', () => {
    const r = evaluate({ questions: [blockBad], answers: [{ id: 'check', pick: 'safe', confidence: 0.1 }], threshold: 0.6 });
    expect(r.ok).toBe(true);
  });
  it('ignores answers for questions without a declared dangerous answer', () => {
    const benign = { id: 'b', judgment: { kind: 'classify', enum: ['x', 'y'] }, instructions: 'i', state: { s: 1 } };
    const r = evaluate({ questions: [benign], answers: [{ id: 'b', pick: 'x', confidence: 0.9 }], threshold: 0.6 });
    expect(r.ok).toBe(true);
  });
});
