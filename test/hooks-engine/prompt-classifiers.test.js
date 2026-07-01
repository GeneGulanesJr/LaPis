const {
  extractUserPrompt,
  contentToText,
  isSourceAuthoritativePrompt,
  isHistoricalMemoryPrompt,
  isNavigationPrompt,
  isPreflightWorthyPrompt,
  extractMessageText,
} = require('../../src/hooks-engine/prompt-classifiers');

describe('hooks-engine prompt-classifiers: extractUserPrompt', () => {
  test('uses the latest user message content parts', () => {
    expect(
      extractUserPrompt({
        messages: [
          { role: 'system', content: 'System prompt' },
          { role: 'user', content: [{ type: 'text', text: 'Where is x wired?' }] },
        ],
      }),
    ).toBe('Where is x wired?');
  });

  test('falls back to prompt-like event fields', () => {
    expect(extractUserPrompt({ prompt: 'Why FTS5?' })).toBe('Why FTS5?');
  });

  test('returns null when no text prompt is available', () => {
    expect(extractUserPrompt({ messages: [{ role: 'assistant', content: 'Nope' }] })).toBeNull();
  });

  test('truncates long prompts to 500 chars', () => {
    const long = 'x'.repeat(600);
    const out = extractUserPrompt({ prompt: long });
    expect(out.length).toBeLessThanOrEqual(503);
    expect(out.endsWith('...')).toBe(true);
  });
});

describe('hooks-engine prompt-classifiers: classifiers', () => {
  test('isSourceAuthoritativePrompt', () => {
    expect(isSourceAuthoritativePrompt('answer from the code')).toBe(true);
    expect(isSourceAuthoritativePrompt('where is the hook wired')).toBe(false);
    expect(isSourceAuthoritativePrompt(null)).toBe(false);
  });

  test('isHistoricalMemoryPrompt', () => {
    expect(isHistoricalMemoryPrompt('Why did we choose SQLite?')).toBe(true);
    expect(isHistoricalMemoryPrompt('what is this')).toBe(false);
  });

  test('isNavigationPrompt', () => {
    expect(isNavigationPrompt('where is the module path')).toBe(true);
    expect(isNavigationPrompt('add a feature')).toBe(false);
  });

  test('isPreflightWorthyPrompt triggers on coding verbs, not questions', () => {
    expect(isPreflightWorthyPrompt('fix the memory leak')).toBe(true);
    expect(isPreflightWorthyPrompt('add a route')).toBe(true);
    expect(isPreflightWorthyPrompt('what is LaPis?')).toBe(false);
    expect(isPreflightWorthyPrompt(null)).toBe(false);
  });
});

describe('hooks-engine prompt-classifiers: extractMessageText', () => {
  test('string content', () => {
    expect(extractMessageText({ content: 'hi' })).toBe('hi');
  });

  test('text parts joined', () => {
    expect(
      extractMessageText({
        content: [
          { type: 'text', text: 'a' },
          { type: 'image', url: 'x' },
          { type: 'text', text: 'b' },
        ],
      }),
    ).toBe('a b');
  });

  test('null/empty', () => {
    expect(extractMessageText(null)).toBe('');
    expect(extractMessageText({})).toBe('');
  });
});
