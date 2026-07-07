const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveIndexedFilePaths } = require('../src/trust-sync/change-detector');

describe('resolveIndexedFilePaths', () => {
  it('maps git-relative paths to absolute indexed paths', () => {
    const repo = path.join(os.tmpdir(), 'lapis-trust-paths');
    const file = path.join(repo, 'src', 'app.js');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'export const app = 1;\n');

    const resolved = resolveIndexedFilePaths(repo, ['src/app.js']);
    expect(resolved).toContain(file);
  });

  it('includes realpath variants for symlinked repo roots', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-trust-real-'));
    const link = path.join(os.tmpdir(), `lapis-trust-link-${Date.now()}`);
    try {
      fs.symlinkSync(repo, link);
      const file = path.join(repo, 'lib.js');
      fs.writeFileSync(file, 'module.exports = {};\n');

      const resolved = resolveIndexedFilePaths(link, ['lib.js']);
      expect(resolved).toContain(file);
    } finally {
      try {
        fs.unlinkSync(link);
      } catch {
        // ignore
      }
    }
  });
});
