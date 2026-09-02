const {
  isPipedOutputFilter,
  isTargetedSymbolLookup,
  isTargetedGrepLookup,
  isSpecificCodeFilePath,
  isBroadGlob,
  CONFIG_FILENAMES,
  CODE_EXTENSIONS,
  RAW_CODE_DISCOVERY_RE,
  CODE_PATH_HINT_RE,
} = require('../../src/hooks-engine/guardrail-utils');

describe('hooks-engine guardrail-utils: CODE_EXTENSIONS (single source of truth)', () => {
  test('classifies every extension in the shared list as a code file', () => {
    for (const ext of CODE_EXTENSIONS) {
      expect(isSpecificCodeFilePath(`src/thing.${ext}`)).toBe(true);
    }
  });

  test('covers the extensions the bridge harvest regex previously lacked', () => {
    // #230: the harvest CODE_PATH_RE was missing these vs SPECIFIC_CODE_FILE_RE.
    for (const ext of [
      'java',
      'kt',
      'rb',
      'c',
      'h',
      'cpp',
      'hpp',
      'cs',
      'scala',
      'swift',
      'php',
      'cts',
      'mts',
      'pyi',
    ]) {
      expect(CODE_EXTENSIONS).toContain(ext);
    }
  });
});

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

describe('hooks-engine guardrail-utils: isPipedOutputFilter', () => {
  test('allows grep when filtering command output', () => {
    expect(isPipedOutputFilter('npx oxlint 2>&1 | grep -iE "(lowercase|Unused)" || true')).toBe(true);
  });

  test('does not treat direct grep as output filtering', () => {
    expect(isPipedOutputFilter('grep -rn "rankObservations" src/')).toBe(false);
  });
});

describe('hooks-engine guardrail-utils: isTargetedGrepLookup (Grep tool)', () => {
  test('allows a plain single-symbol pattern', () => {
    expect(isTargetedGrepLookup({ pattern: 'rankObservations' })).toBe(true);
  });

  test('blocks a regex/structural pattern', () => {
    expect(isTargetedGrepLookup({ pattern: 'function\\s+\\w+' })).toBe(false);
    expect(isTargetedGrepLookup({ pattern: 'foo|bar' })).toBe(false);
    expect(isTargetedGrepLookup({ pattern: 'ctx' })).toBe(false); // Too short
  });

  test('blocks a whitespace phrase (broad text search)', () => {
    expect(isTargetedGrepLookup({ pattern: 'error handling' })).toBe(false);
  });

  test('allows any pattern when scoped to a single code file', () => {
    expect(isTargetedGrepLookup({ pattern: 'foo|bar', path: 'src/handlers/pre-tool-use.js' })).toBe(true);
  });

  test('does not treat a directory scope as single-file', () => {
    expect(isTargetedGrepLookup({ pattern: 'a.*b', path: 'src/' })).toBe(false);
  });
});

describe('hooks-engine guardrail-utils: isSpecificCodeFilePath', () => {
  test('true for a concrete code file', () => {
    expect(isSpecificCodeFilePath('src/db.js')).toBe(true);
    expect(isSpecificCodeFilePath('lib/main.py')).toBe(true);
  });
  test('false for globs and directories', () => {
    expect(isSpecificCodeFilePath('src/**/*.ts')).toBe(false);
    expect(isSpecificCodeFilePath('src/')).toBe(false);
    expect(isSpecificCodeFilePath('README.md')).toBe(false);
  });
});

describe('hooks-engine guardrail-utils: isBroadGlob', () => {
  test('true for bare recursive discovery', () => {
    expect(isBroadGlob('**/*')).toBe(true);
    expect(isBroadGlob('**')).toBe(true);
    expect(isBroadGlob('**/*.ts')).toBe(true);
  });
  test('false for scoped globs', () => {
    expect(isBroadGlob('src/**/*.ts')).toBe(false);
    expect(isBroadGlob('**/handlers/*.js')).toBe(false);
    expect(isBroadGlob('package.json')).toBe(false);
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
