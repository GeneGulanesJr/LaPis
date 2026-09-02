const { createDb, resetDb, sqlJson } = require('../db');
const { tryAcquireSqliteLock, releaseSqliteLock, makeHolderId } = require('../src/code-index/repo-lock');

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
      
  return (sqlJson('SELECT holder_id FROM repo_index_locks WHERE repo_name = ?', ['my-repo']));
})();expect(rows[0].holder_id).toBe(holder);
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
});
