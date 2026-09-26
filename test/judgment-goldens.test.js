// vitest globals enabled — no import
// Provider-neutral golden replay (spec §11.2): validates golden shape, runs the
// PURE pipeline (contract → evaluate) on expected answers, and shape-checks the
// jev translation — all with NO network. A future provider passes these same
// files through its adapter; that is the switch acceptance run.
const fs = require('fs');
const path = require('path');
const { assertValidQuestion, assertValidAnswers } = require('../src/judgment/contract');
const { evaluate } = require('../src/judgment/evaluate');
const { buildWireQuestion } = require('../src/judgment/adapters/jev');

const GOLDEN_DIR = path.join(__dirname, 'judgment-goldens');
const goldens = fs.readdirSync(GOLDEN_DIR).filter((f) => f.endsWith('.json')).map((f) => ({
  file: f,
  golden: JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, f), 'utf-8')),
}));

describe('judgment goldens replay', () => {
  it('has at least the two seed goldens', () => {
    expect(goldens.length).toBeGreaterThanOrEqual(2);
  });

  for (const { file, golden } of goldens) {
    it(`${file}: questions valid, expected answers valid, policy outcome matches`, () => {
      expect(golden.surface).toBeTruthy();
      for (const q of golden.questions) expect(() => assertValidQuestion(q)).not.toThrow();
      expect(() => assertValidAnswers(golden.questions, golden.expected)).not.toThrow();
      const pol = golden.policy;
      const outcome = evaluate({ questions: golden.questions, answers: golden.expected, threshold: pol.threshold });
      expect(outcome.blocked.map((b) => b.id).sort()).toEqual([...(pol.expectBlocked || [])].sort());
      expect(outcome.warned.map((w) => w.id).sort()).toEqual([...(pol.expectWarned || [])].sort());
    });
    it(`${file}: every question translates to a valid wire question (no throw)`, () => {
      for (const q of golden.questions) expect(() => buildWireQuestion(q)).not.toThrow();
    });
  }
});
