// #386: trust-sync and the indexer shared code_repos.head_commit, so whichever
// Ran second after a pull saw "HEAD unchanged" (or a falsely fresh index).
const fs = require('fs'),
  os = require('os'),
  path = require('path'),
  { execFileSync } = require('child_process'),
  dbModule = require('../db'),
  codeCmd = require('../commands/code-impl'),
  { syncCodeTrust } = require('../src/trust-sync/symbol-links'),
  { createTrustSyncRepository } = require('../src/platform/storage/repositories/trust-sync');

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();
}

function trustSync(repo) {
  const deps = { jsonErrNoExit: (msg) => ({ error: msg }), sqlJson: dbModule.sqlJson, sqlRun: dbModule.sqlRun };
  return syncCodeTrust({ ...deps, trustSyncRepository: createTrustSyncRepository(deps) }, { repo });
}

function indexedHead(repo) {
  return dbModule.sqlJson('SELECT head_commit FROM code_repos WHERE name = ?', [repo])[0].head_commit;
}

describe('trust-sync and reindex keep separate baselines (#386)', () => {
  let repoDir;

  beforeEach(() => {
    dbModule.resetDb();
    dbModule.createDb({ memoryPath: ':memory:' });
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-386-'));
    git(repoDir, 'init', '-q');
    fs.writeFileSync(path.join(repoDir, 'a.js'), 'function alpha() {\n  return 1;\n}\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-q', '-m', 'one');
  });

  afterEach(() => {
    dbModule.resetDb();
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  async function setupAndCommit(repo) {
    await codeCmd.indexRepo({ path: repoDir, name: repo });
    trustSync(repo);
    const before = git(repoDir, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repoDir, 'a.js'), 'function alpha() {\n  return 2;\n}\n');
    git(repoDir, 'commit', '-q', '-am', 'two');
    return { before, after: git(repoDir, 'rev-parse', 'HEAD') };
  }

  it('reindex then trust-sync: trust-sync still sees the new commit', async () => {
    const { before, after } = await setupAndCommit('r386a');
    await codeCmd.reindexRepo({ repo: 'r386a' });
    expect(indexedHead('r386a')).toBe(after);

    const r = trustSync('r386a');
    expect(r.message).not.toBe('HEAD unchanged, nothing to sync');
    expect(r.old_head).toBe(before);
    expect(r.new_head).toBe(after);
  });

  it('trust-sync then reindex: the index stays stale until reindexed', async () => {
    const { before, after } = await setupAndCommit('r386b'),
      r = trustSync('r386b');
    expect(r.old_head).toBe(before);
    expect(r.new_head).toBe(after);
    expect(indexedHead('r386b')).toBe(before);

    await codeCmd.reindexRepo({ repo: 'r386b' });
    expect(indexedHead('r386b')).toBe(after);
    expect(trustSync('r386b').message).toBe('HEAD unchanged, nothing to sync');
  });
});

describe('V29 migration seeds trust_head from head_commit', () => {
  let tmpDb;

  afterEach(() => {
    dbModule.resetDb();
    if (tmpDb && fs.existsSync(tmpDb)) {
      fs.unlinkSync(tmpDb);
    }
  });

  it('copies the old shared baseline into trust_head', () => {
    tmpDb = path.join(os.tmpdir(), `lapis-v29-${Date.now()}.db`);
    dbModule.resetDb();
    dbModule.createDb({ db_path: tmpDb });
    const db = dbModule.getDb();
    db.prepare('INSERT INTO code_repos (name, path, head_commit) VALUES (?, ?, ?)').run('v29', '/tmp/v29', 'abc123');
    db.exec('ALTER TABLE code_repos DROP COLUMN trust_head');
    db.exec('PRAGMA user_version = 28');

    dbModule.resetDb();
    dbModule.createDb({ db_path: tmpDb });
    expect(dbModule.getDb().prepare('SELECT trust_head FROM code_repos WHERE name = ?').get('v29').trust_head).toBe(
      'abc123',
    );
  });
});
