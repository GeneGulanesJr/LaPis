// In-process job registry. Owns the active `Worker` per jobId and serializes
// status queries. Designed for long-running, one-worker-per-job model —
// indexing is I/O/SQLite-bound, not CPU-bound, so pooling adds complexity for
// no real throughput gain.

const path = require('path');
const { Worker } = require('worker_threads');
const { EventEmitter } = require('events');

const WORKER_SCRIPT = path.resolve(__dirname, 'index-worker.js');

function createJobQueue({ Worker: WorkerCtor = Worker, jobStore, deps }) {
  const workers = new Map(); // jobId -> { worker, status }
  const emitter = new EventEmitter();

  function startJob(jobId, payload) {
    const worker = new WorkerCtor(WORKER_SCRIPT, {
      workerData: { jobId, ...payload },
    });
    workers.set(jobId, { worker, status: 'running' });
    worker.on('message', (msg) => {
      emitter.emit(`progress:${jobId}`, msg);
      if (msg && msg.type === 'done') { markDone(jobId, msg); }
      if (msg && msg.type === 'error') { markError(jobId, msg); }
      if (msg && msg.type === 'cancelled') { markCancelled(jobId, msg); }
    });
    worker.on('error', (err) => markError(jobId, { error: err.message }));
    worker.on('exit', (code) => {
      const entry = workers.get(jobId);
      if (entry && entry.status === 'running') {
        // Unexpected exit (worker died without sending 'done' or 'error')
        entry.status = code === 0 ? 'completed' : 'error';
        try {
          jobStore.completeJob(deps, jobId, {
            status: entry.status,
            error: entry.status === 'error' ? `worker exited with code ${code}` : undefined,
          });
        } catch (_) { /* best-effort */ }
      }
    });
    return { worker };
  }

  function getWorker(jobId) { return workers.get(jobId)?.worker; }
  function getStatus(jobId) { return workers.get(jobId)?.status || 'unknown'; }
  function on(jobId, event, listener) { emitter.on(event, listener); }

  function markDone(jobId, _msg) {
    const entry = workers.get(jobId);
    if (entry) entry.status = 'completed';
  }

  function markError(jobId, msg) {
    const entry = workers.get(jobId);
    if (entry) {
      entry.status = 'error';
      try { jobStore.completeJob(deps, jobId, { status: 'error', error: msg.error || 'unknown' }); } catch (_) { /* best-effort */ }
    }
  }

  function markCancelled(jobId, _msg) {
    const entry = workers.get(jobId);
    if (entry) entry.status = 'cancelled';
  }

  async function cancel(jobId) {
    const entry = workers.get(jobId);
    if (!entry) return false;
    try { await entry.worker.terminate(); } catch (_) { /* ignore */ }
    entry.status = 'cancelled';
    try { jobStore.completeJob(deps, jobId, { status: 'cancelled' }); } catch (_) { /* best-effort */ }
    return true;
  }

  return { startJob, getWorker, getStatus, on, cancel, markDone };
}

module.exports = { createJobQueue };
