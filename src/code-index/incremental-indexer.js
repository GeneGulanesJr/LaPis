const fs = require('fs');
const path = require('path');
const { RESULT_LIMITS } = require('../../constants');
const { hashContent } = require('../../utils');
const { createCodeIndexRepository } = require('./repos');
const { scanRepository } = require('./scanner');
const { createParserRegistry, getLanguageForFile } = require('./parser-registry');
const { extractSymbolsFromFile } = require('./symbol-extractor');
const { buildImportEdges, buildCallEdges, buildComplexityMetrics } = require('./edge-extractor');

function emitProgress(args, phase, detail, stats) {
  if (!args || !args.progress) { return; }
  const payload = { progress: true, phase, ...detail };
  if (stats) {
    payload.files_total = stats.files_total;
    payload.files_done = stats.files_done;
    payload.symbols = stats.symbols;
  }
  process.stderr.write(JSON.stringify(payload) + '\n');
}

function getHeadCommit(repoPath) {
  try {
    return require('child_process')
      .execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf-8', timeout: 5000 })
      .trim();
  } catch (_) {
    return null;
  }
}

async function readFileRecord(filePath) {
  const [content, stats] = await Promise.all([
    fs.promises.readFile(filePath, 'utf-8'),
    fs.promises.stat(filePath),
  ]);
  return { filePath, content, stats };
}

function fileRecordToParams(repoId, record) {
  const lines = record.content.split('\n');
  return {
    repoId,
    path: record.filePath,
    language: getLanguageForFile(record.filePath) || path.extname(record.filePath).slice(1),
    content: record.content,
    contentHash: hashContent(record.content),
    mtime: record.stats.mtimeMs,
    sizeBytes: record.stats.size,
    lineCount: lines.length,
  };
}

function insertSymbols(repository, repoId, fileId, filePath, symbols) {
  let count = 0;
  for (const sym of symbols) {
    repository.insertSymbol({
      repoId,
      fileId,
      filePath,
      name: sym.name,
      kind: sym.kind,
      signature: sym.signature,
      qualifiedName: sym.qualified_name,
      startLine: sym.start_line,
      endLine: sym.end_line,
      startByte: sym.start_byte,
      endByte: sym.end_byte,
      docstring: sym.docstring || '',
      bodyPreview: sym.body_preview || '',
      language: sym.language,
      parentName: sym.parent_name || '',
    });
    count++;
  }
  return count;
}

function rebuildDerivedIndexes(db, repoId, args, totalFiles, fileCount, symbolCount) {
  emitProgress(args, 'analysis', { message: 'Building import graph...' }, { files_total: totalFiles, files_done: fileCount, symbols: symbolCount });

  let importEdges = 0;
  let callEdges = 0;
  let complexityCount = 0;
  try {
    const ig = buildImportEdges(db, repoId);
    if (ig.success) { importEdges = ig.edges; }
  } catch (_) {}
  emitProgress(args, 'analysis', { message: 'Building call graph...' }, { files_total: totalFiles, files_done: fileCount, symbols: symbolCount });
  try {
    const cg = buildCallEdges(db, repoId);
    if (cg.success) { callEdges = cg.calls; }
  } catch (_) {}
  emitProgress(args, 'analysis', { message: 'Computing complexity...' }, { files_total: totalFiles, files_done: fileCount, symbols: symbolCount });
  try {
    const cc = buildComplexityMetrics(db, repoId);
    if (cc.success) { complexityCount = cc.symbols; }
  } catch (_) {}

  return { importEdges, callEdges, complexityCount };
}

async function indexRepository(deps, repoPath, repoName) {
  const { db } = deps;
  const args = deps.args || {};
  const repository = deps.repository || createCodeIndexRepository(require('../../db'));
  const registry = deps.parserRegistry || createParserRegistry();

  if (!(await registry.ensureReady())) {
    return { error: `WASM tree-sitter parser not available. Run: cd ${path.resolve(__dirname, '..', '..')} && npm install web-tree-sitter` };
  }

  const absPath = path.resolve(repoPath);
  if (!fs.existsSync(absPath)) {
    return { error: `Path not found: ${absPath}` };
  }

  emitProgress(args, 'init', { message: 'Initializing parser and walking files...' });
  const files = scanRepository(absPath);
  emitProgress(args, 'discovery', { message: `Found ${files.length} code files to index`, files_total: files.length });

  const repoId = repository.upsertRepo({ name: repoName, path: absPath });
  repository.clearRepoIndex(repoId);

  let symbolCount = 0;
  let fileCount = 0;
  const skipped = [];
  const totalFiles = files.length;
  const batchSize = RESULT_LIMITS.INDEX_BATCH_SIZE;

  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(totalFiles / batchSize);
    emitProgress(args, 'parsing', { message: `Parsing files batch ${batchNum}/${totalBatches}...` }, { files_total: totalFiles, files_done: fileCount, symbols: symbolCount });

    const reads = await Promise.all(batch.map(async (fp) => {
      try {
        return await readFileRecord(fp);
      } catch (e) {
        skipped.push({ file: fp, error: e.message });
        return null;
      }
    }));

    for (const record of reads) {
      if (!record) { continue; }
      try {
        const fileId = repository.insertFile(fileRecordToParams(repoId, record));
        const symbols = extractSymbolsFromFile(record.filePath, registry);
        symbolCount += insertSymbols(repository, repoId, fileId, record.filePath, symbols);
        fileCount++;
      } catch (e) {
        skipped.push({ file: record.filePath, error: e.message });
      }
    }
  }

  const headCommit = getHeadCommit(absPath);
  repository.updateRepoStats({ repoId, headCommit });
  const derived = rebuildDerivedIndexes(db, repoId, args, totalFiles, fileCount, symbolCount);

  const result = {
    success: true,
    repo: repoName,
    path: absPath,
    files_indexed: fileCount,
    symbols_extracted: symbolCount,
    files_skipped: skipped.length,
    import_edges: derived.importEdges,
    call_edges: derived.callEdges,
    complexity_symbols: derived.complexityCount,
    name: repoName,
    file_count: fileCount,
    symbol_count: symbolCount,
    skipped,
  };

  emitProgress(args, 'done', { message: `Indexed ${fileCount} files, ${symbolCount} symbols` }, { files_total: totalFiles, files_done: fileCount, symbols: symbolCount });
  return result;
}

async function reindexRepository(deps, repo, mode = 'incremental') {
  const { db } = deps;
  const args = deps.args || {};
  const repository = deps.repository || createCodeIndexRepository(require('../../db'));
  const registry = deps.parserRegistry || createParserRegistry();

  const existing = repository.findRepoByName(repo);
  if (!existing) {
    return { error: `Repo not found: ${repo}` };
  }

  if (mode === 'full') {
    repository.clearRepoIndex(existing.id);
    return indexRepository({ ...deps, repository, parserRegistry: registry }, existing.path, repo);
  }

  if (!(await registry.ensureReady())) {
    return { error: 'WASM tree-sitter parser not available' };
  }

  emitProgress(args, 'init', { message: `Reindexing "${repo}" (incremental)...` });

  const files = scanRepository(existing.path);
  emitProgress(args, 'discovery', { message: `Found ${files.length} code files to check`, files_total: files.length });

  const existingFiles = new Map(repository.listFiles(existing.id).map((file) => [file.path, file]));
  let reindexed = 0;
  let unchanged = 0;
  let symbolCount = 0;
  const totalFiles = files.length;

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i];
    if (i % 50 === 0) {
      emitProgress(args, 'parsing', { message: `Reindexing file ${i + 1}/${totalFiles}...` }, { files_total: totalFiles, files_done: i, symbols: symbolCount });
    }

    try {
      const stats = fs.statSync(filePath);
      const prev = existingFiles.get(filePath);
      if (prev && prev.mtime === stats.mtimeMs) {
        unchanged++;
        continue;
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      const record = { filePath, content, stats };
      let fileId;
      if (prev) {
        repository.clearFileSymbols(prev.id);
        repository.updateFile(prev.id, fileRecordToParams(existing.id, record));
        fileId = prev.id;
      } else {
        fileId = repository.insertFile(fileRecordToParams(existing.id, record));
      }

      const symbols = extractSymbolsFromFile(filePath, registry);
      symbolCount += insertSymbols(repository, existing.id, fileId, filePath, symbols);
      reindexed++;
    } catch (_) {}
  }

  const currentFilesSet = new Set(files);
  const staleFiles = [...existingFiles.entries()].filter(([filePath]) => !currentFilesSet.has(filePath));
  for (const [, fileInfo] of staleFiles) {
    repository.deleteFile(fileInfo.id);
  }

  repository.updateRepoStats({ repoId: existing.id, headCommit: null });
  const derived = rebuildDerivedIndexes(db, existing.id, args, totalFiles, totalFiles, symbolCount);

  emitProgress(args, 'done', { message: `Reindexed: ${reindexed} files, ${symbolCount} symbols` }, { files_total: totalFiles, files_done: totalFiles, symbols: symbolCount });

  return {
    success: true,
    repo,
    mode,
    name: repo,
    file_count: reindexed + unchanged,
    symbol_count: symbolCount,
    files_reindexed: reindexed,
    files_unchanged: unchanged,
    files_removed: staleFiles.length,
    symbols_extracted: symbolCount,
    import_edges: derived.importEdges,
    call_edges: derived.callEdges,
    complexity_symbols: derived.complexityCount,
  };
}

module.exports = {
  emitProgress,
  fileRecordToParams,
  getHeadCommit,
  indexRepository,
  insertSymbols,
  rebuildDerivedIndexes,
  reindexRepository,
};
