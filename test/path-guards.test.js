const { resolveRepoScopedPath } = require('../src/code-index/path-guards');
const path = require('path');
const fs = require('fs');
const os = require('os');

describe('code-index path guards', () => {
  let tmpRoot;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-path-guard-'));
    fs.writeFileSync(path.join(tmpRoot, 'inside.js'), 'export const ok = 1;');
    fs.writeFileSync(path.join(os.tmpdir(), 'outside-secret.env'), 'SECRET=1');
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    try {
      fs.unlinkSync(path.join(os.tmpdir(), 'outside-secret.env'));
    } catch {}
  });

  it('allows paths inside the repo', () => {
    const resolved = resolveRepoScopedPath(tmpRoot, 'inside.js');
    expect(resolved).toContain('inside.js');
  });

  it('rejects paths that escape the repo', () => {
    const outside = path.join(os.tmpdir(), 'outside-secret.env');
    expect(resolveRepoScopedPath(tmpRoot, outside)).toBeNull();
    expect(resolveRepoScopedPath(tmpRoot, '../outside-secret.env')).toBeNull();
  });

  it('rejects secret filenames even when inside the repo', () => {
    fs.writeFileSync(path.join(tmpRoot, '.env'), 'SECRET=1');
    expect(resolveRepoScopedPath(tmpRoot, '.env')).toBeNull();
  });
});
