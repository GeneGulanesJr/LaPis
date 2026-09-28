import { describe, it, expect } from 'vitest';
import {
  buildReclassifyQuestion,
  buildVerdictQuestion,
} from '../extensions/memory-layer/host/jev-questions.ts';

describe('jev-questions', () => {
  describe('buildReclassifyQuestion (C)', () => {
    it('asks whether all pinned policies are referenced in the re-injected slice', () => {
      const q = buildReclassifyQuestion({
        pinnedPolicies: ['no hardcoded secrets', 'memory-search before memory-save'],
        reInjectedTitles: ['Jev Phase 5 schema fallback', 'Compact test fixture'],
      });
      expect(q.kind).toBe('choice');
      expect(q.question).toMatch(/pinned polic/i);
      expect(q.question).toContain('no hardcoded secrets');
      expect(q.question).toContain('memory-search before memory-save');
      expect(q.question).toContain('Jev Phase 5 schema fallback');
      const keys = q.options.map((o) => o.key);
      expect(keys).toEqual(['yes', 'partial', 'no']);
    });

    it('handles empty pinned-policy list without crashing', () => {
      const q = buildReclassifyQuestion({ pinnedPolicies: [], reInjectedTitles: ['x'] });
      expect(q.kind).toBe('choice');
      expect(q.question).toMatch(/no pinned policies/i);
    });
  });

  describe('buildVerdictQuestion (A)', () => {
    it('asks for a score on completeness of the post-compact slice', () => {
      const q = buildVerdictQuestion({
        lostTopics: ['decided to use bun instead of npm'],
        reInjectedTitles: ['bun chosen over npm', 'Phase 3 advisor shipped'],
      });
      expect(q.kind).toBe('score');
      expect(q.levels).toEqual(['incomplete', 'partial', 'mostly-complete', 'complete']);
      expect(q.question).toContain('decided to use bun instead of npm');
      expect(q.question).toContain('bun chosen over npm');
    });

    it('handles no lost topics (everything carried)', () => {
      const q = buildVerdictQuestion({ lostTopics: [], reInjectedTitles: ['x'] });
      expect(q.question).toMatch(/nothing (was )?lost/i);
    });
  });
});
