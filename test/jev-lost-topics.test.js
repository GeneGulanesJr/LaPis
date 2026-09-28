import { describe, it, expect } from 'vitest';
import { diffLostTopics } from '../extensions/memory-layer/host/jev-lost-topics.ts';

describe('diffLostTopics', () => {
  it('returns [] when before is null (no baseline)', () => {
    expect(diffLostTopics(null, ['a', 'b'])).toEqual([]);
  });

  it('returns [] when before is empty', () => {
    expect(diffLostTopics([], ['a', 'b'])).toEqual([]);
  });

  it('returns [] when after contains every before title (no loss)', () => {
    expect(diffLostTopics(['a', 'b'], ['a', 'b', 'c'])).toEqual([]);
  });

  it('returns titles in before that are missing from after', () => {
    expect(diffLostTopics(['a', 'b', 'c'], ['a', 'c'])).toEqual(['b']);
  });

  it('returns all titles when after is empty (full loss)', () => {
    expect(diffLostTopics(['a', 'b', 'c'], [])).toEqual(['a', 'b', 'c']);
  });

  it('preserves order from before (insertion order)', () => {
    expect(diffLostTopics(['c', 'a', 'b'], ['c'])).toEqual(['a', 'b']);
  });

  it('is case-sensitive (title-as-key fidelity)', () => {
    expect(diffLostTopics(['Foo'], ['foo'])).toEqual(['Foo']);
  });

  it('handles duplicates in before gracefully (dedupes output)', () => {
    // If before has duplicates, they appear once in the output
    expect(diffLostTopics(['a', 'a', 'b'], ['a'])).toEqual(['b']);
  });
});
