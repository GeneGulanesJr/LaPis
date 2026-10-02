// vitest globals enabled — no import
const { assertValidQuestion, assertValidAnswers, SURFACES } = require('../src/judgment/contract');

const classifyQ = {
  id: 'msg-type',
  judgment: { kind: 'classify', enum: ['decision', 'bugfix', 'discovery', 'pattern', 'nothing'] },
  instructions: 'Classify the assistant message.',
  state: { message: 'Shipped X because Y' },
};
const probQ = {
  id: 'superseded',
  judgment: { kind: 'probability', claim: 'A is superseded by B' },
  instructions: 'Judge supersession.',
  state: { a: 'old title', b: 'new title' },
};

describe('assertValidQuestion', () => {
  it('accepts classify and probability questions', () => {
    expect(() => assertValidQuestion(classifyQ)).not.toThrow();
    expect(() => assertValidQuestion(probQ)).not.toThrow();
  });
  it('rejects missing id/instructions/state and unknown kinds', () => {
    expect(() => assertValidQuestion({ ...classifyQ, id: undefined })).toThrow(/id/);
    expect(() => assertValidQuestion({ ...classifyQ, instructions: '' })).toThrow(/instructions/);
    expect(() => assertValidQuestion({ ...classifyQ, state: {} })).toThrow(/state/);
    expect(() => assertValidQuestion({ ...classifyQ, judgment: { kind: 'vibe' } })).toThrow(/kind/);
  });
  it('rejects classify without non-empty enum', () => {
    expect(() => assertValidQuestion({ ...classifyQ, judgment: { kind: 'classify', enum: [] } })).toThrow(/enum/);
  });
  it('rejects probability without claim', () => {
    expect(() =>
      assertValidQuestion({ id: 'x', judgment: { kind: 'probability' }, instructions: 'i', state: { a: 1 } }),
    ).toThrow(/claim/);
  });
  it('rejects grade without 2+ levels', () => {
    expect(() =>
      assertValidQuestion({
        id: 'x',
        judgment: { kind: 'grade', levels: ['only'] },
        instructions: 'i',
        state: { a: 1 },
      }),
    ).toThrow(/levels/);
  });
});

describe('assertValidAnswers', () => {
  it('accepts well-formed answers and validates answer field per kind', () => {
    const answers = [
      { id: 'msg-type', pick: 'decision', confidence: 0.9 },
      { id: 'superseded', p: 0.2, confidence: 0.8 },
    ];
    expect(() => assertValidAnswers([probQ, classifyQ], answers)).not.toThrow();
  });
  it('rejects unknown answer ids and kind/field mismatches (R3: malformed = invalid)', () => {
    expect(() => assertValidAnswers([probQ], [{ id: 'nope', p: 1, confidence: 1 }])).toThrow(/unknown answer id/);
    expect(() => assertValidAnswers([probQ], [{ id: 'superseded', confidence: 0.9 }])).toThrow(/p/); // missing p
    expect(() => assertValidAnswers([probQ], [{ id: 'superseded', p: 'high', confidence: 0.9 }])).toThrow(/p/); // non-numeric p
    expect(() => assertValidAnswers([probQ], [{ id: 'superseded', p: 5, confidence: 0.9 }])).toThrow(/p/); // out of range
    expect(() => assertValidAnswers([classifyQ], [{ id: 'msg-type', pick: 'alien', confidence: 0.9 }])).toThrow(/enum/);
    expect(() => assertValidAnswers([probQ], [{ id: 'superseded', p: 0.5 }])).toThrow(/confidence/);
  });
});

it('exports the known surface list for flag/docs matrix', () => {
  expect(SURFACES).toContain('dream');
  expect(SURFACES).toContain('autosave');
});
