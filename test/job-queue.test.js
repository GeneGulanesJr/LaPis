const { EventEmitter } = require('events');

class FakeWorker extends EventEmitter {
  constructor() {
    super();
    this.postMessage = () => {};
    this.terminateCalls = 0;
    this.terminate = () => {
      this.terminateCalls++;
      return Promise.resolve(0);
    };
  }
}

function makeWorkerFactory() {
  const calls = [];
  function Factory(script, opts) {
    calls.push({ script, opts });
    return new FakeWorker();
  }
  Factory.calls = calls;
  return Factory;
}

describe('job-queue', () => {
  it('startJob spawns a Worker and tracks it by jobId', () => {
    const WorkerFactory = makeWorkerFactory(), { createJobQueue } = require('../src/code-index/job-queue'),
      q = createJobQueue({ Worker: WorkerFactory, jobStore: {}, deps: {} }),
      handle = q.startJob(42, { repoName: 'foo' });
    
    expect(WorkerFactory.calls.length).toBe(1);
    expect(WorkerFactory.calls[0].script).toContain('index-worker');
    expect(WorkerFactory.calls[0].opts.workerData.jobId).toBe(42);
    expect(q.getWorker(42)).toBe(handle.worker);
  });

  it('getStatus returns running when worker is alive, completed when not', () => {
    const WorkerFactory = makeWorkerFactory(), { createJobQueue } = require('../src/code-index/job-queue'),
      q = createJobQueue({ Worker: WorkerFactory, jobStore: {}, deps: {} });
    
    q.startJob(7, { repoName: 'foo' });
    expect(q.getStatus(7)).toBe('running');
    q.markDone(7);
    expect(q.getStatus(7)).toBe('completed');
  });

  it('cancels a running job and terminates its worker', async () => {
    const w = new FakeWorker();
    function WorkerFactory() {
      return w;
    }
    const { createJobQueue } = require('../src/code-index/job-queue'),
      q = createJobQueue({ Worker: WorkerFactory, jobStore: {}, deps: {} });
    q.startJob(7, { repoName: 'foo' });
    await q.cancel(7);
    expect(w.terminateCalls).toBe(1);
    expect(q.getStatus(7)).toBe('cancelled');
  });
});
