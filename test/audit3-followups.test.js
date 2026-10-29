// Follow-ups from the third audit: capture-passive project, atomic doc clear,
// Test-file detection on repo-relative paths, VACUUM gate, atomic todo updates.
const fs = require('fs'),
  os = require('os'),
  path = require('path'),
  dbModule = require('../db');

let tmpRoot;

beforeAll(() => {
  dbModule.ensureDb();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-audit3-'));
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('capture-passive', () => {
  const content = '## Key Learnings:\n- Keep the project on every save\n';

  it('saves learnings under the current project unless --project is given', () => {
    const { capturePassive } = require('../commands/observation'),
      { sqlJson, sqlRun, jsonErrNoExit } = dbModule,
      projectOf = (title) => sqlJson('SELECT project FROM observations WHERE title = ?', [title])[0]?.project;

    expect(capturePassive({ sqlJson, sqlRun, jsonErrNoExit }, { content }).extracted).toBe(1);
    expect(projectOf('Keep the project on every save')).toBeTruthy();

    capturePassive({ sqlJson, sqlRun, jsonErrNoExit }, { content: '## Key Learnings:\n- Named one\n', project: 'p1' });
    expect(projectOf('Named one')).toBe('p1');
  });
});

describe('doc index', () => {
  it('a reindex that fails before writing leaves the old index whole', async () => {
    const { indexDocs } = require('../src/doc-index/repos'),
      db = dbModule.getDb(),
      dir = path.join(tmpRoot, 'docs'),
      fileCount = () =>
        db
          .prepare("SELECT count(*) c FROM doc_files f JOIN doc_repos r ON r.id = f.repo_id WHERE r.name = 'keep'")
          .get().c;
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'a.md'), '# Title\n\nBody text.\n');
    expect((await indexDocs(db, dir, 'keep')).success).toBe(true);
    expect(fileCount()).toBe(1);

    // An invalid ignore glob throws while walking the folder.
    await expect(indexDocs(db, dir, 'keep', '(')).rejects.toThrow();
    expect(fileCount()).toBe(1);
  });
});

describe('preflight likely tests', () => {
  it('judges test files on the repo-relative path, not on the folder the repo sits in', () => {
    const { getLikelyTests } = require('../src/agent-intel/preflight')._private,
      root = path.join(tmpRoot, 'latest'),
      widget = path.join(root, 'src', 'widget.js'),
      widgetTest = path.join(root, 'test', 'widget.test.js'),
      db = {
        prepare: () => ({
          get: () => ({ path: root }),
          all: () => [{ path: widget }, { path: widgetTest }, { path: path.join(root, 'src', 'other.js') }],
        }),
      };
    expect(getLikelyTests(db, 1, [widget], 5)).toEqual([widgetTest]);
  });
});

describe('session-end VACUUM gate', () => {
  const { runVacuum } = require('../src/memory-domain/compaction'),
    fakeDeps = (pages, free) => {
      const raw = [];
      return {
        raw,
        sqlRaw: (sql) => raw.push(sql),
        sqlJson: (sql) => (sql.includes('page_count') ? [{ page_count: pages }] : [{ freelist_count: free }]),
      };
    };

  it('skips the VACUUM when under 10% of pages are free', () => {
    const deps = fakeDeps(1000, 20),
      report = runVacuum(deps);
    expect(report.ok).toBe(true);
    expect(report.steps.vacuumed).toBe(false);
    expect(deps.raw).not.toContain('VACUUM;');
  });

  it('runs it when free pages pass 10%, or when forced', () => {
    const fragmented = fakeDeps(1000, 300),
      forced = fakeDeps(1000, 0);
    expect(runVacuum(fragmented).steps.vacuumed).toBe(true);
    expect(runVacuum(forced, { force: true }).steps.vacuumed).toBe(true);
    expect(fragmented.raw).toContain('VACUUM;');
    expect(forced.raw).toContain('VACUUM;');
  });
});

describe('aurex todo updates', () => {
  function newTodo(repo) {
    repo.createMissionLedger({ missionId: 'mtx', missionTitle: 'tx mission', status: 'in_progress' });
    return repo.createTodo('mtx', { title: 'first', status: 'ready' })[0];
  }

  it('runs read-merge-write updates inside one write transaction', () => {
    const { createAurexRepository } = require('../src/platform/storage/repositories'),
      withTransaction = vi.fn((fn) => dbModule.withTransaction(fn)),
      repo = createAurexRepository({ sqlJson: dbModule.sqlJson, sqlRun: dbModule.sqlRun, withTransaction }),
      todo = newTodo(repo);

    expect(repo.updateTodo(todo.id, { title: 'second' })[0].title).toBe('second');
    expect(repo.addTodoNote(todo.id, 'a note')[0].evidence.notes).toContain('a note');
    expect(withTransaction).toHaveBeenCalledTimes(2);
  });
});
