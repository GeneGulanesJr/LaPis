const fs = require('fs'),
  os = require('os'),
  path = require('path'),
  { resolveIndexedFilePaths, parseGitDiffNameStatus } = require('../src/trust-sync/change-detector');

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
      fs.symlinkSync(repo, link);
      const file = path.join(repo, 'lib.js'),
        resolved = (() => {
          fs.writeFileSync(file, 'module.exports = {};\n');

          return resolveIndexedFilePaths(link, ['lib.js']);
        })();
      expect(resolved).toContain(file);
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
    const paths = parseGitDiffNameStatus('R100\told.js\tnew.js\n');
    expect(paths.sort()).toEqual(['new.js', 'old.js']);
  });

  it('includes deleted and modified paths', () => {
    const paths = parseGitDiffNameStatus('M\tsrc/a.js\nD\tsrc/b.js\nA\tsrc/c.js\n');
    expect(paths.sort()).toEqual(['src/a.js', 'src/b.js', 'src/c.js']);
  });
});
