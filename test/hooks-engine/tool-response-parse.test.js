const {
  extractResponseText,
  parseMemoryIds,
  parseSearchResultIds,
  wasSaveSuccessful,
} = require('../../src/hooks-engine/tool-response-parse');

describe('hooks-engine tool-response-parse', () => {
  describe('parseMemoryIds', () => {
    test('parses [#42] markers', () => {
      expect(parseMemoryIds('Memory saved: [#42] My decision')).toEqual([42]);
    });

    test('parses multiple ids', () => {
      expect(parseMemoryIds('- [#1] a\n- [#2] b')).toEqual([1, 2]);
    });

    test('returns empty for missing markers', () => {
      expect(parseMemoryIds('no ids here')).toEqual([]);
    });

    test('handles null/empty input', () => {
      expect(parseMemoryIds(null)).toEqual([]);
      expect(parseMemoryIds('')).toEqual([]);
    });
  });

  describe('parseSearchResultIds', () => {
    test('parses formatted search lines', () => {
      const text = 'Found 2 memories:\n- [#10] [decision] Auth flow\n- [#11] [bugfix] Fix login';
      expect(parseSearchResultIds(text)).toEqual([10, 11]);
    });

    test('parses JSON results envelope', () => {
      const text = JSON.stringify({ results: [{ id: 7 }, { id: 8 }] });
      expect(parseSearchResultIds(text)).toEqual([7, 8]);
    });

    test('falls back to markers when JSON is invalid', () => {
      expect(parseSearchResultIds('{not json [#3]')).toEqual([3]);
    });
  });

  describe('wasSaveSuccessful', () => {
    test('true for successful save with id', () => {
      expect(wasSaveSuccessful('Memory saved: [#42] Title')).toBe(true);
    });

    test('false for potential duplicate warning', () => {
      expect(wasSaveSuccessful('Potential duplicate detected:\n  - [#5] Similar (90% similar)')).toBe(false);
    });

    test('false for duplicate with leading warning emoji stripped context', () => {
      expect(wasSaveSuccessful('Warning: Potential duplicate detected')).toBe(false);
    });

    test('true for JSON save result with id', () => {
      expect(wasSaveSuccessful(JSON.stringify({ id: 99, title: 'x' }))).toBe(true);
    });

    test('false for JSON potential_duplicate status', () => {
      expect(wasSaveSuccessful(JSON.stringify({ status: 'potential_duplicate', matches: [] }))).toBe(false);
    });

    test('false for error responses', () => {
      expect(wasSaveSuccessful('Error: boom')).toBe(false);
      expect(wasSaveSuccessful('Failed to save memory.')).toBe(false);
    });
  });

  describe('extractResponseText', () => {
    test('joins MCP content blocks', () => {
      const tr = { content: [{ type: 'text', text: 'line1' }, { type: 'text', text: 'line2' }] };
      expect(extractResponseText(tr)).toBe('line1\nline2');
    });

    test('passes through strings', () => {
      expect(extractResponseText('plain')).toBe('plain');
    });

    test('handles null', () => {
      expect(extractResponseText(null)).toBe('');
    });
  });
});
