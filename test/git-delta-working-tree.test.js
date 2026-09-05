// Regression tests for issue #282: getGitDelta only diffed baseCommit..HEAD,
// So uncommitted working-tree edits (the normal state while a coding agent
// Works) were invisible to delta mode, and head_commit still advanced —
// Leaving those files stale until a full reindex.
const { execFileSync } = require('node:child_process'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  { getGitDelta } = require('../src/code-index/incremental-indexer');

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-git-delta-')),
    git = (...args) => execFileSync('git', args, { cwd: repo });
  git('init');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  fs.writeFileSync(path.join(repo, 'a.js'), 'function alpha() {\n  return 1;\n}\n');
  fs.writeFileSync(path.join(repo, 'b.js'), 'function beta() {\n  return 2;\n}\n');
  git('add', '-A');
  git('commit', '-m', 'init');
  return { repo, git, base: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim() };
}

describe('getGitDelta working-tree coverage (#282)', () => {
  it('returns null when HEAD has not moved (delta mode not applicable)', () => {
    const { repo, base } = makeRepo();
    try {
      expect(getGitDelta(repo, base)).toBeNull();
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('includes uncommitted modifications and untracked files, not just the committed range', () => {
    const { repo, git, base } = makeRepo();
    try {
      // Commit a change to a.js only…
      fs.writeFileSync(path.join(repo, 'a.js'), 'function alpha() {\n  return 10;\n}\n');
      git('add', 'a.js');
      git('commit', '-m', 'touch a');
      // …while b.js has uncommitted edits and c.js is brand-new untracked work.
      fs.writeFileSync(path.join(repo, 'b.js'), 'function beta() {\n  return 3;\n}\n');
      fs.writeFileSync(path.join(repo, 'c.js'), 'function gamma() {\n  return 4;\n}\n');

      const delta = getGitDelta(repo, base);

      expect(delta).not.toBeNull();
      const changed = delta.changed.map((p) => path.basename(p));
      expect(changed).toContain('a.js');
      expect(changed).toContain('b.js');
      expect(changed).toContain('c.js');
      expect(delta.currentHead).not.toBe(base);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('reports uncommitted working-tree deletions', () => {
    const { repo, git, base } = makeRepo();
    try {
      fs.rmSync(path.join(repo, 'b.js'));
      fs.writeFileSync(path.join(repo, 'a.js'), 'function alpha() {\n  return 20;\n}\n');
      git('add', 'a.js');
      git('commit', '-m', 'touch a again');

      const delta = getGitDelta(repo, base);

      expect(delta).not.toBeNull();
      expect(delta.deleted.map((p) => path.basename(p))).toContain('b.js');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('respects .gitignore when collecting untracked files', () => {
    const { repo, git, base } = makeRepo();
    try {
      fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.js\n');
      fs.writeFileSync(path.join(repo, 'ignored.js'), 'function noise() {}\n');
      git('add', '.gitignore');
      git('commit', '-m', 'gitignore');

      const delta = getGitDelta(repo, base);

      expect(delta).not.toBeNull();
      expect(delta.changed.map((p) => path.basename(p))).not.toContain('ignored.js');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
