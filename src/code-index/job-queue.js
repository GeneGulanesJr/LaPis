// In-process job registry. Owns the active `Worker` per jobId and serializes
// Status queries. Designed for long-running, one-worker-per-job model —
// Indexing is I/O/SQLite-bound, not CPU-bound, so pooling adds complexity for
// No real throughput gain.

const path = require('path'),
  { Worker } = require('worker_threads'),
  { EventEmitter } = require('events'),
  WORKER_SCRIPT = path.resolve(__dirname, 'index-worker.js');

const CANCEL_GRACE_MS = 3000;

function createJobQueue({ Worker: WorkerCtor = Worker, jobStore, deps, cancelGraceMs = CANCEL_GRACE_MS }) {
  const workers = new Map(), // JobId -> { worker, status }
    emitter = new EventEmitter();

  function startJob(jobId, payload) {
    const worker = new WorkerCtor(WORKER_SCRIPT, {
      workerData: { jobId, ...payload },
    });
    workers.set(jobId, { worker, status: 'running' });
    worker.on('message', (msg) => {
      emitter.emit(`progress:${jobId}`, msg);
      if (msg && msg.type === 'done') {
        markDone(jobId, msg);
      }
      if (msg && msg.type === 'error') {
        markError(jobId, msg);
      }
      if (msg && msg.type === 'cancelled') {
        markCancelled(jobId, msg);
      }
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
        } catch {
          /* Best-effort */
        }
      }
    });
    return { worker };
  }

  function getWorker(jobId) {
    return workers.get(jobId)?.worker;
  }
  function getStatus(jobId) {
    return workers.get(jobId)?.status || 'unknown';
  }
  function on(jobId, event, listener) {
    emitter.on(event, listener);
  }

  function markDone(jobId, _msg) {
    const entry = workers.get(jobId);
    if (entry) {
      entry.status = 'completed';
    }
  }

  function markError(jobId, msg) {
    const entry = workers.get(jobId);
    if (entry) {
      entry.status = 'error';
      try {
        jobStore.completeJob(deps, jobId, { status: 'error', error: msg.error || 'unknown' });
      } catch {
        /* Best-effort */
      }
    }
  }

  function markCancelled(jobId, _msg) {
    const entry = workers.get(jobId);
    if (entry) {
      entry.status = 'cancelled';
    }
  }

  async function cancel(jobId) {
    const entry = workers.get(jobId);
    if (!entry) {
      return false;
    }
    // Ask the worker to cancel cooperatively first (postMessage → the
    // Worker's onProgress hook aborts the index and its repo lock is
    // Released by the normal finally path). Previously cancel() only called
    // Terminate(), which killed the thread with the lock held — and because
    // Worker threads share the parent pid, the stranded lock looked alive
    // And stalled every future index of that repo (#295).
    try {
      entry.worker.postMessage({ type: 'cancel' });
    } catch {
      /* Ignore */
    }
    const exitedCleanly = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), cancelGraceMs);
      entry.worker.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!exitedCleanly) {
      try {
        await entry.worker.terminate();
      } catch {
        /* Ignore */
      }
      // The terminated thread never ran its finally: drop any repo locks it
      // Still holds. Worker threads share the parent pid, so the holder
      // Prefix must also match this worker's threadId.
      if (typeof entry.worker.threadId === 'number' && typeof deps?.sqlRun === 'function') {
        try {
          const { releaseLocksForHolderPrefix } = require('./repo-lock');
          releaseLocksForHolderPrefix(deps.sqlRun, `${process.pid}:${entry.worker.threadId}`);
        } catch {
          /* Best-effort */
        }
      }
    }
    entry.status = 'cancelled';
    try {
      jobStore.completeJob(deps, jobId, { status: 'cancelled' });
    } catch {
      /* Best-effort */
    }
    return true;
  }

  return { startJob, getWorker, getStatus, on, cancel, markDone };
}

module.exports = { createJobQueue };
