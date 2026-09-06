const { collectChangedSymbols, extractSymbolKey } = require('../src/trust-sync/change-detector'),
  { getTrustSyncRepository } = require('../src/trust-sync/symbol-links'),
  { evaluateTrustSync, stripOperations, symbolMatchesChange } = require('../src/trust-sync/trust-policy'),
  { TRUST_DELTA } = require('../constants');

describe('src/trust-sync trust policy', () => {
  it('evaluates changed and survived links without repository side effects', () => {
    const changedSet = new Set(['changedFunc']),
      result = evaluateTrustSync(
        [
          // Boundary match inside a namespaced id — ambiguous (the same
          // unqualified name usually exists unchanged elsewhere), so it takes
          // the reduced fuzzy penalty (#300).
          { memory_id: '1', symbol_id: 'ns::changedFunc', trust_score: 0.8 },
          // Exact id match — certain change, full penalty.
          { memory_id: '4', symbol_id: 'changedFunc', trust_score: 0.8 },
          { memory_id: '2', symbol_id: 'stableFunc', trust_score: 0.5 },
          { memory_id: '3', symbol_id: 'maxedFunc', trust_score: TRUST_DELTA.MAX_SURVIVED },
        ],
        changedSet,
      );

    expect(result.adjusted).toEqual([
      {
        memory_id: '1',
        symbol_id: 'ns::changedFunc',
        old_trust: 0.8,
        new_trust: 0.65,
      },
      {
        memory_id: '4',
        symbol_id: 'changedFunc',
        old_trust: 0.8,
        new_trust: 0.5,
      },
    ]);
    expect(result.survived).toEqual([
      {
        memory_id: '2',
        symbol_id: 'stableFunc',
        old_trust: 0.5,
        new_trust: 0.55,
      },
    ]);
    expect(result.unchanged).toEqual([{ memory_id: '3', symbol_id: 'maxedFunc' }]);
    expect(result.operations).toHaveLength(3);
    expect(result.operations[0].reason).toBe('symbol_changed_fuzzy');
    expect(result.operations[1].reason).toBe('symbol_changed');
    expect(stripOperations(result).operations).toBeUndefined();
  });

  it('path-aware links only react when their own file changed (#300)', () => {
    const changedSet = new Set(['handler']),
      changedPaths = ['/repo/src/handler.ts'],
      links = [
        // Linked to handler.ts (the changed file) -> penalized.
        { memory_id: '1', symbol_id: 'handler', trust_score: 0.8, symbol_path: '/repo/src/handler.ts' },
        // Same NAME, but anchored to an untouched file -> NOT penalized.
        { memory_id: '2', symbol_id: 'handler', trust_score: 0.8, symbol_path: '/repo/src/other.ts' },
        // Relative recorded path resolving into the changed file -> penalized.
        { memory_id: '3', symbol_id: 'handler', trust_score: 0.8, symbol_path: 'src/handler.ts' },
        // No recorded path -> legacy name-based behavior (fuzzy half).
        { memory_id: '4', symbol_id: 'handler', trust_score: 0.8 },
      ],
      result = evaluateTrustSync(links, changedSet, changedPaths, '/repo');

    const byMemory = Object.fromEntries(result.adjusted.map((a) => [a.memory_id, a]));
    expect(byMemory['1'].new_trust).toBe(0.5); // full penalty
    expect(byMemory['3'].new_trust).toBe(0.5); // full penalty
    expect(result.survived.map((s) => s.memory_id)).toContain('2');
    expect(result.adjusted.map((a) => a.memory_id)).not.toContain('2');
    // Legacy path-less link: boundary match inside 'handler' is exact here,
    // so full penalty applies.
    expect(byMemory['4'].new_trust).toBe(0.5);
  });

  it('path-aware links earn survived recovery when their file is untouched', () => {
    const changedSet = new Set(['handler']),
      changedPaths = ['/repo/src/handler.ts'],
      links = [{ memory_id: '9', symbol_id: 'handler', trust_score: 0.5, symbol_path: '/repo/src/other.ts' }],
      result = evaluateTrustSync(links, changedSet, changedPaths, '/repo');
    expect(result.survived).toHaveLength(1);
    expect(result.survived[0].new_trust).toBe(0.55); // SURVIVED_UNCHANGED credit
    expect(result.adjusted).toHaveLength(0);
  });

  it('matches changed symbols only on symbol boundaries', () => {
    expect(symbolMatchesChange('pkg::bar', 'bar')).toBe(true);
    expect(symbolMatchesChange('pkg.Class.bar', 'bar')).toBe(true);
    expect(symbolMatchesChange('pkg::Class.bar', 'Class.bar')).toBe(true);
    expect(symbolMatchesChange('pkg::foobar', 'bar')).toBe(false);
    expect(symbolMatchesChange('pkg::barista', 'bar')).toBe(false);
  });
});

describe('src/trust-sync change detector', () => {
  it('collects changed symbols from all supported git delta shapes', () => {
    const changed = collectChangedSymbols({
      added: ['addedFunc'],
      modified: [{ symbol_id: 'modifiedFunc' }],
      removed: [{ name: 'removedFunc' }],
      changed: [null, { ignored: true }],
    });

    expect([...changed].sort()).toEqual(['addedFunc', 'modifiedFunc', 'removedFunc']);
  });

  it('does not fall through from falsy symbol_id values to name', () => {
    expect(extractSymbolKey({ symbol_id: 0, name: 'fallback' })).toBe(0);
    expect(extractSymbolKey({ symbol_id: '', name: 'fallback' })).toBe('');
    expect([
      ...collectChangedSymbols([
        { symbol_id: 0, name: 'fallback' },
        { symbol_id: '', name: 'skip' },
      ]),
    ]).toEqual(['0']);
  });
});

describe('src/trust-sync repository adapter', () => {
  it('validates required legacy repository methods before returning an adapter', () => {
    expect(() =>
      getTrustSyncRepository({ getAnchoredLinks: vi.fn() }, ['getAnchoredLinks', 'updateLinkTrust']),
    ).toThrow('updateLinkTrust');
  });
});
