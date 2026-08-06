const { isPipedOutputFilter, isTargetedSymbolLookup } = require('../extensions/memory-layer/hooks/guardrail-utils');

describe('tool-guardrails: isTargetedSymbolLookup', () => {
  test('allows grep for single quoted symbol', () => {
    expect(isTargetedSymbolLookup('grep -rn "rankObservations" src/')).toBe(true);
  });

  test('allows grep with head pipe', () => {
    expect(isTargetedSymbolLookup('grep -rn "rankObservations" src/ 2>/dev/null | head -20')).toBe(true);
  });

  test('allows rg for single quoted symbol', () => {
    expect(isTargetedSymbolLookup('rg "typeBoost" src/')).toBe(true);
  });

  test('allows single-quoted patterns', () => {
    expect(isTargetedSymbolLookup("grep -rn 'rankObservations' src/")).toBe(true);
  });

  test('blocks grep with wildcard pattern', () => {
    expect(isTargetedSymbolLookup('grep -rn "context*" src/')).toBe(false);
  });

  test('blocks grep with regex alternation', () => {
    expect(isTargetedSymbolLookup('grep -rn "context|search" src/')).toBe(false);
  });

  test('blocks overly short patterns (broad scan)', () => {
    expect(isTargetedSymbolLookup('grep -rn "ctx" src/')).toBe(false);
  });

  test('blocks find commands', () => {
    expect(isTargetedSymbolLookup('find src -name "*.ts"')).toBe(false);
  });

  test('blocks complex pipe chains', () => {
    expect(isTargetedSymbolLookup('grep -rn "rankObservations" src/ | sort | uniq')).toBe(false);
  });

  test('allows grep with --include flag', () => {
    expect(isTargetedSymbolLookup('grep -rn --include="*.js" "rankObservations" src/')).toBe(true);
  });

  test('allows grep with --include flag after the symbol', () => {
    expect(
      isTargetedSymbolLookup('grep -rn "rankObservations" /home/user/project/ --include="*.ts" --include="*.js" -l'),
    ).toBe(true);
  });

  test('allows structural grep inside a single source file', () => {
    expect(isTargetedSymbolLookup("grep -n 'return {' /home/user/project/src/memory-domain/context.js")).toBe(true);
  });

  test('allows structural rg inside a single source file', () => {
    expect(
      isTargetedSymbolLookup('rg -n "return\\\\s*\\\\{|stats" /home/user/project/src/memory-domain/context.js'),
    ).toBe(true);
  });

  test('blocks empty or missing pattern', () => {
    expect(isTargetedSymbolLookup('grep -rn src/')).toBe(false);
  });

  test('allows grep with stderr redirect', () => {
    expect(isTargetedSymbolLookup('grep -rn "rankObservations" src/ 2>/dev/null')).toBe(true);
  });

  test('allows grep with tail pipe', () => {
    expect(isTargetedSymbolLookup('grep -rn "rankObservations" src/ | tail -5')).toBe(true);
  });

  test('blocks grep with character class', () => {
    expect(isTargetedSymbolLookup('grep -rn "[Rr]ank" src/')).toBe(false);
  });

  test('allows longer camelCase symbol', () => {
    expect(isTargetedSymbolLookup('grep -rn "buildCategorySummary" src/')).toBe(true);
  });
});

describe('tool-guardrails: isPipedOutputFilter', () => {
  test('allows grep when filtering command output', () => {
    expect(isPipedOutputFilter('npx oxlint 2>&1 | grep -iE "(lowercase|Unused)" || true')).toBe(true);
  });

  test('does not treat repo discovery pipelines as output filtering', () => {
    expect(isPipedOutputFilter("find . -maxdepth 3 -type f | grep -E 'memory|context' | head -200")).toBe(false);
  });

  test('does not treat direct grep as output filtering', () => {
    expect(isPipedOutputFilter('grep -rn "rankObservations" src/')).toBe(false);
  });
});
