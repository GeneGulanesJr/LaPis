const { createDb, resetDb, sqlJson } = require('../db'),
  { tryAcquireSqliteLock, releaseSqliteLock, makeHolderId, withRepoIndexLock } = require('../src/code-index/repo-lock');

describe('repo-index lock', () => {
  beforeEach(() => {
    resetDb();
    createDb({ db_path: ':memory:' });
  });

  afterEach(() => resetDb());

  it('acquires and releases a sqlite-backed lock', () => {
    const holder = makeHolderId(),
      rows = (() => {
        expect(tryAcquireSqliteLock('my-repo', holder)).toBe(true);

        return sqlJson('SELECT holder_id FROM repo_index_locks WHERE repo_name = ?', ['my-repo']);
      })();
    expect(rows[0].holder_id).toBe(holder);
    releaseSqliteLock('my-repo', holder);
    expect(sqlJson('SELECT holder_id FROM repo_index_locks WHERE repo_name = ?', ['my-repo'])).toHaveLength(0);
  });

  it('blocks a second holder until release', () => {
    const first = makeHolderId(),
      second = makeHolderId();
    expect(tryAcquireSqliteLock('shared-repo', first)).toBe(true);
    expect(tryAcquireSqliteLock('shared-repo', second)).toBe(false);
    releaseSqliteLock('shared-repo', first);
    expect(tryAcquireSqliteLock('shared-repo', second)).toBe(true);
  });

  it('serializes concurrent callers in one process but stays reentrant within a call chain', async () => {
    let inside = 0,
      maxInside = 0,
      nested = false;
    const job = () =>
      withRepoIndexLock('demo', async () => {
        inside++;
        maxInside = Math.max(maxInside, inside);
        await new Promise((resolve) => setTimeout(resolve, 300));
        nested = await withRepoIndexLock('DEMO', async () => true);
        inside--;
      });
    await Promise.all([job(), new Promise((resolve) => setTimeout(resolve, 50)).then(job)]);
    expect(maxInside).toBe(1);
    expect(nested).toBe(true);
    expect(sqlJson('SELECT holder_id FROM repo_index_locks WHERE repo_name = ?', ['demo'])).toHaveLength(0);
  });
});
