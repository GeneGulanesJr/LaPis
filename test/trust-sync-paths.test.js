const { execFileSync } = require('child_process'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  {
    resolveIndexedFilePaths,
    parseGitDiffNameStatus,
    detectChangedSymbols,
  } = require('../src/trust-sync/change-detector');

describe('resolveIndexedFilePaths', () => {
  it('maps git-relative paths to absolute indexed paths', () => {
    const repo = path.join(os.tmpdir(), 'lapis-trust-paths'),
      file = path.join(repo, 'src', 'app.js'),
      resolved = (() => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'export const app = 1;\n');

        return resolveIndexedFilePaths(repo, ['src/app.js']);
      })();
    expect(resolved).toContain(file);
  });

  it('includes realpath variants for symlinked repo roots', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-trust-real-')),
      link = path.join(os.tmpdir(), `lapis-trust-link-${Date.now()}`);
    try {
      fs.symlinkSync(repo, link, 'junction'); // A junction needs no admin rights on Windows; ignored elsewhere
      const file = path.join(repo, 'lib.js'),
        // resolveIndexedFilePaths fully resolves every symlink hop in the path
        // (fs.realpathSync doesn't stop at the intentional `link -> repo` hop —
        // it also resolves whatever the OS's own tmpdir plumbing does, e.g.
        // macOS's /var -> /private/var). Comparing against realpath(repo) here
        // instead of the raw `repo` string keeps this assertion correct
        // regardless of whether the host's tmpdir happens to be symlinked.
        expectedFile = path.join(fs.realpathSync(repo), 'lib.js'),
        resolved = (() => {
          fs.writeFileSync(file, 'module.exports = {};\n');

          return resolveIndexedFilePaths(link, ['lib.js']);
        })();
      expect(resolved).toContain(expectedFile);
    } finally {
      try {
        fs.unlinkSync(link);
      } catch {
        // Ignore
      }
    }
  });
});

describe('parseGitDiffNameStatus', () => {
  it('includes both sides of a rename', () => {
    const paths = parseGitDiffNameStatus('R100\0old.js\0new.js\0');
    expect(paths.sort()).toEqual(['new.js', 'old.js']);
  });

  it('includes deleted and modified paths', () => {
    const paths = parseGitDiffNameStatus('M\0src/a.js\0D\0src/b.js\0A\0src/c.js\0');
    expect(paths.sort()).toEqual(['src/a.js', 'src/b.js', 'src/c.js']);
  });
});

describe('detectChangedSymbols with non-ASCII file names', () => {
  it('reports a committed edit to src/café.js (git would C-quote it without -z)', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-trust-utf8-')),
      git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim(),
      file = path.join(repo, 'src', 'café.js');
    try {
      git('init', '-q');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'test');
      git('config', 'core.quotePath', 'true');
      fs.mkdirSync(path.dirname(file));
      fs.writeFileSync(file, 'function cafe() { return 1; }\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'init');
      const base = git('rev-parse', 'HEAD');
      fs.writeFileSync(file, 'function cafe() { return 2; }\n');
      git('commit', '-q', '-am', 'edit');

      const result = detectChangedSymbols(
        {
          sqlJson: (sql) => (sql.includes('trust_head') ? [{ id: 1, path: repo, trust_head: base }] : []),
          sqlRun: () => {},
          withTransaction: (fn) => fn(),
          jsonErrNoExit: (msg) => msg,
        },
        'demo',
      );

      expect(result.changed_files).toBe(1);
      expect(result.changed_paths.some((p) => p.endsWith(path.join('src', 'café.js')))).toBe(true);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
