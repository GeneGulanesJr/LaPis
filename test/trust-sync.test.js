const { collectChangedSymbols, extractSymbolKey } = require('../src/trust-sync/change-detector');
const { getTrustSyncRepository } = require('../src/trust-sync/symbol-links');
const { evaluateTrustSync, stripOperations, symbolMatchesChange } = require('../src/trust-sync/trust-policy');

const { TRUST_DELTA } = require('../constants');

describe('src/trust-sync trust policy', () => {
  it('evaluates changed and survived links without repository side effects', () => {
    const changedSet = new Set(['changedFunc']),
      result = evaluateTrustSync(
        [
          { memory_id: '1', symbol_id: 'ns::changedFunc', trust_score: 0.8 },
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
    expect(result.operations).toHaveLength(2);
    expect(stripOperations(result).operations).toBeUndefined();
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
