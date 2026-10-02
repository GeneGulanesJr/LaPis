'use strict';

/**
 * Hooks-engine: pattern-matcher
 *
 * Transport-agnostic port of extensions/memory-layer/hooks/pattern-matcher.ts.
 * Pure functions — no Pi ExtensionAPI, no process I/O, no dispatch.
 */

const HEDGING_SIGNALS = [
    /\b(maybe|perhaps|might|could try|let me (try|check|think|see))\b/i,
    /\b(for now|tentatively|as a test|temporarily|to see if)\b/i,
    /\b(i think we (should|could|might))\b/i,
  ],
  CONFIDENCE_SIGNALS = [
    /\b(because|since|the reason|to avoid|for better)\b/i,
    /\b(decided|chosen|selected|confirmed)\b/i,
  ],
  DECISION_PATTERNS = [
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

  const reasoningZone = text.slice(0, Math.floor(text.length * 0.3)),
    isHedgingInReasoning = HEDGING_SIGNALS.some((h) => h.test(reasoningZone)),
    conclusionZone = text.slice(Math.floor(text.length * 0.5)),
    lastLine =
      text
        .split('\n')
        .filter((line) => line.trim())
        .pop() || '',
    conclusionText = `${conclusionZone}\n${lastLine}`,
    fullText = text;

  for (const pattern of DECISION_PATTERNS) {
    const conclusionMatch = pattern.regex.test(conclusionText),
      fullMatch = pattern.regex.test(fullText);

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

// Slice 2: regex-first cascade (spec §10). High/medium regex matches return
// exactly as today — the judgment runs ONLY on no-match, and any judgment
// failure is indistinguishable from a no-match. Never throws.
const AUTOSAVE_ENUM = ['decision', 'bugfix', 'discovery', 'architecture', 'pattern', 'nothing'];

async function shouldAutoCaptureWithJudge(text, { judge, floor } = {}) {
  const base = shouldAutoCapture(text);
  if (base.match || base.confidence === 'high') return base;
  if (!judge || !text || text.length < 150) return base; // same 150-char gate as shouldAutoCapture
  try {
    const result = await judge(
      [
        {
          id: 'autosave-0',
          judgment: { kind: 'classify', enum: AUTOSAVE_ENUM, dangerous: 'nothing' },
          instructions:
            'Classify this assistant message for persistent-memory saving. Choose the single best type, or nothing if the message is routine work not worth saving as a memory. Marking real content as nothing is the dangerous outcome.',
          state: { message: text.slice(0, 4000) },
        },
      ],
      { surface: 'autosave' },
    );
    if (!result || result.status !== 'ok') return base;
    const a = result.answers && result.answers[0];
    const minConf = typeof floor === 'number' ? floor : 0.6;
    if (
      !a ||
      a.pick === 'nothing' ||
      a.pick === undefined ||
      typeof a.confidence !== 'number' ||
      a.confidence < minConf
    )
      return base;
    return {
      match: true,
      confidence: 'medium',
      source: 'judgment',
      pattern: { type: a.pick, label: 'Jev semantic match', minConfidence: 'medium' },
    };
  } catch {
    return base;
  }
}

module.exports = {
  shouldAutoCapture,
  shouldAutoCaptureWithJudge,
  DECISION_PATTERNS,
  HEDGING_SIGNALS,
  CONFIDENCE_SIGNALS,
};
