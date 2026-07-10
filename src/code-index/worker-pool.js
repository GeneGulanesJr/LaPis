const { Worker } = require('worker_threads');
const os = require('os');
const path = require('path');
const { WORKER_POOL } = require('../../constants');

const WORKER_SCRIPT = path.resolve(__dirname, 'parse-worker.js');

class ParsePool {
  constructor(numWorkers) {
    this.workers = [];
    this.pendingMessages = new Map();
    this.nextId = 0;
    this.numWorkers = Math.min(numWorkers || Math.max(os.cpus().length - 1, 1), WORKER_POOL.MAX_WORKERS);
  }

  async init() {
    const initPromises = [];
    for (let i = 0; i < this.numWorkers; i++) {
      initPromises.push(this._spawnWorker());
    }
    await Promise.all(initPromises);
  }

  _spawnWorker() {
    return new Promise((resolve, reject) => {
      const worker = new Worker(WORKER_SCRIPT);
      const onError = (err) => {
        reject(err);
      };
      worker.on('error', onError);
      worker.once('message', (msg) => {
        if (msg.type === 'ready') {
          worker.removeListener('error', onError);
          worker.on('message', (m) => this._handleMessage(m));
          worker.on('error', (err) => this._handleError(err));
          // A worker can exit abnormally without an 'error' event (OOM abort,
          // uncaught exception, process.exit). Without this handler any pending
          // _sendBatch promise for this worker never settles and parseAll's
          // Promise.all hangs forever. Reject pending work and drop the worker.
          worker.on('exit', (code) => {
            if (code !== 0) {
              this._handleWorkerGone(worker, new Error(`parse worker exited with code ${code}`));
            }
          });
          resolve(worker);
        } else if (msg.type === 'error') {
          worker.removeListener('error', onError);
          reject(new Error(msg.error));
        }
      });
      this.workers.push(worker);
    });
  }

  _handleMessage(msg) {
    if (msg.type === 'results') {
      const pending = this.pendingMessages.get(msg.id);
      if (pending) {
        this.pendingMessages.delete(msg.id);
        pending.resolve(msg.results);
      }
    }
  }

  _handleError(err) {
    for (const [id, pending] of this.pendingMessages) {
      this.pendingMessages.delete(id);
      pending.reject(err);
    }
  }

  // Called when a worker exits unexpectedly. Rejects only that worker's
  // pending messages (unlike _handleError, which rejects everything) and
  // removes it from the pool so terminate() doesn't double-terminate it.
  _handleWorkerGone(worker, err) {
    this.workers = this.workers.filter((w) => w !== worker);
    for (const [id, pending] of this.pendingMessages) {
      this.pendingMessages.delete(id);
      pending.reject(err);
    }
  }

  async parseAll(fileRecords) {
    if (fileRecords.length === 0) {
      return [];
    }

    const workerCount = this.workers.length;
    const perWorker = Math.ceil(fileRecords.length / workerCount);
    const batches = [];
    for (let i = 0; i < fileRecords.length; i += perWorker) {
      batches.push(fileRecords.slice(i, i + perWorker));
    }

    const promises = batches.map((batch, i) => this._sendBatch(i % workerCount, batch));
    const allResults = await Promise.all(promises);
    return allResults.flat();
  }

  _sendBatch(workerIndex, files) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const worker = this.workers[workerIndex];
      this.pendingMessages.set(id, { resolve, reject });
      worker.postMessage({ type: 'parse', id, files });
    });
  }

  async terminate() {
    for (const worker of this.workers) {
      try {
        worker.postMessage({ type: 'shutdown' });
      } catch {}
    }
    await Promise.all(this.workers.map((w) => w.terminate().catch(() => {})));
    this.workers = [];
    this.pendingMessages.clear();
  }
}

async function createParsePool(numWorkers) {
  const pool = new ParsePool(numWorkers);
  await pool.init();
  return pool;
}

module.exports = { ParsePool, createParsePool };
