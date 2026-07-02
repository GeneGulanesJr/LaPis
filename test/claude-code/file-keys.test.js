const { fileKey, addNormalized, uniqueEditedPaths } = require('../../src/claude-code/file-keys');

describe('claude-code file-keys: shared normalization', () => {
  test('fileKey lowercases and splits the basename', () => {
    expect(fileKey('src/Foo.JS')).toEqual({ lower: 'src/foo.js', base: 'foo.js' });
    expect(fileKey('SRC/Bar.TS')).toEqual({ lower: 'src/bar.ts', base: 'bar.ts' });
  });

  test('fileKey handles Windows-style separators', () => {
    expect(fileKey('src\\sub\\Foo.JS')).toEqual({ lower: 'src\\sub\\foo.js', base: 'foo.js' });
  });

  test('fileKey rejects non-strings', () => {
    expect(fileKey(undefined)).toBeNull();
    expect(fileKey(null)).toBeNull();
    expect(fileKey('')).toBeNull();
    expect(fileKey(42)).toBeNull();
  });

  test('addNormalized appends both the lowercased path and basename, deduped', () => {
    const arr = [];
    addNormalized(arr, 'src/Foo.JS');
    expect(arr).toEqual(['src/foo.js', 'foo.js']);
    // Idempotent: same path doesn't double-up.
    addNormalized(arr, 'src/Foo.js');
    expect(arr).toEqual(['src/foo.js', 'foo.js']);
    // A second, distinct file adds both its forms.
    addNormalized(arr, 'lib/Bar.TS');
    expect(arr).toEqual(['src/foo.js', 'foo.js', 'lib/bar.ts', 'bar.ts']);
  });

  test('addNormalized ignores empty input', () => {
    const arr = ['x'];
    addNormalized(arr, '');
    expect(arr).toEqual(['x']);
  });

  test('uniqueEditedPaths collapses full path + basename to one entry per file', () => {
    expect(uniqueEditedPaths(['/proj/a.js', 'a.js', '/proj/b.ts', 'b.ts'])).toEqual([
      '/proj/a.js',
      '/proj/b.ts',
    ]);
  });

  test('uniqueEditedPaths accepts a Set and ignores empty entries', () => {
    expect(uniqueEditedPaths(new Set(['/x/foo.js', 'foo.js', '']))).toEqual(['/x/foo.js']);
  });
});
