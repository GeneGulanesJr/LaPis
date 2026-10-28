// #390: the worker branch of parsePhase (50+ files) must store the same cold
// Symbol fields (summary, hash, keywords, call refs) as the sequential branch.
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  { WORKER_POOL } = require('../constants');

describe('parsePhase worker vs sequential cold fields (#390)', () => {
  it('produces identical cold symbols', async () => {
    const { parsePhase } = require('../src/code-index/incremental-indexer'),
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-390-')),
      files = [];
    try {
      for (let i = 0; i < WORKER_POOL.MIN_FILES_FOR_PARALLEL; i++) {
        const f = path.join(dir, `f${i}.js`);
        fs.writeFileSync(f, `function helper${i}() { return ${i}; }\nfunction main${i}() { return helper${i}(); }\n`);
        files.push(f);
      }
      const { createParserRegistry } = require('../src/code-index/parser-registry'),
        parserRegistry = createParserRegistry(),
        repository = { upsertFileDiagnostic: () => {} },
        run = async (extra) => {
          const messages = [],
            r = await parsePhase(files, { repository, parserRegistry }, 'r', {
              deferIndexWrites: true,
              onProgress: (p) => messages.push(p.message || ''),
              ...extra,
            }),
            cold = new Map(r.deferredBatches.flat().map((e) => [e.filePath, e.coldSymbols]));
          return { cold, messages };
        },
        ready = await parserRegistry.ensureReady(),
        workers = await run({}),
        sequential = await run({ noWorkers: true });

      expect(ready).toBe(true);
      // Guard: the first run must really have used worker threads.
      expect(workers.messages.some((m) => /worker threads/.test(m))).toBe(true);
      expect(workers.messages.some((m) => /retrying this batch sequentially/.test(m))).toBe(false);

      const sample = workers.cold.get(files[0]);
      expect(sample).toHaveLength(2);
      expect(sample[0].summary).not.toBe('');
      expect(sample[0].content_hash).not.toBe('');
      expect(sample.find((s) => s.call_references_json.includes('helper0'))).toBeDefined();
      for (const f of files) {
        expect(workers.cold.get(f)).toEqual(sequential.cold.get(f));
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
