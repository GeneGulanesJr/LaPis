const { createRepositories } = require('../src/platform/storage/repositories'), { createStorageContext } = require('../src/platform/storage'), obsCmd = require('../commands/observation'), symCmd = require('../commands/symbols');




describe('platform storage repositories', () => {
  function mockDeps() {
    return {
      sqlJson: vi.fn((query) => {
        if (query.includes('SELECT id FROM code_files')) {
          return [{ id: 11 }];
        }
        if (query.includes('SELECT id FROM doc_files')) {
          return [{ id: 12 }];
        }
        if (query.includes('SELECT last_insert_rowid()')) {
          return [{ id: 22 }];
        }
        if (query.includes('SELECT * FROM code_repos')) {
          return [];
        }
        if (query.includes('SELECT * FROM doc_repos')) {
          return [];
        }
        if (query.includes('COUNT(*) as cnt')) {
          return [{ cnt: 0 }];
        }
        return [];
      }),
      sqlRun: vi.fn(),
      sqlRaw: vi.fn(),
      jsonErrNoExit: vi.fn((message) => ({ error: message })),
    };
  }

  it('creates explicit feature-owned repository interfaces', () => {
    const repositories = createRepositories(mockDeps());

    expect(Object.keys(repositories).sort()).toEqual([
      'analytics',
      'aurex',
      'codeIndex',
      'docIndex',
      'memory',
      'trustSync',
    ]);
    expect(repositories.memory.insertObservation).toBeTypeOf('function');
    expect(repositories.codeIndex.insertFile).toBeTypeOf('function');
    expect(repositories.docIndex.insertSection).toBeTypeOf('function');
    expect(repositories.trustSync.updateLinkTrust).toBeTypeOf('function');
    expect(repositories.analytics.getStorageStats).toBeTypeOf('function');
  });

  it('creates a storage context that composes SQL helpers with repositories', () => {
    const deps = mockDeps(),
      context = createStorageContext(deps);

    expect(context.sqlJson).toBe(deps.sqlJson);
    expect(context.repositories.memory.getObservation).toBeTypeOf('function');
    expect(context.repositories.analytics.getStorageStats()).toEqual({
      observations: 0,
      prompts: 0,
      sessions: 0,
      symbolLinks: 0,
      codeRepos: 0,
      docRepos: 0,
    });
  });

  it('keeps code and doc repository writes aligned with current schema columns', () => {
    const deps = mockDeps(),
      repositories = createRepositories(deps);

    repositories.codeIndex.insertFile({
      repoId: 1,
      path: '/tmp/a.js',
      language: 'js',
      content: 'function a() {}',
      contentHash: 'hash',
      mtime: 1,
      sizeBytes: 15,
      lineCount: 1,
    });
    repositories.docIndex.insertFile({
      repoId: 1,
      path: '/tmp/README.md',
      content: '# Title',
      contentHash: 'hash',
      mtime: 1,
    });

    expect(deps.sqlRun).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO code_files'), expect.any(Array));
    expect(deps.sqlRun).toHaveBeenCalledWith(
      'INSERT INTO doc_files (repo_id, path, content, content_hash, mtime) VALUES (?, ?, ?, ?, ?)',
      [1, '/tmp/README.md', '# Title', 'hash', 1],
    );
  });

  it('routes observation commands through the memory repository when supplied', () => {
    const memoryRepository = {
        getObservation: vi.fn(() => [{ id: 1, title: 'A' }]),
        getSymbolLinksForMemory: vi.fn(() => [{ symbol_id: 'S', repo: 'r', trust_score: 1 }]),
        getRecallCountForMemory: vi.fn(() => [{ cnt: 2 }]),
      },
      result = obsCmd.get({ memoryRepository, jsonErrNoExit: vi.fn() }, { id: '1' });

    expect(result.symbols).toHaveLength(1);
    expect(result.recall_count).toBe(2);
    expect(memoryRepository.getObservation).toHaveBeenCalledWith('1');
  });

  it('routes trust commands through the trust-sync repository when supplied', () => {
    const trustSyncRepository = {
        linkSymbol: vi.fn(() => ({ ok: true })),
      },
      result = symCmd.linkSymbol(
        { trustSyncRepository, jsonErrNoExit: vi.fn((message) => ({ error: message })) },
        { 'memory-id': '1', 'symbol-id': 'S', repo: 'repo', trust: '0.8' },
      );

    expect(result.ok).toBe(true);
    expect(trustSyncRepository.linkSymbol).toHaveBeenCalledWith({
      memoryId: '1',
      symbolId: 'S',
      repo: 'repo',
      trust: 0.8,
    });
  });
});
