// vitest globals are enabled (house style — see test/changed-paths.test.js); never import vitest
const { normalizeScore, band, capText, chunk, CONFIDENT_THRESHOLD } = require('../src/judgment/internal');

describe('normalizeScore', () => {
  it('clamps to [0,1] and forces float', () => {
    expect(normalizeScore(0.5)).toBe(0.5);
    expect(normalizeScore(-1)).toBe(0);
    expect(normalizeScore(2)).toBe(1);
    expect(normalizeScore(1)).toBe(1); // integer input still allowed, value is float
  });
  it('returns null for non-numeric (incl. NaN)', () => {
    expect(normalizeScore(NaN)).toBeNull();
    expect(normalizeScore('0.9')).toBeNull();
    expect(normalizeScore(null)).toBeNull();
    expect(normalizeScore(undefined)).toBeNull();
  });
});

describe('band', () => {
  // ONE convention: inclusive lower bounds everywhere (spec §12).
  it('bands with inclusive lower bounds', () => {
    expect(band(0.9, { high: 0.8, medium: 0.5 })).toBe('high');
    expect(band(0.8, { high: 0.8, medium: 0.5 })).toBe('high'); // inclusive
    expect(band(0.5, { high: 0.8, medium: 0.5 })).toBe('medium'); // inclusive
    expect(band(0.1, { high: 0.8, medium: 0.5 })).toBe('low');
  });
});

describe('capText', () => {
  it('truncates with ellipsis marker', () => {
    expect(capText('abcdef', 4)).toBe('abcd…');
    expect(capText('abc', 4)).toBe('abc');
  });
});

describe('chunk', () => {
  it('splits into n-sized chunks; rejects n < 1', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
    expect(() => chunk([1], 0)).toThrow(/chunk size/);
  });
});

it('exports the single CONFIDENT_THRESHOLD', () => {
  expect(CONFIDENT_THRESHOLD).toBe(0.6);
});
