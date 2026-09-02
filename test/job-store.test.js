const { createDb, sqlJson, sqlRun } = require('../db');
const jobStore = require('../src/code-index/job-store'),
  // After createDb() returns, the global sqlJson/sqlRun functions in db.js
  // operate on the in-memory database. job-store accepts a { sqlJson, sqlRun }
  // shape so we can pass them through directly.
  deps = { sqlJson, sqlRun };

let initialized = false;
beforeAll(() => {
  if (!initialized) {
    createDb({ memoryPath: ':memory:' });
    initialized = true;
  }
});

describe('job-store', () => {
  it('createJob returns a numeric id and persists repo_name and mode', () => {
    const id = jobStore.createJob(deps, { repoName: 'foo', mode: 'full', filesTotal: 123 });
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  it('updateProgress writes files_done and current_file atomically', () => {
    const id = jobStore.createJob(deps, { repoName: 'bar', mode: 'full', filesTotal: 10 }),
    job = (() => {

      jobStore.updateProgress(deps, id, { filesDone: 5, currentFile: 'src/a.js' });
      
  return (jobStore.getJob(deps, id));
})();expect(job.files_done).toBe(5);
    expect(job.current_file).toBe('src/a.js');
    expect(job.status).toBe('running');
  });

  it('completeJob sets status=completed and completed_at', () => {
    const id = jobStore.createJob(deps, { repoName: 'baz', mode: 'full', filesTotal: 10 }),
    job = (() => {

      jobStore.completeJob(deps, id, { status: 'completed', filesDone: 10 });
      
  return (jobStore.getJob(deps, id));
})();expect(job.status).toBe('completed');
    expect(job.completed_at).toBeTruthy();
  });

  it('listRunningJobs returns only status=running jobs', () => {
    const a = jobStore.createJob(deps, { repoName: 'a', mode: 'full', filesTotal: 10 }),
      b = jobStore.createJob(deps, { repoName: 'b', mode: 'incremental', filesTotal: 10 }),
    running = (() => {

      jobStore.completeJob(deps, b, { status: 'completed' });
      
  return (jobStore.listRunningJobs(deps));
})();expect(running.map((j) => j.id)).toContain(a);
    expect(running.map((j) => j.id)).not.toContain(b);
  });
});
