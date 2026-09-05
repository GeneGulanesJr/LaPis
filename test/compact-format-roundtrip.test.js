// Regression tests for issue #283: the compact wire format's decode lost
// Data — numeric-looking strings were coerced ('1.10' → 1.1), '' became
// Null, any '@N'-leading value in an interned column was prefix-expanded,
// And per-row object/array cells were String()-destroyed. The encode side
// Now emits type markers and decode restores them; lists whose columns
// Can't be represented losslessly stay as JSON.
const wireFormat = require('../src/platform/protocol/compact-format');

const { _encodeList, _decodeList, compactResponse, expandResponse, autoFormat, _isCompactable } = wireFormat;

function roundTrip(rows, opts) {
  return _decodeList(_encodeList(rows, opts));
}

describe('compact-format lossless round-trip (#283)', () => {
  it('preserves numeric-looking strings instead of coercing them', () => {
    const rows = [{ v: '1.10' }, { v: '42' }, { v: '0x1f' }, { v: 'Infinity' }, { v: '1e5' }, { v: ' 42 ' }],
      decoded = roundTrip(rows);
    expect(decoded.map((r) => r.v)).toEqual(['1.10', '42', '0x1f', 'Infinity', '1e5', ' 42 ']);
  });

  it('preserves empty strings instead of nulling them', () => {
    const decoded = roundTrip([{ note: '' }, { note: 'x' }, { note: null }]);
    expect(decoded[0].note).toBe('');
    expect(decoded[1].note).toBe('x');
    expect(decoded[2].note).toBeNull();
  });

  it('round-trips booleans', () => {
    const decoded = roundTrip([
      { ok: true, stale: false },
      { ok: false, stale: true },
    ]);
    expect(decoded[0].ok).toBe(true);
    expect(decoded[0].stale).toBe(false);
    expect(decoded[1].ok).toBe(false);
    expect(decoded[1].stale).toBe(true);
  });

  it('keeps plain numbers and strings intact', () => {
    const decoded = roundTrip([
      { n: 5, r: 0.5, z: 0, neg: -3, big: 1e21, s: 'plain', p: 'src/a/b.js' },
      { n: 10, r: 0.8, z: 0, neg: -4, big: 2e21, s: 'names', p: 'src/c/d.js' },
    ]);
    expect(decoded[0]).toEqual({ n: 5, r: 0.5, z: 0, neg: -3, big: 1e21, s: 'plain', p: 'src/a/b.js' });
    expect(decoded[1]).toEqual({ n: 10, r: 0.8, z: 0, neg: -4, big: 2e21, s: 'names', p: 'src/c/d.js' });
  });

  it('protects literal strings that start with the markers', () => {
    const decoded = roundTrip([{ v: "'quoted" }, { v: '!important' }, { v: '!true' }, { v: '' }]);
    expect(decoded.map((r) => r.v)).toEqual(["'quoted", '!important', '!true', '']);
  });

  it('does not prefix-expand literal @N values in interned columns', () => {
    const rows = [
        { file: 'src/utils/a.js' },
        { file: 'src/utils/b.js' },
        { file: 'src/utils/@0notes' },
        { file: 'src/utils/@0/x' },
      ],
      compact = _encodeList(rows),
      decoded = _decodeList(compact);
    // Interning must still apply to genuine prefix matches…
    expect(compact._prefixes).toBeDefined();
    expect(decoded[0].file).toBe('src/utils/a.js');
    // …but literal '@'-leading names must survive verbatim.
    expect(decoded[2].file).toBe('src/utils/@0notes');
    expect(decoded[3].file).toBe('src/utils/@0/x');
  });

  it('leaves lists with differing per-row object/array cells as JSON (compactResponse)', () => {
    const data = {
      total: 2,
      affected_files: [
        { path: 'src/a.ts', signals: ['call'] },
        { path: 'src/b.ts', signals: ['import', 'cochange'] },
      ],
    };
    const compacted = compactResponse(data);
    // Not compacted — the array key survives structurally intact.
    expect(compacted.affected_files).toBe(data.affected_files);
    expect(expandResponse(compacted)).toEqual(data);
    expect(autoFormat(data)).toBe('json');
  });

  it('still compacts and restores uniform object columns (hoisted whole)', () => {
    const data = {
      affected_files: [
        { path: 'src/a.ts', meta: { repo: 'r1' } },
        { path: 'src/b.ts', meta: { repo: 'r1' } },
      ],
    };
    const compacted = compactResponse(data);
    expect(compacted.affected_files._header).toEqual(['path']);
    expect(expandResponse(compacted)).toEqual(data);
  });

  it('_isCompactable accepts primitive columns and rejects mixed non-primitive ones', () => {
    expect(
      _isCompactable([
        { a: 1, b: 'x' },
        { a: 2, b: 'y' },
      ]),
    ).toBe(true);
    expect(_isCompactable([{ a: [1] }, { a: [2] }])).toBe(false);
    expect(
      _isCompactable([
        { a: 1, u: { k: 1 } },
        { a: 2, u: { k: 1 } },
      ]),
    ).toBe(true);
  });

  it('keeps legacy decode behavior for unmarked cells', () => {
    // Hand-written / pre-marker compact data must decode as before.
    const decoded = _decodeList({ _header: ['a', 'b', 'c'], _rows: ['42|hello|'] });
    expect(decoded[0].a).toBe(42);
    expect(decoded[0].b).toBe('hello');
    expect(decoded[0].c).toBeNull();
  });
});
