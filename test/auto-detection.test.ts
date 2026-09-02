import { describe, expect, it } from 'vitest';
import { shouldAutoCapture } from '../extensions/memory-layer/hooks/pattern-matcher';

describe('shouldAutoCapture', () => {
  it('matches confident decision with reasoning at end', () => {
    const text = [
        'Looking at the options for data storage.',
        'SQLite has zero external deps and is embedded.',
        "I'll use SQLite because it avoids external dependencies and fits our constraint.",
      ].join('\n'),
      result = shouldAutoCapture(text);
    expect(result.match).toBe(true);
    expect(result.confidence).toBe('high');
  });

  it('rejects hedging in reasoning zone without conclusion match', () => {
    const text = "Maybe I'll use the cache approach for this, but let me check first and see what happens.",
      result = shouldAutoCapture(text);
    expect(result.match).toBe(false);
  });

  it('rejects text under 150 chars', () => {
    const text = "I'll use X because Y",
      result = shouldAutoCapture(text);
    expect(result.match).toBe(false);
  });

  it('matches "root cause" anywhere (high-confidence pattern type)', () => {
    const text = [
        'After investigation, I found the issue.',
        'The root cause was a race condition in the DB connection pool.',
        'Fixed by adding a mutex around the connection acquisition.',
      ].join('\n'),
      result = shouldAutoCapture(text);
    expect(result.match).toBe(true);
  });

  it('prefers conclusion zone match over reasoning zone hedging', () => {
    const text = [
        'Maybe I should try approach A.',
        'No wait, that has issues with concurrency.',
        'Going with approach B because it handles edge cases and has better test coverage.',
      ].join('\n'),
      result = shouldAutoCapture(text);
    expect(result.match).toBe(true);
    expect(result.confidence).toBe('high');
  });

  it('rejects "I\'ll use X for now" hedging without conclusion', () => {
    const text = [
        "I'll use the simple approach for now to see if it works.",
        "If it doesn't perform well, we can switch later.",
        'Let me test this out first.',
      ].join('\n'),
      result = shouldAutoCapture(text);
    expect(result.match).toBe(false);
  });
});
