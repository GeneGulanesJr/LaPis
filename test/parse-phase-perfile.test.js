// Regression tests for issue #286: one file that makes symbol extraction
// throw aborted the entire full index — the sequential fallback loop had no
// per-file guard, so a single RangeError from a pathological file failed the
// whole run. Extraction failures must now be isolated per file.
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');

describe('parsePhase sequential per-file guard (#286)', () => {
  it('skips a throwing file with an error diagnostic and still parses the rest', async () => {
    const incremental = require('../src/code-index/incremental-indexer'),
      { createParserRegistry } = require('../src/code-index/parser-registry'),
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-parse-phase-'));
    try {
      for (const name of ['good1.js', 'boom.js', 'good2.js']) {
        fs.writeFileSync(path.join(dir, name), 'function example() {\n  return 1;\n}\n');
      }

      const realRegistry = createParserRegistry();
      expect(await realRegistry.ensureReady()).toBe(true);
      // A plain delegating wrapper (not a Proxy — the real registry's methods
      // are non-configurable, which breaks Proxy invariants): any call that
      // receives the boom file path throws, simulating the pathological-file
      // RangeError from the issue without depending on tree-sitter internals.
      const registry = {};
      for (let obj = realRegistry; obj && obj !== Object.prototype; obj = Object.getPrototypeOf(obj)) {
        for (const key of Object.getOwnPropertyNames(obj)) {
          if (key === 'constructor' || key in registry) {
            continue;
          }
          const d = Object.getOwnPropertyDescriptor(obj, key);
          if (typeof d.value === 'function') {
            registry[key] = function (...args) {
              if (args.some((a) => typeof a === 'string' && a.endsWith('boom.js'))) {
                throw new Error('simulated parser crash');
              }
              return d.value.apply(realRegistry, args);
            };
          } else if (d.get) {
            Object.defineProperty(registry, key, { get: () => realRegistry[key], configurable: true });
          } else {
            registry[key] = d.value;
          }
        }
      }

      const diagnostics = [],
        repository = {
          upsertFileDiagnostic: (d) => diagnostics.push(d),
          insertFile: () => 1,
          insertSymbolBulk: () => {},
          insertSymbolBatch: () => {},
          insertSymbol: () => {},
        },
        result = await incremental.parsePhase(
          [path.join(dir, 'good1.js'), path.join(dir, 'boom.js'), path.join(dir, 'good2.js')],
          { parserRegistry: registry, repository },
          'repo-1',
          {}, // store mode: the error diagnostic must be recorded immediately
        );

      expect(result.fileCount).toBe(2);
      const boomSkip = result.skipped.find((s) => s.file.endsWith('boom.js'));
      expect(boomSkip).toBeDefined();
      expect(boomSkip.error).toContain('simulated parser crash');
      const boomDiag = diagnostics.find((d) => d.filePath.endsWith('boom.js'));
      expect(boomDiag.status).toBe('error');
      expect(boomDiag.message).toContain('simulated parser crash');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('parse-worker is require-able from the main thread and isolates per file', () => {
    // The parentPort guard keeps the worker module side-effect-free when
    // loaded outside a worker thread; parseFiles is the same per-file guard
    // the worker message handler uses.
    const worker = require('../src/code-index/parse-worker');
    expect(typeof worker.parseFiles).toBe('function');
    const results = worker.parseFiles([{ filePath: '/repo/good.js', content: 'function f() {\n}\n' }]);
    expect(results).toHaveLength(1);
    expect(results[0].filePath).toBe('/repo/good.js');
    expect(results[0].error).toBeUndefined();
  });
});
