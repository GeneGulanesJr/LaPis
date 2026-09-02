import { describe, expect, it } from 'vitest';
import {
  fingerprintSymbol,
  jaccardSimilarity,
  lshBands,
  minhashSignature,
  normalizeBody,
  shingle,
  tokenize,
} from '../../src/code-analysis/fingerprint.js';

describe('fingerprint', () => {
  describe('normalizeBody', () => {
    it('removes comments and normalizes whitespace', () => {
      const input = `// comment\nconst x = 1;\n/* block */\nconst y = 2;`,
        result = normalizeBody(input);
      expect(result).not.toContain('//');
      expect(result).not.toContain('/*');
      expect(result.match(/\S+/g).length).toBeGreaterThan(0);
    });

    it('normalizes string literals to placeholder', () => {
      const input = `const msg = "hello world"; const err = 'failed';`,
        result = normalizeBody(input);
      expect(result).not.toContain('hello');
      expect(result).not.toContain('failed');
      expect(result).toContain('__STR__');
    });

    it('normalizes numeric literals', () => {
      const input = `const x = 42; const y = 3.14;`,
        result = normalizeBody(input);
      expect(result).not.toContain('42');
      expect(result).not.toContain('3.14');
      expect(result).toContain('__NUM__');
    });

    it('returns empty string for falsy input', () => {
      expect(normalizeBody('')).toBe('');
      expect(normalizeBody(null)).toBe('');
      expect(normalizeBody(undefined)).toBe('');
    });
  });

  describe('tokenize', () => {
    it('splits normalized body into tokens', () => {
      const tokens = tokenize('const x = __NUM__ ; return x ;');
      expect(tokens.length).toBeGreaterThan(0);
      expect(tokens).toContain('const');
      expect(tokens).toContain('return');
    });
  });

  describe('shingle', () => {
    it('creates shingles of configurable size', () => {
      const tokens = ['a', 'b', 'c', 'd', 'e'],
        shingles = shingle(tokens, 3);
      expect(shingles.length).toBe(3);
      expect(shingles[0]).toBe('a b c');
    });

    it('returns empty for fewer tokens than shingle size', () => {
      const shingles = shingle(['a', 'b'], 4);
      expect(shingles.length).toBe(0);
    });
  });

  describe('minhashSignature', () => {
    it('produces consistent signatures for same input', () => {
      const shingles = ['a b c', 'b c d', 'c d e'],
        sig1 = minhashSignature(shingles, 64),
        sig2 = minhashSignature(shingles, 64);
      expect(sig1).toEqual(sig2);
    });

    it('produces different signatures for different input', () => {
      const sig1 = minhashSignature(['a b c', 'b c d'], 64),
        sig2 = minhashSignature(['x y z', 'y z w'], 64);
      expect(sig1).not.toEqual(sig2);
    });
  });

  describe('jaccardSimilarity', () => {
    it('returns 1 for identical sets', () => {
      const sig1 = minhashSignature(['a b', 'b c', 'c d'], 128),
        sig2 = minhashSignature(['a b', 'b c', 'c d'], 128);
      expect(jaccardSimilarity(sig1, sig2)).toBeCloseTo(1.0, 1);
    });

    it('returns ~0 for completely different sets', () => {
      const sig1 = minhashSignature(['alpha beta', 'beta gamma'], 128),
        sig2 = minhashSignature(['one two', 'two three'], 128);
      expect(jaccardSimilarity(sig1, sig2)).toBeLessThan(0.3);
    });
  });

  describe('lshBands', () => {
    it('produces len/rowsPerBand bands for an evenly divisible signature', () => {
      const sig = Array.from({ length: 128 }, (_, i) => i),
        bands = lshBands(sig, 4);
      expect(bands).toHaveLength(32);
      // Band index is prefixed to each key
      expect(bands[0]).toMatch(/^0:/);
      expect(bands[31]).toMatch(/^31:/);
    });

    it('keeps a trailing partial band instead of dropping remainder elements', () => {
      // 130 elements, 4 rows/band: ceil(130/4) = 33 bands (last band = 2 rows)
      const sig = Array.from({ length: 130 }, (_, i) => i),
        bands = lshBands(sig, 4);
      expect(bands).toHaveLength(33);
      // Last band still covers the trailing two elements (indices 128, 129)
      expect(bands[32]).toBe('32:128|129');
    });

    it('returns empty array when signature is shorter than rowsPerBand', () => {
      expect(lshBands([1, 2, 3], 4)).toEqual([]);
      expect(lshBands([], 4)).toEqual([]);
    });

    it('falls back to default rowsPerBand when given a non-positive value', () => {
      const sig = Array.from({ length: 128 }, (_, i) => i);
      expect(lshBands(sig, 0)).toHaveLength(32);
      expect(lshBands(sig, -1)).toHaveLength(32);
    });

    it('yields colliding band keys for identical signatures', () => {
      const sig1 = minhashSignature(['a b c', 'b c d', 'c d e'], 128),
        sig2 = minhashSignature(['a b c', 'b c d', 'c d e'], 128),
        bands1 = lshBands(sig1, 4),
        bands2 = lshBands(sig2, 4);
      expect(bands1).toEqual(bands2);
      // Identical signatures must collide in every band to be LSH candidates
      expect(bands1.length).toBeGreaterThan(0);
    });
  });

  describe('fingerprintSymbol', () => {
    it('produces a fingerprint object from a symbol row', () => {
      const symbol = {
          name: 'getUserPrefs',
          kind: 'function',
          body_preview: 'function getUserPrefs(id) { return db.query("SELECT * FROM prefs WHERE user_id = " + id); }',
          file_path: 'src/prefs.ts',
          start_line: 10,
        },
        fp = fingerprintSymbol(symbol);
      expect(fp).not.toBeNull();
      expect(fp.signature).toBeDefined();
      expect(fp.signature.length).toBeGreaterThan(0);
      expect(fp.tokenCount).toBeGreaterThan(0);
      expect(fp.symbolName).toBe('getUserPrefs');
      expect(fp.filePath).toBe('src/prefs.ts');
    });

    it('returns null for empty body', () => {
      const fp = fingerprintSymbol({
        name: 'x',
        kind: 'function',
        body_preview: '',
        file_path: 'a.ts',
        start_line: 1,
      });
      expect(fp).toBeNull();
    });
  });
});
