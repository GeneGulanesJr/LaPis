const { getKnownRepos, getKnownProjects, clearProjectDbCache, CACHE_TTL_MS } = require('../../src/platform/project-db');

describe('platform project-db', () => {
  afterEach(() => {
    clearProjectDbCache();
  });

  test('getKnownRepos returns [] when the DB is unavailable', () => {
    const dbPath = require.resolve('../../db'),
    prev = (() => {

      require(dbPath);
      
  return (require.cache[dbPath].exports);
})();require.cache[dbPath].exports = {
      sqlJson: () => {
        throw new Error('no db');
      },
    };
    try {
      expect(getKnownRepos()).toEqual([]);
    } finally {
      require.cache[dbPath].exports = prev;
      clearProjectDbCache();
    }
  });

  test('getKnownRepos caches results within TTL', () => {
    const dbPath = require.resolve('../../db'),
    prev = (() => {

      require(dbPath);
      
  return (require.cache[dbPath].exports);
})();let calls = 0;
    require.cache[dbPath].exports = {
      sqlJson: (sql) => {
        if (sql.includes('code_repos')) {
          calls++;
          return [{ name: 'app', path: '/app', indexed_at: 'now' }];
        }
        return [];
      },
    };
    try {
      expect(getKnownRepos()).toEqual([{ name: 'app', path: '/app', indexed_at: 'now' }]);
      expect(getKnownRepos()).toEqual([{ name: 'app', path: '/app', indexed_at: 'now' }]);
      expect(calls).toBe(1);
    } finally {
      require.cache[dbPath].exports = prev;
      clearProjectDbCache();
    }
  });

  test('clearProjectDbCache forces a reload', () => {
    const dbPath = require.resolve('../../db'),
    prev = (() => {

      require(dbPath);
      
  return (require.cache[dbPath].exports);
})();let calls = 0;
    require.cache[dbPath].exports = {
      sqlJson: (sql) => {
        if (sql.includes('code_repos')) {
          calls++;
          return [];
        }
        if (sql.includes('FROM observations')) {
          return [{ project: 'legacy' }];
        }
        return [];
      },
    };
    try {
      getKnownRepos();
      getKnownProjects();
      clearProjectDbCache();
      getKnownRepos();
      getKnownProjects();
      expect(calls).toBe(2);
      expect(getKnownProjects()).toEqual(['legacy']);
    } finally {
      require.cache[dbPath].exports = prev;
      clearProjectDbCache();
    }
  });

  test('exports CACHE_TTL_MS matching Pi REPO_CACHE_TTL (5 min)', () => {
    expect(CACHE_TTL_MS).toBe(5 * 60 * 1000);
  });
});
