// Worker thread entry point. Runs an async code-indexing job and posts
// Progress/done/error messages back to the parent (the CLI process).
//
// Connects to the same SQLite database file as the parent — SQLite WAL mode
// Allows multiple readers + one writer concurrently, so the worker's writes
// To the index_jobs ledger never block the parent's status queries.

const { parentPort, workerData } = require('worker_threads');
const dbModule = require('../../db');
const { indexRepository, reindexRepository } = require('./incremental-indexer');
const { getLanguageForFile } = require('./parser-registry');
const jobStore = require('./job-store');

let cancelled = false;
parentPort.on('message', (msg) => {
  if (msg && msg.type === 'cancel') {
    cancelled = true;
  }
});

function safeGetLanguage(filePath) {
  try {
    return getLanguageForFile(filePath);
  } catch (_) {
    return null;
  }
}

function emit(type, payload = {}) {
  parentPort.postMessage({ type, ...payload });
}

async function main() {
  const { jobId, mode, repoPath, repoName } = workerData;

  try {
    // Open the database. ensureDb() is idempotent; it migrates the schema
    // (including the V18 index_jobs table) before we touch it.
    dbModule.ensureDb();
    const rawDb = dbModule.getDb(),
      deps = { sqlJson: dbModule.sqlJson, sqlRun: dbModule.sqlRun },
      languageCounters = new Map();
    let lastWrite = 0;
    const writeThrottleMs = 1000;

    function onProgress({ phase, files_total, files_done, current_file, language }) {
      if (cancelled) {
        throw new Error('cancelled');
      }
      // Derive language from current_file if not provided by the indexer.
      const lang = language || (current_file ? safeGetLanguage(current_file) : null);
      if (lang) {
        languageCounters.set(lang, (languageCounters.get(lang) || 0) + 1);
      }
      const now = Date.now();
      // Throttle SQLite writes — at most once per second, plus a final write at completion.
      if (now - lastWrite >= writeThrottleMs || (files_total && files_done >= files_total)) {
        try {
          jobStore.updateProgress(deps, jobId, {
            filesDone: files_done || 0,
            currentFile: current_file,
            languageBreakdown: Object.fromEntries(languageCounters),
          });
        } catch (_) {
          /* Best-effort */
        }
        lastWrite = now;
      }
      emit('progress', { phase, files_total, files_done, current_file, language });
    }

    // We pass the raw better-sqlite3 handle as `db` because the indexer
    // Uses db.exec/db.prepare/db.transaction directly. `args.onProgress` is
    // The new hook Task 4 wires through emitProgress.
    const indexerDeps = { db: rawDb, args: { onProgress, filesTotal: 0 } };
    let result;
    if (mode === 'incremental') {
      result = await reindexRepository(indexerDeps, repoName, 'incremental');
    } else {
      // Default to full re-index when mode is 'full' or unspecified.
      result = await indexRepository(indexerDeps, repoPath, repoName);
    }

    if (cancelled) {
      try {
        jobStore.completeJob(deps, jobId, { status: 'cancelled' });
      } catch (_) {}
      emit('cancelled');
      return;
    }

    // Final progress write with the complete language breakdown.
    try {
      jobStore.updateProgress(deps, jobId, {
        filesDone: (result && (result.file_count || result.filesIndexed || result.fileCount)) || 0,
        languageBreakdown: Object.fromEntries(languageCounters),
      });
      jobStore.completeJob(deps, jobId, { status: result?.error ? 'error' : 'completed', error: result?.error });
    } catch (_) {
      /* Best-effort */
    }

    emit('done', { result, languageBreakdown: Object.fromEntries(languageCounters) });
  } catch (e) {
    const status = cancelled ? 'cancelled' : 'error';
    try {
      const deps = { sqlJson: dbModule.sqlJson, sqlRun: dbModule.sqlRun };
      jobStore.completeJob(deps, jobId, { status, error: e.message });
    } catch (_) {}
    if (cancelled) {
      emit('cancelled');
    } else {
      emit('error', { error: e.message });
    }
  } finally {
    process.exit(0);
  }
}

main().catch((e) => {
  emit('error', { error: e.message });
  process.exit(1);
});
