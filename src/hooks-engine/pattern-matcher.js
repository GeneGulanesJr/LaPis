'use strict';

/**
 * hooks-engine: pattern-matcher
 *
 * Transport-agnostic port of extensions/memory-layer/hooks/pattern-matcher.ts.
 * Pure functions — no Pi ExtensionAPI, no process I/O, no dispatch.
 */

const HEDGING_SIGNALS = [
  /\b(maybe|perhaps|might|could try|let me (try|check|think|see))\b/i,
  /\b(for now|tentatively|as a test|temporarily|to see if)\b/i,
  /\b(i think we (should|could|might))\b/i,
];

const CONFIDENCE_SIGNALS = [
  /\b(because|since|the reason|to avoid|for better)\b/i,
  /\b(decided|chosen|selected|confirmed)\b/i,
];

const DECISION_PATTERNS = [
  {
    regex: /\b(I['']ll use|let's use|going with|switching to|using .* instead of)\b/i,
    type: 'decision',
    label: 'Design decision',
    minConfidence: 'medium',
  },
  {
    regex: /\b(approach|strategy|architecture|pattern|design):\s/i,
    type: 'decision',
    label: 'Architecture choice',
    minConfidence: 'high',
  },
  {
    regex: /\b(root cause|the bug was|fixed by|workaround is to)\b/i,
    type: 'bugfix',
    label: 'Bug fix',
    minConfidence: 'high',
  },
  { regex: /\b(I discovered that|turns out)\b/i, type: 'discovery', label: 'Discovery', minConfidence: 'high' },
  {
    regex: /\b(cannot .* because|constraint is|limitation:)\b/i,
    type: 'architecture',
    label: 'Constraint identified',
    minConfidence: 'high',
  },
];

function shouldAutoCapture(text) {
  if (!text || text.length < 150) {
    return { match: false, confidence: 'low' };
  }

  const reasoningZone = text.slice(0, Math.floor(text.length * 0.3));
  const isHedgingInReasoning = HEDGING_SIGNALS.some((h) => h.test(reasoningZone));

  const conclusionZone = text.slice(Math.floor(text.length * 0.5));
  const lastLine =
    text
      .split('\n')
      .filter((line) => line.trim())
      .pop() || '';
  const conclusionText = `${conclusionZone}\n${lastLine}`;
  const fullText = text;

  for (const pattern of DECISION_PATTERNS) {
    const conclusionMatch = pattern.regex.test(conclusionText);
    const fullMatch = pattern.regex.test(fullText);

    if (conclusionMatch) {
      const hasConfidenceSignal = CONFIDENCE_SIGNALS.some((c) => c.test(conclusionText));
      return {
        match: true,
        confidence: hasConfidenceSignal ? 'high' : 'medium',
        pattern,
      };
    }

    if (fullMatch && pattern.minConfidence === 'high') {
      return { match: true, confidence: 'medium', pattern };
    }
  }

  if (isHedgingInReasoning) {
    return { match: false, confidence: 'low' };
  }

  return { match: false, confidence: 'low' };
}

module.exports = { shouldAutoCapture, DECISION_PATTERNS, HEDGING_SIGNALS, CONFIDENCE_SIGNALS };
