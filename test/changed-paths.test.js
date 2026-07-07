const path = require('path');
const fs = require('fs');
const os = require('os');
const { parseChangedPathsInput } = require('../src/code-index/incremental-indexer');

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
    const outside = path.join(os.tmpdir(), 'outside.js');
    fs.writeFileSync(outside, 'export const nope = 1;');
    const delta = parseChangedPathsInput(
      JSON.stringify([{ path: 'inside.js' }, { path: outside }]),
      repoRoot,
    );
    expect(delta.changed).toHaveLength(1);
    expect(delta.rejected).toHaveLength(1);
    expect(delta.rejected[0].reason).toBe('outside_repo');
  });
});
