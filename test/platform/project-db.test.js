const { getKnownRepos, getKnownProjects, clearProjectDbCache, CACHE_TTL_MS } = require('../../src/platform/project-db'),
  SNAPSHOT_TTL_ENV = 'LAPIS_REPO_SNAPSHOT_TTL_MS';

describe('platform project-db', () => {
  let prevTtl;

  beforeEach(() => {
    // The db.js stubs below simulate DB failures/successes; the cross-process
    // Snapshot file (outside any test's control) must never answer instead.
    prevTtl = process.env[SNAPSHOT_TTL_ENV];
    process.env[SNAPSHOT_TTL_ENV] = '0';
  });

  afterEach(() => {
    clearProjectDbCache();
    if (prevTtl === undefined) {
      delete process.env[SNAPSHOT_TTL_ENV];
    } else {
      process.env[SNAPSHOT_TTL_ENV] = prevTtl;
    }
  });

  test('getKnownRepos returns [] when the DB is unavailable', () => {
    const dbPath = require.resolve('../../db'),
      prev = (() => {
        require(dbPath);

        return require.cache[dbPath].exports;
      })();
    require.cache[dbPath].exports = {
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

        return require.cache[dbPath].exports;
      })();
    let calls = 0;
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

        return require.cache[dbPath].exports;
      })();
    let calls = 0;
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

describe('platform project-db: cross-process repos snapshot', () => {
  const fs = require('node:fs'),
    os = require('node:os'),
    path = require('node:path'),
    { getConfig } = require('../../config'),
    dbPath = require.resolve('../../db');

  let tmpDir, savedConfig, prevTtl;

  function snapshotFile() {
    return path.join(tmpDir, 'memory-dir', 'repos-snapshot.json');
  }

  function writeSnapshotFile(content) {
    fs.mkdirSync(path.dirname(snapshotFile()), { recursive: true });
    fs.writeFileSync(snapshotFile(), typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  }

  beforeEach(() => {
    prevTtl = process.env[SNAPSHOT_TTL_ENV];
    delete process.env[SNAPSHOT_TTL_ENV];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-project-db-snap-'));
    // Warm getConfig() so the mtime guard accepts the injected config, then
    // Point db_path at the temp dir (same mechanism db.js createDb uses).
    getConfig();
    savedConfig = getConfig._cached;
    getConfig._cached = { db_path: path.join(tmpDir, 'memory-dir', 'memory.db') };
  });

  afterEach(() => {
    // Disable the snapshot layer BEFORE clearing so that the unlink step
    // Inside clearProjectDbCache can never touch a file outside the temp dir.
    process.env[SNAPSHOT_TTL_ENV] = '0';
    clearProjectDbCache();
    getConfig._cached = savedConfig;
    if (prevTtl === undefined) {
      delete process.env[SNAPSHOT_TTL_ENV];
    } else {
      process.env[SNAPSHOT_TTL_ENV] = prevTtl;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function stubDb(impl) {
    const prev = (() => {
      require(dbPath);
      return require.cache[dbPath].exports;
    })();
    require.cache[dbPath].exports = impl;
    return prev;
  }

  test('serves repos and projects from a fresh snapshot without touching the DB', () => {
    writeSnapshotFile({
      written_at: Date.now(),
      repos: [{ name: 'snap-repo', path: '/snap', indexed_at: 'now' }],
      projects: ['snap-project'],
    });
    let dbCalls = 0;
    const prev = stubDb({
      sqlJson: () => {
        dbCalls++;
        throw new Error('DB must not be touched when the snapshot is fresh');
      },
    });
    try {
      expect(getKnownRepos()).toEqual([{ name: 'snap-repo', path: '/snap', indexed_at: 'now' }]);
      expect(getKnownProjects()).toEqual(['snap-project']);
      expect(dbCalls).toBe(0);
    } finally {
      require.cache[dbPath].exports = prev;
    }
  });

  test('expired snapshot falls back to the DB and is rewritten', () => {
    writeSnapshotFile({
      written_at: Date.now() - CACHE_TTL_MS - 1000,
      repos: [{ name: 'stale', path: '/stale', indexed_at: 'old' }],
      projects: ['stale-project'],
    });
    const prev = stubDb({
      sqlJson: (sql) => {
        if (sql.includes('code_repos')) {
          return [{ name: 'fresh', path: '/fresh', indexed_at: 'now' }];
        }
        return [{ project: 'fresh-project' }];
      },
    });
    try {
      expect(getKnownRepos()).toEqual([{ name: 'fresh', path: '/fresh', indexed_at: 'now' }]);
      const rewritten = JSON.parse(fs.readFileSync(snapshotFile(), 'utf8'));
      expect(rewritten.repos).toEqual([{ name: 'fresh', path: '/fresh', indexed_at: 'now' }]);
      expect(rewritten.projects).toEqual(['fresh-project']);
    } finally {
      require.cache[dbPath].exports = prev;
    }
  });

  test('corrupt snapshot falls back to the DB', () => {
    writeSnapshotFile('{not json');
    const prev = stubDb({
      sqlJson: (sql) => (sql.includes('code_repos') ? [{ name: 'fresh', path: '/fresh', indexed_at: 'now' }] : []),
    });
    try {
      expect(getKnownRepos()).toEqual([{ name: 'fresh', path: '/fresh', indexed_at: 'now' }]);
    } finally {
      require.cache[dbPath].exports = prev;
    }
  });

  test('a successful DB read writes the snapshot atomically (no tmp left behind)', () => {
    const prev = stubDb({
      sqlJson: (sql) => (sql.includes('code_repos') ? [{ name: 'fresh', path: '/fresh', indexed_at: 'now' }] : []),
    });
    try {
      expect(getKnownRepos()).toEqual([{ name: 'fresh', path: '/fresh', indexed_at: 'now' }]);
      const parsed = JSON.parse(fs.readFileSync(snapshotFile(), 'utf8'));
      expect(parsed.repos).toEqual([{ name: 'fresh', path: '/fresh', indexed_at: 'now' }]);
      expect(typeof parsed.written_at).toBe('number');
      expect(fs.readdirSync(path.dirname(snapshotFile())).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    } finally {
      require.cache[dbPath].exports = prev;
    }
  });

  test('LAPIS_REPO_SNAPSHOT_TTL_MS=0 disables the layer entirely', () => {
    process.env[SNAPSHOT_TTL_ENV] = '0';
    // Earlier tests in this describe left a warm in-process cache; the layer
    // Under test is the snapshot file, so drop in-process state too. With
    // TTL=0 the clear must NOT delete the file we are about to ignore.
    clearProjectDbCache();
    // Even a perfectly fresh snapshot file must be ignored...
    writeSnapshotFile({
      written_at: Date.now(),
      repos: [{ name: 'snap-repo', path: '/snap', indexed_at: 'now' }],
      projects: ['snap-project'],
    });
    const prev = stubDb({
      sqlJson: (sql) => (sql.includes('code_repos') ? [{ name: 'db-repo', path: '/db', indexed_at: 'now' }] : []),
    });
    try {
      expect(getKnownRepos()).toEqual([{ name: 'db-repo', path: '/db', indexed_at: 'now' }]);
      // ...and nothing may have been written to it while disabled.
      const untouched = JSON.parse(fs.readFileSync(snapshotFile(), 'utf8'));
      expect(untouched.repos).toEqual([{ name: 'snap-repo', path: '/snap', indexed_at: 'now' }]);
    } finally {
      require.cache[dbPath].exports = prev;
    }
  });

  test('clearProjectDbCache deletes the snapshot file', () => {
    writeSnapshotFile({ written_at: Date.now(), repos: [], projects: [] });
    clearProjectDbCache();
    expect(fs.existsSync(snapshotFile())).toBe(false);
  });

  test('snapshot write failure never breaks the caller', () => {
    // Read-only dir under the (writable) temp root: mkdirSync/writeFileSync fail.
    const readOnly = path.join(tmpDir, 'readonly'),
      prev = stubDb({
        sqlJson: (sql) => (sql.includes('code_repos') ? [{ name: 'fresh', path: '/fresh', indexed_at: 'now' }] : []),
      });
    fs.mkdirSync(readOnly, { recursive: true });
    fs.chmodSync(readOnly, 0o500);
    getConfig._cached = { db_path: path.join(readOnly, 'memory.db') };
    try {
      expect(getKnownRepos()).toEqual([{ name: 'fresh', path: '/fresh', indexed_at: 'now' }]);
    } finally {
      require.cache[dbPath].exports = prev;
      fs.chmodSync(readOnly, 0o700);
      getConfig._cached = { db_path: path.join(tmpDir, 'memory-dir', 'memory.db') };
    }
  });
});
