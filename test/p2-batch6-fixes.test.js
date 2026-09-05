// Regression tests for review batch 6: #293 (cochange quadratic blowup +
// unbuffered git log), #294 (deferred full-index batches no longer buffer
// raw file content), and #295 (index cancellation actually works; repo
// locks are thread-aware). Uses an isolated temp DB.
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');

process.env.LAPIS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-p2-batch6-'));

describe('#293 cochange-builder caps quadratic pair generation', () => {
  const {
    parseGitLogForCochange,
    processCommitFiles,
    MAX_FILES_PER_COMMIT,
  } = require('../src/code-analysis/cochange-builder');

  it('skips pair generation for commits touching more than the cap', () => {
    expect(MAX_FILES_PER_COMMIT).toBe(50);
    const bigCommit = Array.from({ length: 60 }, (_, i) => `file${i}.js`),
      pairs = {};
    processCommitFiles(bigCommit, pairs);
    expect(Object.keys(pairs)).toHaveLength(0);
  });

  it('still pairs commits at or under the cap', () => {
    const pairs = {};
    processCommitFiles(['a.js', 'b.js', 'c.js'], pairs);
    expect(Object.keys(pairs)).toHaveLength(3); // C(3,2)
    expect(pairs['a.js::b.js']).toBe(1);
  });

  it('parses mixed logs with oversized and normal commits', () => {
    const bigCommit = Array.from({ length: 80 }, (_, i) => `f${i}.js`).join('\n'),
      log = `COMMIT:abc\n${bigCommit}\nCOMMIT:def\nx.js\ny.js\n`,
      pairs = parseGitLogForCochange(log);
    expect(pairs).toEqual({ 'x.js::y.js': 1 });
  });

  it('buffers git log output (maxBuffer) in cochange and git-analysis builders', () => {
    const fsMod = require('node:fs');
    const cochange = fsMod.readFileSync('src/code-analysis/cochange-builder.js', 'utf8');
    expect(cochange).toMatch(/maxBuffer: 10 \* 1024 \* 1024/);
    expect(cochange).toMatch(/db\.transaction\(/);
    const gitAnalysis = fsMod.readFileSync('git-analysis.js', 'utf8');
    const buffers = gitAnalysis.match(/maxBuffer: 10 \* 1024 \* 1024/g) || [];
    expect(buffers.length).toBeGreaterThanOrEqual(5);
  });
});

describe('#294 deferred batches carry no raw file content', () => {
  it('parsePhase buffers precomputed entries without record.content', async () => {
    const incremental = require('../src/code-index/incremental-indexer'),
      { createParserRegistry } = require('../src/code-index/parser-registry'),
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-defer-'));
    try {
      for (const name of ['a.js', 'b.js']) {
        fs.writeFileSync(path.join(dir, name), 'function sample() {\n  return 1;\n}\n');
      }
      const registry = createParserRegistry();
      expect(await registry.ensureReady()).toBe(true);

      const result = await incremental.parsePhase(
        [path.join(dir, 'a.js'), path.join(dir, 'b.js')],
        { parserRegistry: registry, repository: { upsertFileDiagnostic: () => {} } },
        'repo-1',
        { deferIndexWrites: true, noWorkers: true },
      );

      expect(result.fileCount).toBe(2);
      const batch = result.deferredBatches[0];
      expect(batch).toHaveLength(2);
      for (const entry of batch) {
        expect(entry.deferred).toBe(true);
        expect(entry.record).toBeUndefined(); // raw content dropped
        expect(entry.fileParams.path.endsWith('.js')).toBe(true);
        expect(entry.fileParams.contentHash).toBeTruthy();
        expect(entry.hotSymbols.length).toBeGreaterThan(0);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});

describe('#295 index cancellation and thread-aware locks', () => {
  it('emitProgress lets the cancellation sentinel propagate but swallows ordinary errors', () => {
    const { emitProgress, CANCELLED } = require('../src/code-index/incremental-indexer');
    expect(typeof CANCELLED).toBe('string');
    expect(() =>
      emitProgress(
        {
          onProgress: () => {
            throw CANCELLED;
          },
        },
        'p',
        {},
        {},
      ),
    ).toThrow(CANCELLED);
    expect(() =>
      emitProgress(
        {
          onProgress: () => {
            throw new Error('ordinary callback bug');
          },
        },
        'p',
        {},
        {},
      ),
    ).not.toThrow();
  });

  it('cancel posts the cancel message and terminates after the grace window', async () => {
    const { EventEmitter } = require('events');

    class StubWorker extends EventEmitter {
      constructor(behavior) {
        super();
        this.threadId = 5;
        this.postMessage = (msg) => behavior.onPostMessage && behavior.onPostMessage(msg);
        this.terminateCalls = 0;
        this.terminate = () => {
          this.terminateCalls++;
          return Promise.resolve(0);
        };
      }
    }

    // Cooperative: worker exits on its own after receiving the message.
    const cooperative = new StubWorker({
      onPostMessage: (msg) => {
        if (msg.type === 'cancel') {
          queueMicrotask(() => cooperative.emit('exit', 0));
        }
      },
    });
    const { createJobQueue } = require('../src/code-index/job-queue');
    function WorkerFactory() {
      return cooperative;
    }
    const q1 = createJobQueue({ Worker: WorkerFactory, jobStore: {}, deps: {}, cancelGraceMs: 500 });
    q1.startJob(1, {});
    await q1.cancel(1);
    expect(cooperative.terminateCalls).toBe(0);
    expect(q1.getStatus(1)).toBe('cancelled');

    // Stalled: worker never exits → terminated, and its thread's repo locks
    // are cleaned up.
    const sqlRunCalls = [],
      stalled = new StubWorker({});
    function StalledFactory() {
      return stalled;
    }
    const q2 = createJobQueue({
      Worker: StalledFactory,
      jobStore: {},
      deps: { sqlRun: (q, p) => sqlRunCalls.push([q, p]) },
      cancelGraceMs: 50,
    });
    q2.startJob(2, {});
    await q2.cancel(2);
    expect(stalled.terminateCalls).toBe(1);
    expect(sqlRunCalls[0][0]).toContain('repo_index_locks');
    expect(sqlRunCalls[0][1][0]).toBe(`${process.pid}:5%`);
  });

  it('repo-lock holder ids embed pid and threadId, and the prefix cleanup deletes only matching rows', () => {
    const dbModule = require('../db'),
      repoLock = require('../src/code-index/repo-lock');
    dbModule.ensureDb();

    const holderId = repoLock.makeHolderId();
    expect(holderId).toMatch(/^\d+:\d+:[0-9a-f]+$/);

    dbModule.sqlRun("INSERT INTO repo_index_locks (repo_name, holder_id, host) VALUES ('r5', ?, 'h'), ('r6', ?, 'h')", [
      `${process.pid}:5:aaaa`,
      `${process.pid}:6:bbbb`,
    ]);
    repoLock.releaseLocksForHolderPrefix(dbModule.sqlRun, `${process.pid}:5`);
    expect(
      dbModule
        .sqlJson('SELECT repo_name FROM repo_index_locks WHERE repo_name IN (?, ?)', ['r5', 'r6'])
        .map((r) => r.repo_name),
    ).toEqual(['r6']);
    dbModule.sqlRun('DELETE FROM repo_index_locks WHERE repo_name = ?', ['r6']);
  });

  it('services/code-indexing exposes cancelIndexJobInternal', () => {
    const service = require('../services/code-indexing');
    expect(typeof service.cancelIndexJobInternal).toBe('function');
  });
});
