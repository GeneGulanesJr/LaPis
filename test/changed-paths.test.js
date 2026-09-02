const path = require('path'), fs = require('fs'), os = require('os'), { parseChangedPathsInput } = require('../src/code-index/incremental-indexer');




describe('parseChangedPathsInput rejected paths', () => {
  let repoRoot;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-changed-paths-'));
    fs.writeFileSync(path.join(repoRoot, 'inside.js'), 'export const ok = 1;');
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('returns rejected paths for entries outside the repo', () => {
    const outside = path.join(os.tmpdir(), 'outside.js'),
    delta = (() => {

      fs.writeFileSync(outside, 'export const nope = 1;');
      
  return (parseChangedPathsInput(
      JSON.stringify([{ path: 'inside.js' }, { path: outside }, { path: 123 }]),
      repoRoot,
    ));
})();expect(delta.changed).toHaveLength(1);
    expect(delta.rejected).toHaveLength(2);
    expect(delta.rejected.some((r) => r.reason === 'outside_repo')).toBe(true);
    expect(delta.rejected.some((r) => r.reason === 'invalid_path')).toBe(true);
  });
});
