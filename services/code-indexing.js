const { createParserRegistry } = require('../src/code-index/parser-registry'),
  { getCodeRepoHealth, indexRepository, reindexRepository } = require('../src/code-index/incremental-indexer'),
  { createJobQueue } = require('../src/code-index/job-queue'),
  jobStore = require('../src/code-index/job-store');

function parseCodeFile(filePath) {
  return createParserRegistry().parseFile(filePath);
}

async function ensureParserAvailable() {
  return createParserRegistry().ensureReady();
}

async function indexRepoInternal(deps, repoPath, repoName) {
  return indexRepository(deps, repoPath, repoName);
}

async function reindexRepoInternal(deps, repo, mode) {
  return reindexRepository(deps, repo, mode);
}

async function codeRepoHealthInternal(deps, repo) {
  return getCodeRepoHealth(deps, repo);
}

// In-process job queue, keyed by the worker's lifecycle. One queue per
// Node process — the worker thread handles concurrency at the SQLite level.
let _queue = null;
function getQueue() {
  if (!_queue) {
    const dbModule = require('../db');
    _queue = createJobQueue({ jobStore, deps: { sqlJson: dbModule.sqlJson, sqlRun: dbModule.sqlRun } });
  }
  return _queue;
}

async function indexRepoAsyncInternal(deps, repoPath, repoName, options = {}) {
  const { scanRepository } = require('../src/code-index/scanner'),
    dbModule = require('../db'),
    scan = scanRepository(repoPath, { ignore: [], respectGitignore: true }),
    filesTotal = scan && scan.files ? scan.files.length : 0,
    mode = options.mode || 'full',
    storeDeps = { sqlJson: dbModule.sqlJson, sqlRun: dbModule.sqlRun },
    jobId = jobStore.createJob(storeDeps, { repoName, mode, filesTotal }),
    queue = getQueue();

  queue.startJob(jobId, { repoName, repoPath, mode });
  return { jobId, filesTotal, status: 'running' };
}

function indexStatusInternal(jobId) {
  const dbModule = require('../db'),
    storeDeps = { sqlJson: dbModule.sqlJson, sqlRun: dbModule.sqlRun };
  return jobStore.getJob(storeDeps, jobId);
}

async function cancelIndexJobInternal(jobId) {
  return getQueue().cancel(jobId);
}

function listIndexJobsInternal({ onlyRunning = false, limit = 20 } = {}) {
  const dbModule = require('../db'),
    storeDeps = { sqlJson: dbModule.sqlJson, sqlRun: dbModule.sqlRun };
  return onlyRunning ? jobStore.listRunningJobs(storeDeps) : jobStore.listRecentJobs(storeDeps, limit);
}

module.exports = {
  parseCodeFile,
  ensureParserAvailable,
  indexRepoInternal,
  reindexRepoInternal,
  codeRepoHealthInternal,
  indexRepoAsyncInternal,
  cancelIndexJobInternal,
  indexStatusInternal,
  listIndexJobsInternal,
};
