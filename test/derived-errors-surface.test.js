// Regression test for issue #287: derived-builder failures were reduced to a
// console line, so a "successful" index could report success with silently
// empty graphs. The indexer now collects thrown builder failures into
// `derived_errors` on the returned stats (vi.mock does not intercept this
// repo's CJS require graph, so this drives the real builders with a db that
// makes them throw).
const dbModule = require('../db');

// No test file may create the real user DB in CI, but the db module needs a
// resolvable path; isolate it before first require already happened above —
// ensureDb is never called here, only builder code paths that throw.
const brokenDb = {};

describe('derived-builder failures are surfaced (#287)', () => {
  it('collects thrown repo-wide builder failures into derived_errors instead of throwing', async () => {
    const { derivedPhase } = require('../src/code-index/incremental-indexer');
    const stats = await derivedPhase(brokenDb, 'repo-x', null, 10, 5, 20);

    // A broken db makes the builders that do not swallow errors internally
    // throw; those throws must land in derived_errors, not vanish.
    expect(Array.isArray(stats.derived_errors)).toBe(true);
    expect(stats.derived_errors.length).toBeGreaterThanOrEqual(1);
    for (const entry of stats.derived_errors) {
      expect(typeof entry.builder).toBe('string');
      expect(entry.error).toContain('prepare is not a function');
    }
    expect(stats.derived_scope).toBe('repo');
  });

  it('collects thrown incremental builder failures too', async () => {
    const { derivedPhase } = require('../src/code-index/incremental-indexer');
    const stats = await derivedPhase(brokenDb, 'repo-x', null, 10, 5, 20, [1, 2], [3]);

    expect(Array.isArray(stats.derived_errors)).toBe(true);
    expect(stats.derived_errors.length).toBeGreaterThanOrEqual(1);
    expect(stats.derived_errors.some((e) => e.builder.includes('incremental'))).toBe(true);
  });

  it('reports an empty derived_errors array on a clean run', async () => {
    process.env.LAPIS_HOME =
      process.env.LAPIS_HOME ||
      require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'lapis-derived-clean-'));
    dbModule.ensureDb();
    delete require.cache[require.resolve('../src/code-index/incremental-indexer')];
    const { derivedPhase } = require('../src/code-index/incremental-indexer');
    const stats = await derivedPhase(dbModule.getDb(), 'repo-missing', null, 0, 0, 0);
    // On a repo row that does not exist, the cochange builder reports
    // {success:false, reason:'repo not found'} — surfaced since #293, no
    // longer swallowed. Nothing else fails on an empty schema.
    expect(stats.derived_errors).toEqual([{ builder: 'cochange', error: 'repo not found' }]);
  });
});
