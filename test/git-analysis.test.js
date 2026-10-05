// Tests for git-analysis.js — churn and provenance
const gitAnalysis = require('../git-analysis');

describe('git-analysis.js', () => {
  describe('isGitAvailable', () => {
    it('should detect git in this environment', () => {
      // We're running inside a git repo — git must be available
      expect(gitAnalysis.isGitAvailable()).toBe(true);
    });
  });

  describe('getChurn', () => {
    it('should reject missing db handle', () => {
      const result = gitAnalysis.getChurn(null, 1, '__all__', 90, false);
      expect(result.error).toBeDefined();
    });
  });

  describe('getProvenance', () => {
    it('should reject missing db handle', () => {
      const result = gitAnalysis.getProvenance(null, 1, 'someSymbol');
      expect(result.error).toBeDefined();
    });

    // Full provenance test requires an indexed repo — tested in integration tests
  });

  describe('parseBlamePorcelain', () => {
    it('should parse commit blocks with author, date, and summary', () => {
      const output = [
        '5b16d14efac849a1dd091fe538cf6d08be83db3f 75 91 3',
        'author Jane Dev',
        'author-mail <jane@example.com>',
        'author-time 1779515475',
        'author-tz +0800',
        'committer Jane Dev',
        'committer-mail <jane@example.com>',
        'committer-time 1779515475',
        'committer-tz +0800',
        'summary Add user authentication',
        'filename src/search.js',
        '\tfunction f() {',
        '5b16d14efac849a1dd091fe538cf6d08be83db3f 76 92',
        '\t  return 1;',
        '\t}',
      ].join('\n');
      const entries = gitAnalysis.parseBlamePorcelain(output);
      expect(entries).toHaveLength(1);
      expect(entries[0].hash).toBe('5b16d14efac849a1dd091fe538cf6d08be83db3f');
      expect(entries[0].author).toBe('Jane Dev');
      expect(entries[0].date).toBe(new Date(1779515475 * 1000).toISOString());
      expect(entries[0].message).toBe('Add user authentication');
      expect(entries[0].classification).toBe('feature');
      expect(entries[0].touches_symbol).toBe(true);
    });

    it('should collect each distinct commit once and skip content/boundary lines', () => {
      const h1 = 'a'.repeat(40),
        h2 = 'b'.repeat(40);
      const output = [
        `${h1} 10 91 1`,
        'author A',
        'author-time 1700000000',
        'summary Fix null pointer in parser',
        'previous 1234567890abcdef1234567890abcdef12345678 src/x.js',
        'filename src/x.js',
        '\tconst a = 1;',
        `${h1} 11 92`,
        '\tconst b = 2;',
        `${h2} 5 93 4`,
        'author B',
        'author-time 1700000100',
        'summary Various changes',
        'filename src/x.js',
        '\tconst c = 3;',
      ].join('\n');
      const entries = gitAnalysis.parseBlamePorcelain(output);
      expect(entries).toHaveLength(2);
      const byHash = new Map(entries.map((e) => [e.hash, e]));
      expect(byHash.get(h1).classification).toBe('bugfix');
      expect(byHash.get(h2).classification).toBe('unknown');
      expect(entries.every((e) => e.touches_symbol)).toBe(true);
    });

    it('should treat uncommitted boundary blocks (zero hash) as entries', () => {
      const output = [
        `${'0'.repeat(40)} 1 5 1`,
        'author Not Committed Yet',
        'author-mail <not.committed.yet@example.com>',
        'author-time 1700000200',
        'summary Version of #5b16d14e from',
        'filename src/x.js',
        '\twork in progress',
      ].join('\n');
      const entries = gitAnalysis.parseBlamePorcelain(output);
      expect(entries).toHaveLength(1);
      expect(entries[0].hash).toBe('0'.repeat(40));
      expect(entries[0].author).toBe('Not Committed Yet');
    });
  });

  describe('classifyCommit', () => {
    it('should classify creation commits', () => {
      expect(gitAnalysis.classifyCommit('Initial commit')).toBe('creation');
      expect(gitAnalysis.classifyCommit('first commit of project')).toBe('creation');
    });

    it('should classify feature commits', () => {
      expect(gitAnalysis.classifyCommit('Add user authentication')).toBe('feature');
      expect(gitAnalysis.classifyCommit('Implement search endpoint')).toBe('feature');
      expect(gitAnalysis.classifyCommit('Create settings page')).toBe('feature');
    });

    it('should classify bugfix commits', () => {
      expect(gitAnalysis.classifyCommit('Fix null pointer in parser')).toBe('bugfix');
      expect(gitAnalysis.classifyCommit('Hotfix: memory leak in cache')).toBe('bugfix');
      expect(gitAnalysis.classifyCommit('Patch session timeout bug')).toBe('bugfix');
    });

    it('should classify refactor commits', () => {
      expect(gitAnalysis.classifyCommit('Refactor database layer')).toBe('refactor');
      expect(gitAnalysis.classifyCommit('Clean up unused imports')).toBe('refactor');
      expect(gitAnalysis.classifyCommit('Reorganize test files')).toBe('refactor');
    });

    it('should classify performance commits', () => {
      expect(gitAnalysis.classifyCommit('Optimize query performance')).toBe('perf');
      expect(gitAnalysis.classifyCommit('Speed up startup time')).toBe('perf');
    });

    it('should classify rename commits', () => {
      expect(gitAnalysis.classifyCommit('Rename config to settings')).toBe('rename');
      expect(gitAnalysis.classifyCommit('Move utils to shared module')).toBe('rename');
      expect(gitAnalysis.classifyCommit('Relocate auth middleware')).toBe('rename');
    });

    it('should classify revert commits', () => {
      expect(gitAnalysis.classifyCommit('Revert "Add feature X"')).toBe('revert');
      expect(gitAnalysis.classifyCommit('Rollback deployment config')).toBe('revert');
    });

    it('should return unknown for unrecognized messages', () => {
      expect(gitAnalysis.classifyCommit('Various changes')).toBe('unknown');
      expect(gitAnalysis.classifyCommit('WIP')).toBe('unknown');
      expect(gitAnalysis.classifyCommit('')).toBe('unknown');
    });

    it('should handle multi-word detection correctly', () => {
      // 'fix' in 'prefix' should not trigger bugfix
      expect(gitAnalysis.classifyCommit('Update prefix handling')).toBe('unknown');
      // 'perf' inside another word should not trigger
      expect(gitAnalysis.classifyCommit('Superficial change')).toBe('unknown');
    });
  });
});
