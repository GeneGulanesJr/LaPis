const path = require('path'), fs = require('fs'), os = require('os');



// Integration test: spawn the real worker, point it at a tiny on-disk repo,
// And verify the job completes via the index_jobs ledger.
describe('async code indexing', () => {
  let tmpDir;
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-async-'));
    fs.writeFileSync(path.join(tmpDir, 'a.js'), 'export const x = 1;\n');
    fs.mkdirSync(path.join(tmpDir, 'src'));
    fs.writeFileSync(path.join(tmpDir, 'src', 'b.js'), 'export const y = 2;\n');
  });
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('runs indexRepository via the async path and finishes a small repo', async () => {
    const dbModule = require('../db'),
    deps = (() => {

      dbModule.createDb({ memoryPath: ':memory:' });
      
  return ({ sqlJson: dbModule.sqlJson, sqlRun: dbModule.sqlRun });
})(), jobStore = require('../src/code-index/job-store'),
      jobId = jobStore.createJob(deps, { repoName: 'tmprepo', mode: 'full', filesTotal: 0 }), { createJobQueue } = require('../src/code-index/job-queue'),
      queue = createJobQueue({ jobStore, deps }),
      handle = queue.startJob(jobId, { repoName: 'tmprepo', repoPath: tmpDir, mode: 'full' });

    

    await new Promise((resolve) => handle.worker.on('exit', resolve));
    {
const job = jobStore.getJob(deps, jobId);
    expect(job.status).toBe('completed');
    expect(job.files_done).toBeGreaterThanOrEqual(2);
  }
}, 60000);
});

describe('index-repo-async wrapper', () => {
  let tmpDir;
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-async-cmd-'));
    fs.writeFileSync(path.join(tmpDir, 'a.js'), 'export const x = 1;\n');
  });
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('returns immediately with a jobId and filesTotal without waiting for completion', async () => {
    const dbModule = require('../db');
    dbModule.createDb({ memoryPath: ':memory:' });
    const codeCmd = require('../commands/code-impl'),
      t0 = Date.now(),
      result = await codeCmd.indexRepoAsync({ path: tmpDir, name: 'tmp-cmd', mode: 'full' }),
      elapsed = Date.now() - t0;
    expect(result.jobId).toBeGreaterThan(0);
    expect(result.status).toBe('running');
    expect(result.filesTotal).toBeGreaterThanOrEqual(1);
    // The async path should return in well under the time a sync index would take.
    expect(elapsed).toBeLessThan(2000);
  });
});

describe('indexStatus wrapper', () => {
  it('returns the job record for a given id', () => {
    const dbModule = require('../db');
    dbModule.createDb({ memoryPath: ':memory:' });
    const codeCmd = require('../commands/code-impl'),
      created = codeCmd.indexRepoAsync({ path: '.', name: 'status-test', mode: 'full' });
    // IndexRepoAsync is async; wait for the jobId
    return created.then((r) => {
      const status = codeCmd.indexStatus({ job: String(r.jobId) });
      expect(status).toBeDefined();
      expect(status.id).toBe(r.jobId);
      expect(status.repo_name).toBe('status-test');
    });
  });
});

describe('indexRepo auto-switch', () => {
  let bigTmp;
  beforeAll(() => {
    bigTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-auto-async-'));
    // 600 tiny JS files to exceed the default threshold of 500.
    for (let i = 0; i < 600; i += 1) {
      fs.writeFileSync(path.join(bigTmp, `f${i}.js`), '// empty\n');
    }
  });
  afterAll(() => fs.rmSync(bigTmp, { recursive: true, force: true }));

  it('auto-routes to the async path when file count exceeds threshold', async () => {
    const dbModule = require('../db');
    dbModule.createDb({ memoryPath: ':memory:' });
    const codeCmd = require('../commands/code-impl'),
      result = await codeCmd.indexRepo({ path: bigTmp, name: 'big-repo' });
    // Async path returns { jobId, status: 'running', filesTotal }
    expect(result.jobId).toBeGreaterThan(0);
    expect(result.status).toBe('running');
    expect(result.filesTotal).toBeGreaterThanOrEqual(500);
  });

  it('--async flag forces async regardless of file count', async () => {
    const dbModule = require('../db');
    dbModule.createDb({ memoryPath: ':memory:' });
    const codeCmd = require('../commands/code-impl'),
      result = await codeCmd.indexRepo({ path: '.', name: 'small', async: 'true' });
    expect(result.jobId).toBeGreaterThan(0);
  });
});
