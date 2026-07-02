const {
  normalizeToolResponseText,
  parseMemoryIds,
  parseSearchResultIds,
  wasSaveSuccessful,
} = require('../../src/hooks-engine/tool-response-parse');

describe('hooks-engine tool-response-parse', () => {
  test('parseMemoryIds reads bracket and heading markers once', () => {
    const text = 'Memory saved: [#42] title\n## #43 - Older note\nRelated: [#42]';
    expect(parseMemoryIds(text)).toEqual([42, 43]);
  });

  test('parseSearchResultIds only reads rendered search result bullets', () => {
    const text = [
      'Found 2 memories:',
      '- [#12] [decision] Use bridge state',
      '  snippet mentioning [#99] should not count',
      '- [#13] [bugfix] Mirror recall state',
    ].join('\n');
    expect(parseSearchResultIds(text)).toEqual([12, 13]);
  });

  test('wasSaveSuccessful distinguishes saved output from duplicate warnings', () => {
    expect(wasSaveSuccessful('Memory saved: [#7] New memory')).toBe(true);
    expect(wasSaveSuccessful('Potential duplicate detected:\n  - [#7] Existing memory')).toBe(false);
  });

  test('normalizes MCP-style content arrays and survives format drift', () => {
    const response = { content: [{ type: 'text', text: 'Found 1 memories:\n- [#8] [pattern] A' }] };
    expect(normalizeToolResponseText(response)).toContain('[#8]');
    expect(parseSearchResultIds(response)).toEqual([8]);
    expect(parseMemoryIds(null)).toEqual([]);
  });
});
