// Repo guard: non-codebase paths must never be registered or indexed.
// Incident: home-dir + ~/Documents rows caused an infinite stale-check →
// Reindex loop (a home-dir index can never go fresh).
const fs = require('fs'),
  os = require('os'),
  path = require('path'),
  { isIndexableRepoPath, assertIndexableRepoPath, USER_CONTENT_DIRS } = require('../src/code-index/repo-guard');

describe('repo-guard: isIndexableRepoPath', () => {
  it('refuses the home directory unconditionally', () => {
    const r = isIndexableRepoPath(os.homedir());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/home directory/);
  });

  it('refuses standard user content dirs even when they contain a stray .git', () => {
    const docs = path.join(os.homedir(), 'Documents'),
      gitDir = path.join(docs, '.git');
    let created = false;
    if (!fs.existsSync(docs)) {
      fs.mkdirSync(docs, { recursive: true });
    }
    if (!fs.existsSync(gitDir)) {
      fs.mkdirSync(gitDir);
      created = true;
    }
    try {
      const r = isIndexableRepoPath(docs);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/user content directory/);
    } finally {
      if (created) {
        fs.rmdirSync(gitDir);
      }
    }
  });

  it('refuses the filesystem root and unresolvable input', () => {
    expect(isIndexableRepoPath('/').ok).toBe(false);
    expect(isIndexableRepoPath('').ok).toBe(false);
    expect(isIndexableRepoPath(null).ok).toBe(false);
  });

  it('allows a real git repo (this checkout) via the .git fast path', () => {
    expect(isIndexableRepoPath(process.cwd()).ok).toBe(true);
  });

  it('refuses plain non-git dirs unless LAPIS_INDEX_ALLOW_NON_GIT=1', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-guard-'));
    try {
      delete process.env.LAPIS_INDEX_ALLOW_NON_GIT;
      const refused = isIndexableRepoPath(tmp);
      expect(refused.ok).toBe(false);
      expect(refused.reason).toMatch(/LAPIS_INDEX_ALLOW_NON_GIT/);

      process.env.LAPIS_INDEX_ALLOW_NON_GIT = '1';
      expect(isIndexableRepoPath(tmp).ok).toBe(true);
    } finally {
      delete process.env.LAPIS_INDEX_ALLOW_NON_GIT;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('USER_CONTENT_DIRS covers the usual suspects', () => {
    for (const dir of ['Documents', 'Downloads', 'Desktop', 'Pictures']) {
      expect(USER_CONTENT_DIRS.has(dir)).toBe(true);
    }
  });
});

describe('repo-guard: assertIndexableRepoPath', () => {
  it('throws EREPOGUARD for the home directory', () => {
    expect(() => assertIndexableRepoPath(os.homedir())).toThrow(/repo guard/);
    try {
      assertIndexableRepoPath(os.homedir());
    } catch (e) {
      expect(e.code).toBe('EREPOGUARD');
    }
  });
});
