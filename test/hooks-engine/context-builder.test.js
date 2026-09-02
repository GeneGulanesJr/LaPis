const {
  buildContextBlock,
  buildSourceLookupGuidance,
  summarizeMemoryContent,
  extractFilePaths,
  capInjectedContext,
} = require('../../src/hooks-engine/context-builder');
const {
    appendPreflightBlock,
    appendCodingContextBlock,
    chooseCodingContextTarget,
    unwrapAnalysisData,
  } = require('../../src/hooks-engine/preflight-assembly'),
  baseBag = {
    promptQuery: null,
    currentProject: 'TestProject',
    projectDir: process.cwd(),
    cwdRepo: null,
    isStale: false,
    isNewProject: false,
    observations: [],
    effectiveObservations: [],
    personal: [],
    stats: { total_memories: 42, total_personal: 1 },
    effectiveStats: { total_memories: 42, total_personal: 1 },
    topic: null,
    crossProjectSuggestions: [],
    cwd: process.cwd(),
  };

describe('hooks-engine context-builder: summarizeMemoryContent', () => {
  test('normalizes What/Why/Where priority lines', () => {
    const out = summarizeMemoryContent('**What**: Use SQLite\n**Why**: No deps\n**Where**: src/db.js');
    expect(out).toContain('What: Use SQLite');
    expect(out).toContain('Why: No deps');
    expect(out).toContain('Where: src/db.js');
  });

  test('returns null for non-string', () => {
    expect(summarizeMemoryContent(undefined)).toBeNull();
    expect(summarizeMemoryContent(123)).toBeNull();
  });
});

describe('hooks-engine context-builder: extractFilePaths', () => {
  test('extracts, dedupes, caps at 3', () => {
    const out = extractFilePaths('see src/a.js and src/a.js and lib/b.ts and test/c.py and docs/d.md and e.go');
    expect(out).toContain('src/a.js');
    expect(new Set(out).size).toBe(out.length);
    expect(out.length).toBeLessThanOrEqual(3);
  });

  test('ignores short strings without slashes', () => {
    expect(extractFilePaths('see foo.js here')).toEqual([]);
  });
});

describe('hooks-engine context-builder: capInjectedContext', () => {
  test('preserves content under limit', () => {
    const short = 'a'.repeat(100);
    expect(capInjectedContext(short)).toBe(short);
  });

  test('truncates over limit with ellipsis', () => {
    const long = 'a'.repeat(5000),
      out = capInjectedContext(long);
    expect(out.length).toBeLessThan(long.length);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('hooks-engine context-builder: buildContextBlock', () => {
  test('produces Memory Context heading + project line (uncapped lines array)', () => {
    const lines = buildContextBlock(baseBag),
    content = (() => {

      expect(Array.isArray(lines)).toBe(true);
      
  return (lines.join('\n'));
})();expect(content).toContain('## Memory Context (auto-loaded)');
    expect(content).toContain('Project: **TestProject**');
    expect(content).toContain('### Project Context');
    expect(content).toContain('not indexed for this project');
  });

  test('includes code index details when cwdRepo provided', () => {
    const lines = buildContextBlock({
        ...baseBag,
        cwdRepo: { name: 'TestRepo', path: process.cwd(), file_count: 10, symbol_count: 200, indexed_at: 'x' },
      }),
      content = lines.join('\n');
    expect(content).toContain('Code index: `TestRepo`');
    expect(content).toContain('10 files');
  });

  test('shows stale label when not suppressed', () => {
    const lines = buildContextBlock({
      ...baseBag,
      cwdRepo: { name: 'TestRepo', path: process.cwd(), file_count: 10, symbol_count: 200, indexed_at: 'x' },
      isStale: true,
    });
    expect(lines.join('\n')).toContain('(stale)');
  });

  test('suppresses stale label when effectiveObservations present', () => {
    const lines = buildContextBlock({
      ...baseBag,
      promptQuery: 'where is x',
      cwdRepo: { name: 'TestRepo', path: process.cwd(), file_count: 10, symbol_count: 200, indexed_at: 'x' },
      isStale: true,
      effectiveObservations: [{ type: 'decision', title: 'm', trust_score: 0.9 }],
    });
    expect(lines.join('\n')).not.toContain('(stale)');
  });

  test('injects one memory for policy prompts, two for navigation', () => {
    const obs = [
        { type: 'decision', title: 'MatchedDecAlpha', trust_score: 0.95, content: '**What**: x\n**Where**: src/a.js' },
        { type: 'bugfix', title: 'MatchedFixBeta', trust_score: 0.95, content: '**What**: y\n**Where**: src/b.js' },
      ],
      policy = buildContextBlock({
        ...baseBag,
        promptQuery: 'what should the agent do',
        effectiveObservations: obs,
      }),
    nav = (() => {

      expect(policy.join('\n')).toContain('MatchedDecAlpha');
      expect(policy.join('\n')).not.toContain('MatchedFixBeta');
  
      
  return (buildContextBlock({ ...baseBag, promptQuery: 'where is the module path', effectiveObservations: obs }));
})();expect(nav.join('\n')).toContain('MatchedDecAlpha');
    expect(nav.join('\n')).toContain('MatchedFixBeta');
  });
});

describe('hooks-engine context-builder: buildSourceLookupGuidance', () => {
  test('returns guidance when repo matches', () => {
    const out = buildSourceLookupGuidance(
      [{ name: 'Repo', path: process.cwd(), file_count: 1, symbol_count: 1, indexed_at: 'x' }],
      process.cwd(),
      'repo',
    );
    expect(out).toContain('## Code Lookup Guidance');
    expect(out).toContain('rg -n "<symbol>" <narrow-path>');
  });

  test('returns null when no repo matches', () => {
    expect(buildSourceLookupGuidance([], process.cwd(), 'x')).toBeNull();
  });
});

describe('hooks-engine preflight-assembly', () => {
  test('appendPreflightBlock renders warnings + related files + action', () => {
    const lines = [],
    content = (() => {

      appendPreflightBlock(lines, {
        likely_existing_code: [{ symbol: 'saveUser', file: 'src/users.js', line: 4, kind: 'function' }],
        duplicate_warnings: [{ symbol: 'dup', file: 'src/d.js' }],
        related_files: ['src/users.js'],
        risk: 'high',
        recommended_action: 'Review first.',
      });
      
  return (lines.join('\n'));
})();expect(content).toContain('### Preflight — Before Coding');
    expect(content).toContain('Duplicate risk: high');
    expect(content).toContain('`dup` in `src/d.js`');
    expect(content).toContain('Related files: `src/users.js`');
    expect(content).toContain('→ Review first.');
  });

  test('appendPreflightBlock renders related code when no warnings', () => {
    const lines = [];
    appendPreflightBlock(lines, {
      likely_existing_code: [{ symbol: 'saveUser', file: 'src/users.js', line: 4, kind: 'function' }],
      duplicate_warnings: [],
      risk: 'medium',
    });
    expect(lines.join('\n')).toContain('Risk: **medium**');
    expect(lines.join('\n')).toContain('`saveUser` (function)');
  });

  test('appendPreflightBlock skips when nothing notable', () => {
    const lines = [];
    appendPreflightBlock(lines, { likely_existing_code: [], duplicate_warnings: [], risk: 'low' });
    expect(lines).toEqual([]);
  });

  test('appendCodingContextBlock renders target + tests', () => {
    const lines = [],
    content = (() => {

      appendCodingContextBlock(lines, {
        target: { symbol: 'saveUser', file: 'src/users.js' },
        summary: { risk: 'medium', review_bar: 'normal-plus', affected_files: 2 },
        related_files: ['src/users.js'],
        likely_tests: [{ file: 'test/users.test.js' }],
      });
      
  return (lines.join('\n'));
})();expect(content).toContain('### Coding Context — Before Editing');
    expect(content).toContain('Target: `saveUser`');
    expect(content).toContain('Likely tests: `test/users.test.js`');
  });

  test('chooseCodingContextTarget prefers prompt file paths', () => {
    expect(chooseCodingContextTarget('edit src/deep/module.js', {})).toEqual({ file: 'src/deep/module.js' });
  });

  test('chooseCodingContextTarget falls back to explicit symbol', () => {
    expect(chooseCodingContextTarget('fix `saveUser` validation', {})).toEqual({ symbol: 'saveUser' });
  });

  test('chooseCodingContextTarget falls back to preflight code', () => {
    expect(
      chooseCodingContextTarget('fix the function', { likely_existing_code: [{ symbol: 'saveUser', file: 'a.js' }] }),
    ).toEqual({ symbol: 'saveUser', file: 'a.js' });
  });

  test('chooseCodingContextTarget returns null when nothing found', () => {
    expect(chooseCodingContextTarget('hello', {})).toBeNull();
  });

  test('unwrapAnalysisData unwraps .data envelope', () => {
    expect(unwrapAnalysisData({ data: { x: 1 } })).toEqual({ x: 1 });
    expect(unwrapAnalysisData({ x: 1 })).toEqual({ x: 1 });
  });
});
