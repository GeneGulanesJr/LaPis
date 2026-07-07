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
    const rejections = [];
    expect(resolveRepoScopedPath(tmpRoot, outside, rejections)).toBeNull();
    expect(resolveRepoScopedPath(tmpRoot, '../outside-secret.env', rejections)).toBeNull();
    expect(rejections.some((r) => r.reason === 'outside_repo')).toBe(true);
  });

  it('rejects secret filenames even when inside the repo', () => {
    fs.writeFileSync(path.join(tmpRoot, '.env'), 'SECRET=1');
    const rejections = [];
    expect(resolveRepoScopedPath(tmpRoot, '.env', rejections)).toBeNull();
    expect(rejections[0].reason).toBe('secret_file');
  });
});
