const path = require('path');
const fs = require('fs');
const os = require('os');

// Integration test: spawn the real worker, point it at a tiny on-disk repo,
// and verify the job completes via the index_jobs ledger.
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
    const dbModule = require('../db');
    dbModule.createDb({ memoryPath: ':memory:' });
    const deps = { sqlJson: dbModule.sqlJson, sqlRun: dbModule.sqlRun };
    const jobStore = require('../src/code-index/job-store');
    const jobId = jobStore.createJob(deps, { repoName: 'tmprepo', mode: 'full', filesTotal: 0 });

    const { createJobQueue } = require('../src/code-index/job-queue');
    const queue = createJobQueue({ jobStore, deps });
    const handle = queue.startJob(jobId, { repoName: 'tmprepo', repoPath: tmpDir, mode: 'full' });

    await new Promise((resolve) => handle.worker.on('exit', resolve));
    const job = jobStore.getJob(deps, jobId);
    expect(job.status).toBe('completed');
    expect(job.files_done).toBeGreaterThanOrEqual(2);
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
    const codeCmd = require('../commands/code-impl');
    const t0 = Date.now();
    const result = await codeCmd.indexRepoAsync({ path: tmpDir, name: 'tmp-cmd', mode: 'full' });
    const elapsed = Date.now() - t0;
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
    const codeCmd = require('../commands/code-impl');
    const created = codeCmd.indexRepoAsync({ path: '.', name: 'status-test', mode: 'full' });
    // indexRepoAsync is async; wait for the jobId
    return created.then((r) => {
      const status = codeCmd.indexStatus({ job: String(r.jobId) });
      expect(status).toBeDefined();
      expect(status.id).toBe(r.jobId);
      expect(status.repo_name).toBe('status-test');
    });
  });
});
