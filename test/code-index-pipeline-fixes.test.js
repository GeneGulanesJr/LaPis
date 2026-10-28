// End-to-end checks for the code-index pipeline: scope resolution pass 3,
// Interrupted derived phases, repos reached through a link, and delta ghosts.
const fs = require('fs'),
  os = require('os'),
  path = require('path'),
  { execFileSync } = require('child_process'),
  dbModule = require('../db'),
  { indexRepository, reindexRepository, CANCELLED } = require('../src/code-index/incremental-indexer'),
  deps = (args = {}) => ({ db: dbModule.getDb(), args: { noWorkers: true, ...args } }),
  repoId = (name) => dbModule.sqlJson('SELECT id FROM code_repos WHERE name = ?', [name])[0].id,
  filePaths = (name) =>
    dbModule.sqlJson('SELECT path FROM code_files WHERE repo_id = ? ORDER BY path', [repoId(name)]).map((r) => r.path);

let tmpRoot;

beforeAll(() => {
  dbModule.ensureDb();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-pipeline-'));
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeRepo(name, files, repoDir = path.join(tmpRoot, name)) {
  fs.mkdirSync(repoDir, { recursive: true });
  const git = (...a) =>
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repoDir, encoding: 'utf-8' }),
    write = (rel, body) => {
      fs.mkdirSync(path.dirname(path.join(repoDir, rel)), { recursive: true });
      fs.writeFileSync(path.join(repoDir, rel), body);
    };
  git('init', '-q');
  for (const [rel, body] of Object.entries(files)) {
    write(rel, body);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return { dir: repoDir, git, write };
}

// Each case runs several real index passes over a temp git repo.
describe('code-index pipeline', { timeout: 90000 }, () => {
  it('pass 3 resolves barrel re-exports and namespace imports without duplicating synthetic bindings', async () => {
    const repo = makeRepo('scope', {
        'src/config.js': 'export const CONFIG = { a: 1 };\nexport function helper() { return 1; }\n',
        'src/index.js': "export { CONFIG, helper } from './config.js';\n",
        'src/use.js':
          "import * as cfg from './config.js';\nimport { helper } from './index.js';\nexport function run() { return helper() + cfg.helper(); }\n",
      }),
      indexed = await indexRepository(deps(), repo.dir, 'scope'),
      id = repoId('scope'),
      status = (name) =>
        dbModule.sqlJson(
          `SELECT sr.status FROM file_scope_bindings b JOIN code_files f ON f.id = b.file_id
           JOIN scope_resolution sr ON sr.binding_id = b.id WHERE b.repo_id = ? AND f.path LIKE ? AND b.name = ?`,
          [id, '%use.js', name],
        ),
      bindingCount = () => dbModule.sqlJson('SELECT count(*) c FROM file_scope_bindings WHERE repo_id = ?', [id])[0].c,
      before = bindingCount();
    expect(indexed.success).toBe(true);
    expect(status('helper')).toEqual([{ status: 'resolved_internal' }]);
    expect(status('cfg.helper')).toEqual([{ status: 'resolved_internal' }]);

    for (const n of [2, 3]) {
      repo.write('src/config.js', `export const CONFIG = { a: ${n} };\nexport function helper() { return 1; }\n`);
      // oxlint-disable-next-line no-await-in-loop
      expect((await reindexRepository(deps(), 'scope', 'incremental')).files_reindexed).toBe(1);
      expect(bindingCount()).toBe(before);
    }
    expect(status('cfg.helper')).toEqual([{ status: 'resolved_internal' }]);
  });

  it('a cancelled derived phase is rebuilt by the next reindex even when no file changed', async () => {
    const repo = makeRepo('cancel', {
        'a.js': "const { b } = require('./b');\nfunction a() { return b(); }\nmodule.exports = { a };\n",
        'b.js': 'function b() { return 1; }\nmodule.exports = { b };\n',
      }),
      calls = () => dbModule.sqlJson('SELECT count(*) c FROM code_calls WHERE repo_id = ?', [repoId('cancel')])[0].c,
      cancelAtCallGraph = (p) => {
        if (p.step === 'build-call-graph') {
          throw CANCELLED;
        }
      },
      fullCalls = await indexRepository(deps(), repo.dir, 'cancel').then(calls);
    expect(fullCalls).toBeGreaterThan(0);

    repo.write(
      'a.js',
      "const { b } = require('./b');\n// edited\nfunction a() { return b(); }\nmodule.exports = { a };\n",
    );
    await expect(reindexRepository(deps({ onProgress: cancelAtCallGraph }), 'cancel', 'incremental')).rejects.toBe(
      CANCELLED,
    );
    expect(calls()).toBeLessThan(fullCalls);

    expect((await reindexRepository(deps(), 'cancel', 'incremental')).derived_scope).toBe('repo');
    expect(calls()).toBe(fullCalls);
    expect((await reindexRepository(deps(), 'cancel', 'incremental')).derived_scope).toBe('none');
  });

  it('a repo reached through a junction/symlink keeps one row per file on delta reindex', async () => {
    const real = path.join(tmpRoot, 'link-real'),
      link = path.join(tmpRoot, 'link-via'),
      repo = (() => {
        fs.mkdirSync(real);
        fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
        return makeRepo(
          'linked',
          { 'src/a.js': 'function a() { return 1; }\n', 'src/b.js': 'function b() { return 2; }\n' },
          link,
        );
      })(),
      before = await indexRepository(deps(), link, 'linked').then(() => filePaths('linked'));
    repo.write('src/a.js', 'function a2() { return 1; }\n');
    repo.git('commit', '-qam', 'edit');

    await expect(reindexRepository(deps(), 'linked', 'incremental')).resolves.toMatchObject({
      strategy: 'git-diff',
      files_reindexed: 1,
    });
    expect(filePaths('linked')).toEqual(before);
  });

  it('delta reindex drops deleted untracked files and files newly ignored', async () => {
    const repo = makeRepo('ghosts', { 'src/a.js': 'function a() { return 1; }\n', 'src/b.js': 'function b() {}\n' }),
      names = () => filePaths('ghosts').map((p) => path.basename(p));
    await indexRepository(deps(), repo.dir, 'ghosts');
    repo.write('src/scratch.js', 'function scratchHelper() { return 1; }\n');
    await reindexRepository(deps(), 'ghosts', 'incremental');
    expect(names()).toEqual(['a.js', 'b.js', 'scratch.js']);

    fs.rmSync(path.join(repo.dir, 'src/scratch.js'));
    repo.write('src/b.js', 'function b() { return 2; }\n');
    repo.git('commit', '-qam', 'edit');
    expect((await reindexRepository(deps(), 'ghosts', 'incremental')).strategy).toBe('git-diff');
    expect(names()).toEqual(['a.js', 'b.js']);

    repo.write('.memorycodeignore', 'src/a.js\n');
    repo.git('add', '-A');
    repo.git('commit', '-qm', 'ignore a');
    await reindexRepository(deps(), 'ghosts', 'incremental');
    expect(names()).toEqual(['b.js']);
  });
});
