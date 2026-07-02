const {
  isPipedOutputFilter,
  isTargetedSymbolLookup,
  CONFIG_FILENAMES,
  RAW_CODE_DISCOVERY_RE,
  CODE_PATH_HINT_RE,
} = require('../../src/hooks-engine/guardrail-utils');

describe('hooks-engine guardrail-utils: isTargetedSymbolLookup', () => {
  test('allows grep for single quoted symbol', () => {
    expect(isTargetedSymbolLookup('grep -rn "rankObservations" src/')).toBe(true);
  });

  test('allows grep with head pipe', () => {
    expect(isTargetedSymbolLookup('grep -rn "rankObservations" src/ 2>/dev/null | head -20')).toBe(true);
  });

  test('blocks grep with wildcard pattern', () => {
    expect(isTargetedSymbolLookup('grep -rn "context*" src/')).toBe(false);
  });

  test('blocks find commands', () => {
    expect(isTargetedSymbolLookup('find src -name "*.ts"')).toBe(false);
  });

  test('blocks complex pipe chains', () => {
    expect(isTargetedSymbolLookup('grep -rn "rankObservations" src/ | sort | uniq')).toBe(false);
  });

  test('blocks overly short patterns (broad scan)', () => {
    expect(isTargetedSymbolLookup('grep -rn "ctx" src/')).toBe(false);
  });
});

describe('hooks-engine guardrail-utils: isTargetedGrepLookup', () => {
  const { isTargetedGrepLookup, isBroadGlobDiscovery } = require('../../src/hooks-engine/guardrail-utils');

  test('allows targeted Grep symbol', () => {
    expect(isTargetedGrepLookup('rankObservations', '/proj/src')).toBe(true);
  });

  test('blocks regex metachar patterns', () => {
    expect(isTargetedGrepLookup('context.*', '/proj/src')).toBe(false);
  });

  test('allows single-file scope', () => {
    expect(isTargetedGrepLookup('foobar', '/proj/src/foo.ts')).toBe(true);
  });

  test('isBroadGlobDiscovery flags **/*', () => {
    expect(isBroadGlobDiscovery('**/*')).toBe(true);
    expect(isBroadGlobDiscovery('**/*.test.js')).toBe(false);
  });
});

describe('hooks-engine guardrail-utils: isPipedOutputFilter', () => {
  test('allows grep when filtering command output', () => {
    expect(isPipedOutputFilter('npx oxlint 2>&1 | grep -iE "(lowercase|Unused)" || true')).toBe(true);
  });

  test('does not treat direct grep as output filtering', () => {
    expect(isPipedOutputFilter('grep -rn "rankObservations" src/')).toBe(false);
  });
});

describe('hooks-engine guardrail-utils: exported constants', () => {
  test('CONFIG_FILENAMES contains common config files', () => {
    expect(CONFIG_FILENAMES.has('package.json')).toBe(true);
    expect(CONFIG_FILENAMES.has('tsconfig.json')).toBe(true);
    expect(CONFIG_FILENAMES.has('Cargo.toml')).toBe(true);
    expect(CONFIG_FILENAMES.has('random.js')).toBe(false);
  });

  test('RAW_CODE_DISCOVERY_RE detects search commands', () => {
    expect(RAW_CODE_DISCOVERY_RE.test('rg foo src/')).toBe(true);
    expect(RAW_CODE_DISCOVERY_RE.test('grep -rn bar .')).toBe(true);
    expect(RAW_CODE_DISCOVERY_RE.test('find . -name "*.js"')).toBe(true);
    expect(RAW_CODE_DISCOVERY_RE.test('ls -la')).toBe(false);
  });

  test('CODE_PATH_HINT_RE detects code paths and source dirs', () => {
    expect(CODE_PATH_HINT_RE.test('src/foo.ts')).toBe(true);
    expect(CODE_PATH_HINT_RE.test('cd src && ls')).toBe(true);
    expect(CODE_PATH_HINT_RE.test('hello world')).toBe(false);
  });
});
