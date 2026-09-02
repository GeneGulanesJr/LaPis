const fs = require('fs'), os = require('os'), path = require('path'), { getLanguageForFile, canParseFile } = require('../src/code-index/parser-registry'), { normalizeSymbol, extractSymbolsFromFile } = require('../src/code-index/symbol-extractor'), { sourceSliceFromRow } = require('../src/code-index/source-retrieval'), { parsePhase, reindexRepository } = require('../src/code-index/incremental-indexer'), { scanRepository } = require('../src/code-index/scanner'), { createCodeIndexRepository } = require('../src/code-index/repos'), { hashContent } = require('../utils');










describe('code-index parser registry', () => {
  it('maps supported file extensions to parser languages', () => {
    expect(getLanguageForFile('/repo/app.js')).toBe('javascript');
    expect(getLanguageForFile('/repo/app.jsx')).toBe('javascript');
    expect(getLanguageForFile('/repo/app.tsx')).toBe('typescript');
    expect(getLanguageForFile('/repo/main.py')).toBe('python');
    expect(getLanguageForFile('/repo/main.go')).toBe('go');
    expect(getLanguageForFile('/repo/main.rs')).toBe('rust');
    expect(getLanguageForFile('/repo/README.md')).toBeNull();
  });

  it('only reports bundled code extensions as parseable', () => {
    expect(canParseFile('/repo/app.cjs')).toBe(true);
    expect(canParseFile('/repo/notes.txt')).toBe(false);
  });
});

describe('code-index parse progress', () => {
  it('reports what parsing sub-step is currently running', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-parse-progress-')),
      filePath = path.join(tmp, 'app.js'), progress = [],
      originalWrite = process.stderr.write;
    fs.writeFileSync(filePath, 'function app() { return 1; }');
    
    process.stderr.write = (chunk, encoding, cb) => {
      progress.push(JSON.parse(String(chunk)));
      if (typeof cb === 'function') {
        cb();
      }
      return true;
    };

    try {
      await parsePhase(
        [filePath],
        {
          parserRegistry: {
            canParseFile: () => true,
            parseContent: () => [
              {
                name: 'app',
                kind: 'function',
                signature: 'function app()',
                qualified_name: 'app',
                start_line: 1,
                end_line: 1,
                start_byte: 0,
                end_byte: 28,
                language: 'javascript',
              },
            ],
          },
          repository: {
            withTransaction: (fn) => fn(),
            insertFile: () => 123,
            insertSymbol: () => {},
            insertSymbolBulk: () => {},
          },
        },
        7,
        { progress: true, repoRoot: tmp, noWorkers: true },
      );
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(progress.map((p) => p.step)).toEqual(
      expect.arrayContaining(['read-files', 'extract-symbols', 'store-index']),
    );
    expect(progress.some((p) => p.current_file === 'app.js')).toBe(true);
  });
});

describe('code-index symbol extractor', () => {
  it('normalizes optional parser fields without losing byte ranges', () => {
    const normalized = normalizeSymbol(
      {
        name: 'main',
        kind: 'function',
        start_line: 1,
        end_line: 3,
        start_byte: 0,
        end_byte: 30,
        language: 'javascript',
      },
      '/repo/app.js',
    );

    expect(normalized).toMatchObject({
      file_path: '/repo/app.js',
      name: 'main',
      qualified_name: 'main',
      docstring: '',
      body_preview: '',
      parent_name: '',
      start_byte: 0,
      end_byte: 30,
    });
  });

  it('enriches symbols with stable metadata and call references', () => {
    const source = 'function helper() { return 1; }\nfunction main() { return helper(); }\n',
      registry = {
        canParseFile: () => true,
        parseContent: () => [
          {
            name: 'main',
            kind: 'function',
            signature: 'function main()',
            qualified_name: 'main',
            start_line: 2,
            end_line: 2,
            start_byte: Buffer.byteLength('function helper() { return 1; }\n'),
            end_byte: Buffer.byteLength(source),
            language: 'javascript',
          },
        ],
        extractCalleesFromContent: () => [{ callee: 'helper', full_path: 'helper', line: 2 }],
      },
      [symbol] = extractSymbolsFromFile('/repo/app.js', registry, source);

    expect(symbol.stable_symbol_id).toBe('/repo/app.js::main#function');
    expect(symbol.content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(symbol.call_references_json)).toEqual(['helper']);
    expect(JSON.parse(symbol.keywords_json)).toContain('main');
    expect(symbol.summary).toBe('function main()');
  });

  it('extracts symbols through the parser registry abstraction', () => {
    const registry = {
      canParseFile: () => true,
      parseFile: () => [
        {
          name: 'answer',
          kind: 'function',
          signature: 'function answer()',
          qualified_name: 'answer',
          start_line: 1,
          end_line: 1,
          start_byte: 0,
          end_byte: 20,
          language: 'javascript',
        },
      ],
    };

    expect(extractSymbolsFromFile('/repo/app.js', registry)).toHaveLength(1);
    expect(extractSymbolsFromFile('/repo/app.js', registry)[0].name).toBe('answer');
  });
});

describe('code-index repository clearing', () => {
  it('clears derived index rows with direct DELETE statements and emits progress', () => {
    const calls = [],
      progress = [],
      repository = createCodeIndexRepository({
        sqlJson() {
          throw new Error('clearRepoIndex should not use sqlJson');
        },
        sqlRun(sql, params) {
          calls.push([sql, params]);
          const changes = {
              'DELETE FROM symbol_complexity WHERE symbol_id IN (SELECT id FROM code_symbols WHERE repo_id = ?)': 2,
              'DELETE FROM code_calls WHERE repo_id = ?': 1,
              'DELETE FROM code_imports WHERE repo_id = ?': 0,
              'DELETE FROM churn_metrics WHERE repo_id = ?': 0,
              'DELETE FROM code_file_diagnostics WHERE repo_id = ?': 1,
              'DELETE FROM scope_resolution WHERE binding_id IN (SELECT id FROM file_scope_bindings WHERE repo_id = ?)': 1,
              'DELETE FROM file_scope_bindings WHERE repo_id = ?': 1,
              'DELETE FROM code_symbols WHERE repo_id = ?': 1,
              'DELETE FROM code_files WHERE repo_id = ?': 1,
            },
            key = sql.replace(/\s+/g, ' ').trim();
          return { changes: changes[key] || 0 };
        },
        withTransaction(fn) {
          calls.push(['BEGIN']);
          const result = fn();
          calls.push(['COMMIT']);
          return result;
        },
      }),
      totals = repository.clearRepoIndex(42, { onProgress: (p) => progress.push(p.message) });

    expect(totals).toMatchObject({
      symbolComplexity: 2,
      calls: 1,
      diagnostics: 1,
      scopeResolution: 1,
      scopeBindings: 1,
      symbols: 1,
      files: 1,
    });
    expect(calls.map((call) => (Array.isArray(call) ? call[0] : call))).toEqual([
      'BEGIN',
      'DELETE FROM symbol_complexity WHERE symbol_id IN (SELECT id FROM code_symbols WHERE repo_id = ?)',
      'DELETE FROM code_calls WHERE repo_id = ?',
      'DELETE FROM code_imports WHERE repo_id = ?',
      'DELETE FROM churn_metrics WHERE repo_id = ?',
      'DELETE FROM code_file_diagnostics WHERE repo_id = ?',
      'DELETE FROM scope_resolution WHERE binding_id IN (SELECT id FROM file_scope_bindings WHERE repo_id = ?)',
      'DELETE FROM file_scope_bindings WHERE repo_id = ?',
      'DELETE FROM code_symbols WHERE repo_id = ?',
      'DELETE FROM code_files WHERE repo_id = ?',
      'COMMIT',
    ]);
    expect(progress).toContain('Clearing complexity rows...');
    expect(progress).toContain('Clearing symbols...');
  });
});

describe('code-index source retrieval', () => {
  it('slices source by UTF-8 byte offsets instead of JavaScript character offsets', () => {
    const content = 'const emoji = "💎";\nfunction target() { return emoji; }\n',
      expected = 'function target() { return emoji; }',
      startByte = Buffer.byteLength('const emoji = "💎";\n', 'utf-8'),
      endByte = startByte + Buffer.byteLength(expected, 'utf-8');

    expect(sourceSliceFromRow({ content, start_byte: startByte, end_byte: endByte })).toBe(expected);
  });
});

describe('code-index scanner hardening', () => {
  it('skips unsafe or noisy files and reports skip reasons', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-scan-hardening-')),
    result = (() => {

      fs.mkdirSync(path.join(tmp, 'src'));
      fs.writeFileSync(path.join(tmp, 'src', 'app.js'), 'function app() {}');
      fs.writeFileSync(path.join(tmp, '.env.js'), 'TOKEN=secret');
      fs.writeFileSync(path.join(tmp, 'large.js'), 'x'.repeat(128));
      fs.writeFileSync(path.join(tmp, 'binary.js'), Buffer.from([0, 1, 2, 3]));
  
      
  return (scanRepository(tmp, { maxFileSize: 32 }));
})(); expect(result.files.map((f) => path.basename(f))).toEqual(['app.js']);
    expect(result.skipReport.tooLarge).toBe(1);
    expect(result.skipReport.binary).toBe(1);
    expect(result.skipReport.secret).toBe(1);
  });

  it('skips lock files and auto-generated non-code files', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-scan-lock-')),
    result = (() => {

      fs.mkdirSync(path.join(tmp, 'src'));
      fs.writeFileSync(path.join(tmp, 'src', 'app.js'), 'function app() {}');
      fs.writeFileSync(path.join(tmp, 'package-lock.json'), '{}');
      fs.writeFileSync(path.join(tmp, 'package.json'), '{}');
      fs.writeFileSync(path.join(tmp, 'tsconfig.json'), '{}');
      fs.writeFileSync(path.join(tmp, 'pnpm-lock.yaml'), 'lockfileVersion: 1');
      fs.writeFileSync(path.join(tmp, 'Gemfile.lock'), 'GEM');
      fs.writeFileSync(path.join(tmp, 'poetry.lock'), '[metadata]');
      fs.writeFileSync(path.join(tmp, 'Cargo.lock'), '[package]');
      fs.writeFileSync(path.join(tmp, 'composer.lock'), '{}');
      fs.writeFileSync(path.join(tmp, 'go.sum'), 'module hash');
  
      
  return (scanRepository(tmp, {}));
})(); expect(result.files.map((f) => path.basename(f))).toEqual(['app.js']);
    expect(result.skipReport.lock).toBe(4);
    expect(result.skipReport.unsupportedExt).toBe(5);
  });
});

describe('code-index incremental reindexer', () => {
  it('uses content hashes instead of mtime alone when deciding changed files', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-hash-reindex-')),
      filePath = path.join(tmp, 'app.js');
    fs.writeFileSync(filePath, 'function app() { return 2; }');
    const stat = fs.statSync(filePath),
      calls = [],
      repository = {
        findRepoByName: () => ({ id: 7, name: 'repo', path: tmp }),
        listFiles: () => [{ id: 10, path: filePath, mtime: stat.mtimeMs, content_hash: 'stale-hash' }],
        clearFileSymbols: (fileId) => calls.push(['clearFileSymbols', fileId]),
        updateFile: (fileId, params) => calls.push(['updateFile', fileId, params.contentHash]),
        insertSymbol: (params) => calls.push(['insertSymbol', params.name]),
        insertSymbolBulk: (symbols) => {
          for (const s of symbols) {
            calls.push(['insertSymbol', s.name]);
          }
        },
        deleteFile: (fileId) => calls.push(['deleteFile', fileId]),
        updateRepoStats: (params) => calls.push(['updateRepoStats', params.repoId]),
        withTransaction: (fn) => fn(),
      },
      parserRegistry = {
        ensureReady: async () => true,
        canParseFile: () => true,
        parseContent: () => [
          {
            name: 'app',
            kind: 'function',
            signature: 'function app()',
            qualified_name: 'app',
            start_line: 1,
            end_line: 1,
            start_byte: 0,
            end_byte: 28,
            language: 'javascript',
          },
        ],
      },
      result = await reindexRepository({ db: {}, repository, parserRegistry, args: {} }, 'repo', 'incremental');

    expect(result.success).toBe(true);
    expect(result.files_checked).toBe(1);
    expect(result.files_hashed).toBe(1);
    expect(result.files_reindexed).toBe(1);
    expect(result.files_unchanged).toBe(0);
    expect(calls).toContainEqual(['clearFileSymbols', 10]);
    expect(calls).toContainEqual(['updateFile', 10, hashContent('function app() { return 2; }')]);
    expect(calls).toContainEqual(['insertSymbol', 'app']);
  });

  it('skips parsing when mtime changes but content hash is unchanged', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-hash-unchanged-')),
      filePath = path.join(tmp, 'app.js'),
      content = 'function app() { return 1; }';
    fs.writeFileSync(filePath, content);
    const calls = [],
      repository = {
        findRepoByName: () => ({ id: 7, name: 'repo', path: tmp }),
        listFiles: () => [{ id: 10, path: filePath, mtime: 1, content_hash: hashContent(content) }],
        clearFileSymbols: (fileId) => calls.push(['clearFileSymbols', fileId]),
        updateFile: (fileId) => calls.push(['updateFile', fileId]),
        insertSymbol: (params) => calls.push(['insertSymbol', params.name]),
        insertSymbolBulk: (symbols) => {
          for (const s of symbols) {
            calls.push(['insertSymbol', s.name]);
          }
        },
        deleteFile: (fileId) => calls.push(['deleteFile', fileId]),
        updateRepoStats: (params) => calls.push(['updateRepoStats', params.repoId]),
        withTransaction: (fn) => fn(),
      },
      parserRegistry = {
        ensureReady: async () => true,
        canParseFile: () => true,
        parseContent: () => {
          throw new Error('unchanged files should not be parsed');
        },
      },
      result = await reindexRepository({ db: {}, repository, parserRegistry, args: {} }, 'repo', 'incremental');

    expect(result.success).toBe(true);
    expect(result.files_reindexed).toBe(0);
    expect(result.files_unchanged).toBe(1);
    expect(calls).not.toContainEqual(['clearFileSymbols', 10]);
    expect(calls).not.toContainEqual(['updateFile', 10]);
  });

  it('removes deleted files through the CodeIndexRepository interface', async () => {
    const calls = [],
      repository = {
        findRepoByName: () => ({ id: 7, name: 'repo', path: '/definitely/missing/repo' }),
        listFiles: () => [{ id: 10, path: '/definitely/missing/repo/deleted.js', mtime: 1 }],
        deleteFile: (fileId) => calls.push(['deleteFile', fileId]),
        updateRepoStats: (params) => calls.push(['updateRepoStats', params.repoId]),
      },
      parserRegistry = { ensureReady: async () => true },
      result = await reindexRepository({ db: {}, repository, parserRegistry, args: {} }, 'repo', 'incremental');

    expect(result.success).toBe(true);
    expect(result.files_removed).toBe(1);
    expect(calls).toContainEqual(['deleteFile', 10]);
    expect(calls).toContainEqual(['updateRepoStats', 7]);
  });
});

describe('code-index scanner', () => {
  it('continues scanning after unsupported files and reports discovery progress', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-scan-'));
    fs.writeFileSync(path.join(tmp, 'README.md'), '# docs');
    fs.writeFileSync(path.join(tmp, 'app.js'), 'function app() { return 1; }');
    fs.writeFileSync(path.join(tmp, 'Component.jsx'), 'export function Component() { return <div />; }');
    const progress = [],
      result = scanRepository(tmp, { onScanProgress: (stats) => progress.push(stats) });

    expect(result.files.sort()).toEqual([path.join(tmp, 'Component.jsx'), path.join(tmp, 'app.js')].sort());
    expect(result.skipReport.unsupportedExt).toBe(1);
    expect(progress[progress.length - 1]).toMatchObject({ done: true, codeFiles: 2 });
    expect(progress.some((p) => p.currentPath === 'app.js' && p.currentKind === 'file')).toBe(true);
  });
});
