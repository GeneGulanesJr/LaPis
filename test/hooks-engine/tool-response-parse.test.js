const {
  extractToolResponseText,
  parseMemoryIds,
  parseSearchResultIds,
  wasSaveSuccessful,
} = require('../../src/hooks-engine/tool-response-parse');

describe('hooks-engine tool-response-parse: extractToolResponseText', () => {
  test('passes a plain string through', () => {
    expect(extractToolResponseText('hello')).toBe('hello');
  });

  test('joins a content-block array', () => {
    const tr = [
      { type: 'text', text: 'line one' },
      { type: 'text', text: 'line two' },
    ];
    expect(extractToolResponseText(tr)).toBe('line one\nline two');
  });

  test('unwraps a CallToolResult { content: [...] } object', () => {
    const tr = { content: [{ type: 'text', text: '✅ Memory saved: [#7] x' }] };
    expect(extractToolResponseText(tr)).toContain('[#7]');
  });

  test('reads a { text } object', () => {
    expect(extractToolResponseText({ text: 'boom' })).toBe('boom');
  });

  test('JSON-stringifies an arbitrary structured object', () => {
    expect(extractToolResponseText({ id: 42, title: 't' })).toBe('{"id":42,"title":"t"}');
  });

  test('empty for null/undefined', () => {
    expect(extractToolResponseText(null)).toBe('');
    expect(extractToolResponseText(undefined)).toBe('');
  });
});

describe('hooks-engine tool-response-parse: parseSearchResultIds', () => {
  test('parses [#id] markers in order, deduped', () => {
    const text = 'Found 3 memories:\n- [#42] [decision] A\n- [#7] [bugfix] B\n- [#42] [pattern] dup';
    expect(parseSearchResultIds(text)).toEqual([42, 7]);
  });

  test('parses from content-block shape', () => {
    const tr = { content: [{ type: 'text', text: 'Found 1 memories:\n- [#99] [note] Z' }] };
    expect(parseSearchResultIds(tr)).toEqual([99]);
  });

  test('falls back to structured { results: [{id}] } JSON', () => {
    const tr = JSON.stringify({ results: [{ id: 5 }, { id: 6 }] });
    expect(parseSearchResultIds(tr)).toEqual([5, 6]);
  });

  test('empty when no results', () => {
    expect(parseSearchResultIds('No memories found.')).toEqual([]);
  });
});

describe('hooks-engine tool-response-parse: parseMemoryIds', () => {
  test('matches bracketed and bare #id headers', () => {
    expect(parseMemoryIds('## #12 — Title\nType: decision')).toEqual([12]);
    expect(parseMemoryIds('- [#3] a\nrelated → #8')).toEqual([3, 8]);
  });

  test('robust to format drift (unknown wrapper text)', () => {
    expect(parseMemoryIds('random log line [#101] embedded')).toEqual([101]);
  });
});

describe('hooks-engine tool-response-parse: wasSaveSuccessful', () => {
  test('true for the ✅ saved marker', () => {
    expect(wasSaveSuccessful('✅ Memory saved: [#42] My title')).toBe(true);
  });

  test('true for the auto-merged save variant', () => {
    expect(wasSaveSuccessful('✅ Memory saved [#42] x\n🔄 Auto-merged: superseded older [#9]')).toBe(true);
  });

  test('false for the ⚠️ potential-duplicate warning', () => {
    expect(wasSaveSuccessful('⚠️ Potential duplicate detected:\n  - [#9] Existing (88% similar)')).toBe(false);
  });

  test('false for explicit failures', () => {
    expect(wasSaveSuccessful('Failed to save memory.')).toBe(false);
    expect(wasSaveSuccessful('Unexpected error: boom')).toBe(false);
  });

  test('structured fallback: success when JSON has an id and no error', () => {
    expect(wasSaveSuccessful(JSON.stringify({ id: 42, title: 't' }))).toBe(true);
  });

  test('structured fallback: false for potential_duplicate status', () => {
    expect(wasSaveSuccessful(JSON.stringify({ status: 'potential_duplicate', matches: [] }))).toBe(false);
  });

  test('false for empty / unparseable', () => {
    expect(wasSaveSuccessful('')).toBe(false);
    expect(wasSaveSuccessful(null)).toBe(false);
  });
});
