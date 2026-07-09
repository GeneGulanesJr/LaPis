const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { RESULT_LIMITS, WORKER_POOL } = require('../../constants');
const { hashContent } = require('../../utils');
const { createCodeIndexRepository } = require('./repos');
const { scanRepository } = require('./scanner');
const { SKIP_FILE_RE } = require('./scanner');
const { resolveRepoScopedPath } = require('./path-guards');
const { withRepoIndexLock } = require('./repo-lock');
const { createParserRegistry, getLanguageForFile } = require('./parser-registry');
const { extractSymbolsSplit, normalizeSymbolHot } = require('./symbol-extractor');
const {
  buildImportEdges,
  buildImportEdgesForFiles,
  buildCallEdges,
  buildCallEdgesForFiles,
  buildComplexityMetrics,
  buildComplexityMetricsForFiles,
  buildRelationEdges,
  buildCochangeEdges,
} = require('./edge-extractor');
const { createParsePool } = require('./worker-pool');
const { buildScopeBindings: _buildScopeBindings } = require('./scope-builder');
const { resolveScopeBindings, resolveScopeBindingsForFiles } = require('./scope-resolver');

/**
 * Insert scope bindings for a file using delete-then-insert strategy.
 * @param {object} db - native database handle
 * @param {number} repoId
 * @param {number} fileId
 * @param {Array} bindings - array of binding objects from scope builder
 */
function insertScopeBindings(db, repoId, fileId, bindings) {
  // Clean stale bindings first
  db.prepare('DELETE FROM file_scope_bindings WHERE file_id = ?').run(fileId);

  const stmt = db.prepare(
    `INSERT INTO file_scope_bindings (repo_id, file_id, name, kind, origin, source_file_id, source_name, source_module, line_start, line_end, scope_depth, byte_start, byte_end, first_seen_pass)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  );

  for (const b of bindings) {
    stmt.run(
      repoId,
      fileId,
      b.name,
      b.kind,
      b.origin,
      null, // source_file_id resolved in derived phase from code_imports
      b.sourceName || null,
      b.sourceModule || null,
      b.lineStart,
      b.lineEnd,
      b.scopeDepth || 0,
      b.byteStart || null,
      b.byteEnd || null,
    );
  }
}

function logDerivedError(step, e) {
  console.error(`[indexer] derived phase failed (${step}): ${e.message}`);
}

function emitProgress(args, phase, detail, stats) {
  if (!args) {
    return;
  }
  // Worker hook: forward every progress event to a callback (used by the
  // async worker to update the index_jobs ledger). Errors are swallowed
  // because a failing callback must never break the indexer.
  if (typeof args.onProgress === 'function') {
    try {
      const callbackPayload = { phase, ...(detail || {}), ...(stats || {}) };
      args.onProgress(callbackPayload);
    } catch (_) { /* best-effort */ }
  }
  if (!args.progress) {
    return;
  }
  const payload = { progress: true, phase, ...detail };
  if (stats) {
    payload.files_total = stats.files_total;
    payload.files_done = stats.files_done;
    payload.symbols = stats.symbols;
  }
  process.stderr.write(`${JSON.stringify(payload)}\n`);
}

function progressPath(filePath, repoRoot) {
  if (!repoRoot) {
    return filePath;
  }
  const relative = path.relative(repoRoot, filePath);
  return relative && !relative.startsWith('..') ? relative : filePath;
}

function shouldEmitFileProgress(done, total) {
  if (done <= 5 || done === total) {
    return true;
  }
  if (total <= 100) {
    return done % 10 === 0;
  }
  return done % 25 === 0;
}

function getHeadCommit(repoPath) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function getCurrentBranch(repoPath) {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function parseChangedPathsInput(input, repoPath) {
  if (!input) {
    return null;
  }
  let entries = input;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) {
      return null;
    }
    try {
      entries = JSON.parse(trimmed);
    } catch {
      entries = trimmed
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    }
  }
  if (!Array.isArray(entries)) {
    return null;
  }
  const changed = new Set();
  const deleted = new Set();
  const rejected = [];
  for (const entry of entries) {
    let status = 'modified';
    let filePath = entry;
    if (entry && typeof entry === 'object') {
      status = entry.status || entry.type || entry.change_type || entry.changeType || status;
      filePath = entry.path || entry.file || entry.filePath || entry[1];
    }
    if (!filePath || typeof filePath !== 'string') {
      rejected.push({ path: String(filePath), reason: 'invalid_path' });
      // oxlint-disable-next-line no-continue
      continue;
    }
    const abs = resolveRepoScopedPath(repoPath, filePath, rejected);
    if (!abs) {
      // oxlint-disable-next-line no-continue
      continue;
    }
    if (/delete|remove|unlink/i.test(status) || !fs.existsSync(abs)) {
      deleted.add(abs);
    } else {
      changed.add(abs);
    }
  }
  return {
    changed: [...changed],
    deleted: [...deleted],
    rejected,
    renamed: [],
    currentHead: getHeadCommit(repoPath),
    source: 'changed-paths',
  };
}

function getGitDelta(repoPath, baseCommit) {
  if (!baseCommit) {
    return null;
  }
  const currentHead = getHeadCommit(repoPath);
  if (!currentHead || currentHead === baseCommit) {
    return null;
  }
  try {
    const output = execFileSync('git', ['diff', '--name-status', `${baseCommit}..HEAD`], {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 15000,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const changed = new Set();
    const deleted = new Set();
    const renamed = [];
    const rejected = [];
    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) {
        // oxlint-disable-next-line no-continue
        continue;
      }
      const parts = trimmed.split('\t');
      const status = parts[0];
      if (status.startsWith('D') && parts[1]) {
        const abs = resolveRepoScopedPath(repoPath, parts[1], rejected);
        if (abs) {
          deleted.add(abs);
        }
      } else if (status.startsWith('R') && parts[1] && parts[2]) {
        const fromAbs = resolveRepoScopedPath(repoPath, parts[1], rejected);
        const toAbs = resolveRepoScopedPath(repoPath, parts[2], rejected);
        if (fromAbs) {
          deleted.add(fromAbs);
        }
        if (toAbs) {
          changed.add(toAbs);
        }
        renamed.push({ from: parts[1], to: parts[2], status });
      } else if (parts[1]) {
        const abs = resolveRepoScopedPath(repoPath, parts[1], rejected);
        if (abs) {
          changed.add(abs);
        }
      }
    }
    return { currentHead, changed: [...changed], deleted: [...deleted], renamed, rejected };
  } catch {
    return null;
  }
}

async function readFileRecord(filePath) {
  const [content, stats] = await Promise.all([fs.promises.readFile(filePath, 'utf-8'), fs.promises.stat(filePath)]);
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
    mtimeNs:
      typeof record.stats.mtimeNs === 'bigint' ? Number(record.stats.mtimeNs) : Math.round(record.stats.mtimeMs * 1e6),
    sizeBytes: record.stats.size,
    lineCount: lines.length,
  };
}

function recordDiagnostic(repository, repoId, record, status, message, symbolCount = 0, options = {}) {
  if (options.defer) {
    return;
  }
  if (typeof repository.upsertFileDiagnostic !== 'function') {
    return;
  }
  repository.upsertFileDiagnostic({
    repoId,
    filePath: record.filePath,
    status,
    message,
    symbolCount,
    contentHash: record.content ? hashContent(record.content) : null,
  });
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
      stableSymbolId: sym.stable_symbol_id || '',
      contentHash: sym.content_hash || '',
      summary: sym.summary || '',
      decoratorsJson: sym.decorators_json || '[]',
      keywordsJson: sym.keywords_json || '[]',
      callReferencesJson: sym.call_references_json || '[]',
      ecosystemContext: sym.ecosystem_context || '',
    });
    count++;
  }
  return count;
}

function rebuildDerivedIndexes(db, repoId, args, totalFiles, fileCount, symbolCount, changedFileIds, deletedFileIds) {
  const stats = { files_total: totalFiles, files_done: fileCount, symbols: symbolCount };
  const useIncremental = Array.isArray(changedFileIds) && Array.isArray(deletedFileIds);

  if (useIncremental) {
    return rebuildDerivedIncremental(db, repoId, args, stats, changedFileIds, deletedFileIds);
  }

  emitProgress(args, 'analysis', { step: 'build-import-graph', message: 'Step 5/5: building import graph...' }, stats);

  let importEdges = 0;
  let callEdges = 0;
  let complexityCount = 0;
  try {
    const ig = buildImportEdges(db, repoId);
    if (ig.success) {
      importEdges = ig.edges;
    }
  } catch (e) {
    logDerivedError('import-graph', e);
  }

  // ── Scope resolution (v10) ────────────────────────────────
  let scopeResolved = 0;
  emitProgress(args, 'analysis', { step: 'resolve-scopes', message: 'Step 5/5: resolving scope bindings...' }, stats);
  try {
    const sr = resolveScopeBindings(db, repoId, {
      onProgress: (p) => {
        emitProgress(
          args,
          'analysis',
          {
            step: 'resolve-scopes',
            message: `Step 5/5: resolving scopes... pass ${p.pass}, ${p.resolved || 0} resolved`,
          },
          stats,
        );
      },
    });
    scopeResolved = sr.resolved;
  } catch (e) {
    logDerivedError('scope-resolution', e);
  }

  emitProgress(args, 'analysis', { step: 'build-call-graph', message: 'Step 5/5: building call graph...' }, stats);
  try {
    const cg = buildCallEdges(db, repoId, {
      onProgress: (p) => {
        emitProgress(
          args,
          'analysis',
          {
            step: 'build-call-graph',
            message: `Step 5/5: building call graph... ${p.filesProcessed}/${p.totalFiles} files, ${p.callsFound} calls`,
          },
          stats,
        );
      },
    });
    if (cg.success) {
      callEdges = cg.calls;
    }
  } catch (e) {
    logDerivedError('call-graph', e);
  }
  emitProgress(
    args,
    'analysis',
    { step: 'compute-complexity', message: 'Step 5/5: computing complexity metrics...' },
    stats,
  );
  try {
    const cc = buildComplexityMetrics(db, repoId);
    if (cc.success) {
      complexityCount = cc.symbols;
    }
  } catch (e) {
    logDerivedError('complexity', e);
  }

  let relationEdges = 0;
  emitProgress(args, 'analysis', { step: 'build-relations', message: 'Step 5/5: building relation edges...' }, stats);
  try {
    const re = buildRelationEdges(db, repoId);
    if (re.success) {
      relationEdges = re.count;
    }
  } catch (e) {
    logDerivedError('relations', e);
  }

  let cochangeEdges = 0;
  emitProgress(args, 'analysis', { step: 'build-cochange', message: 'Step 5/5: building co-change edges...' }, stats);
  try {
    const cc2 = buildCochangeEdges(db, repoId);
    if (cc2.success) {
      cochangeEdges = cc2.count;
    }
  } catch (e) {
    logDerivedError('cochange', e);
  }

  return {
    importEdges,
    callEdges,
    complexityCount,
    scopeResolved,
    relationEdges,
    cochangeEdges,
    derived_scope: 'repo',
  };
}

function rebuildDerivedIncremental(db, repoId, args, stats, changedFileIds, deletedFileIds) {
  emitProgress(
    args,
    'analysis',
    {
      step: 'build-import-graph',
      message: `Step 5/5: incrementally rebuilding import graph for ${changedFileIds.length + deletedFileIds.length} affected files...`,
    },
    stats,
  );

  let importEdges = 0;
  let callEdges = 0;
  let complexityCount = 0;
  const usedFallback = false;

  try {
    const ig = buildImportEdgesForFiles(db, repoId, changedFileIds, deletedFileIds);
    if (ig.success) {
      importEdges = ig.edges;
    }
  } catch (e) {
    logDerivedError('import-graph-incremental', e);
  }

  // ── Scope resolution (v10) ────────────────────────────────
  let scopeResolved = 0;
  emitProgress(
    args,
    'analysis',
    {
      step: 'resolve-scopes',
      message: 'Step 5/5: incrementally resolving scope bindings for affected files...',
    },
    stats,
  );
  try {
    const sr = resolveScopeBindingsForFiles(db, repoId, changedFileIds, deletedFileIds);
    scopeResolved = sr.resolved || 0;
  } catch (e) {
    logDerivedError('scope-resolution-incremental', e);
  }

  emitProgress(
    args,
    'analysis',
    {
      step: 'build-call-graph',
      message: `Step 5/5: incrementally rebuilding call graph for affected files...`,
    },
    stats,
  );
  try {
    const cg = buildCallEdgesForFiles(db, repoId, changedFileIds, deletedFileIds, {
      onProgress: (p) => {
        emitProgress(
          args,
          'analysis',
          {
            step: 'build-call-graph',
            message: `Step 5/5: rebuilding call graph... ${p.filesProcessed}/${p.totalFiles} files, ${p.callsFound} calls`,
          },
          stats,
        );
      },
    });
    if (cg.success) {
      callEdges = cg.calls;
    }
  } catch (e) {
    logDerivedError('call-graph-incremental', e);
  }

  emitProgress(
    args,
    'analysis',
    {
      step: 'compute-complexity',
      message: 'Step 5/5: incrementally computing complexity metrics...',
    },
    stats,
  );
  try {
    const cc = buildComplexityMetricsForFiles(db, repoId, changedFileIds, deletedFileIds);
    if (cc.success) {
      complexityCount = cc.symbols;
    }
  } catch (e) {
    logDerivedError('complexity-incremental', e);
  }

  let relationEdges = 0;
  try {
    const re = buildRelationEdges(db, repoId);
    if (re.success) {
      relationEdges = re.count;
    }
  } catch (e) {
    logDerivedError('relations-incremental', e);
  }

  return {
    importEdges,
    callEdges,
    complexityCount,
    scopeResolved,
    relationEdges,
    derived_scope: 'file',
    derived_files_changed: changedFileIds.length,
    derived_files_deleted: deletedFileIds.length,
    usedFallback,
  };
}

function formatSkipReport(report) {
  const lines = [];
  const topN = (obj, n = 5) =>
    Object.entries(obj)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n);
  if (Object.keys(report.builtIn).length > 0) {
    const top = topN(report.builtIn);
    lines.push(`  Built-in skip: ${top.map(([d]) => d).join(', ')}...`);
  }
  if (Object.keys(report.gitignore).length > 0) {
    const top = topN(report.gitignore);
    lines.push(`  .gitignore: ${top.map(([d]) => d).join(', ')}...`);
  }
  if (Object.keys(report.memorycodeignore).length > 0) {
    const top = topN(report.memorycodeignore);
    lines.push(`  .memorycodeignore: ${top.map(([d]) => d).join(', ')}...`);
  }
  if (report.extraIgnore && Object.keys(report.extraIgnore).length > 0) {
    const top = topN(report.extraIgnore);
    lines.push(`  extra ignore: ${top.map(([d]) => d).join(', ')}...`);
  }
  if (report.unsupportedExt > 0) {
    lines.push(`  Non-code files: ${report.unsupportedExt} skipped`);
  }
  for (const [key, label] of [
    ['tooLarge', 'Oversize files'],
    ['binary', 'Binary files'],
    ['secret', 'Secret-like files'],
    ['symlink', 'Symlinks'],
    ['pathTraversal', 'Path escapes'],
    ['unreadable', 'Unreadable entries'],
    ['fileLimit', 'Files beyond cap'],
  ]) {
    if (report[key] > 0) {
      lines.push(`  ${label}: ${report[key]} skipped`);
    }
  }
  return lines.join('\n');
}

async function scanPhase(repoPath, options, args) {
  const absPath = path.resolve(repoPath);
  if (!fs.existsSync(absPath)) {
    return { error: `Path not found: ${absPath}` };
  }
  const dirCount = { skipped: 0 };
  const scanResult = scanRepository(absPath, {
    ...options,
    onProgress: (relativePath, reason) => {
      dirCount.skipped++;
      if (dirCount.skipped <= 8 || dirCount.skipped % 50 === 0) {
        emitProgress(args, 'discovery', { message: `Skipping [${reason}]: ${relativePath}` });
      }
    },
    onScanProgress: (stats) => {
      const suffix = stats.done ? 'complete' : 'in progress';
      emitProgress(args, 'discovery', {
        message: `Step 2/5: discovery ${suffix}; currently scanning ${stats.currentKind || 'entry'} ${stats.currentPath || '.'} (${stats.codeFiles} code files found, ${stats.entriesSeen} entries seen, ${stats.dirsVisited} dirs visited)`,
        step: 'discover-files',
        current_file: stats.currentPath || '.',
        files_done: stats.codeFiles,
      });
    },
  });
  return { files: scanResult.files, absPath, skipReport: scanResult.skipReport };
}

function commitParsedBatch(repository, repoId, parsedRecords, ctx) {
  const { args, repoRoot, registry, scopeDb, insideTransaction = false } = ctx;
  const batchSymbols = [];

  for (const { record, hotSymbols, coldSymbols, tree: parsedTree } of parsedRecords) {
    try {
      const fileId = repository.insertFile(fileRecordToParams(repoId, record));
      for (let si = 0; si < hotSymbols.length; si++) {
        const hot = hotSymbols[si];
        const cold = coldSymbols[si] || {};
        batchSymbols.push({
          repoId,
          fileId,
          filePath: record.filePath,
          name: hot.name,
          kind: hot.kind,
          qualifiedName: hot.qualified_name,
          startLine: hot.start_line,
          endLine: hot.end_line,
          startByte: hot.start_byte,
          endByte: hot.end_byte,
          signature: cold.signature || '',
          docstring: cold.docstring || '',
          bodyPreview: cold.body_preview || '',
          language: cold.language || '',
          parentName: cold.parent_name || '',
          stableSymbolId: cold.stable_symbol_id || '',
          contentHash: cold.content_hash || '',
          summary: cold.summary || '',
          decoratorsJson: cold.decorators_json || '[]',
          keywordsJson: cold.keywords_json || '[]',
          callReferencesJson: cold.call_references_json || '[]',
          ecosystemContext: cold.ecosystem_context || '',
        });
      }
      ctx.symbolCount += hotSymbols.length;
      ctx.fileCount++;

      try {
        const scopeBuilder = require('./scope-builder').getScopeBuilder;
        const builder = scopeBuilder(record.filePath);
        if (builder && scopeDb) {
          let tree = parsedTree || null;
          if (!tree) {
            const fallback = registry.parseTree(record.filePath, record.content);
            tree = fallback ? fallback.tree : null;
          }
          if (tree) {
            const scopeBindings = builder(tree, record.content, record.filePath);
            if (scopeBindings.length > 0) {
              insertScopeBindings(scopeDb, repoId, fileId, scopeBindings);
            }
            tree.delete();
          }
        }
      } catch {}

      if (args && shouldEmitFileProgress(ctx.fileCount, ctx.totalFiles)) {
        emitProgress(
          args,
          'parsing',
          {
            step: 'store-index',
            current_file: progressPath(record.filePath, repoRoot),
            message: `Stored index ${ctx.fileCount}/${ctx.totalFiles}: ${progressPath(record.filePath, repoRoot)} (${hotSymbols.length} symbols)`,
          },
          { files_total: ctx.totalFiles, files_done: ctx.fileCount, symbols: ctx.symbolCount },
        );
      }
    } catch (e) {
      ctx.skipped.push({ file: record.filePath, error: e.message });
      recordDiagnostic(repository, repoId, record, 'error', e.message, 0);
    }
  }

  if (batchSymbols.length > 0) {
    if (insideTransaction) {
      repository.insertSymbolBulk(batchSymbols);
    } else {
      repository.insertSymbolBatch(batchSymbols);
    }
  }
}

async function parsePhase(files, deps, repoId, args) {
  const registry = deps.parserRegistry || createParserRegistry();
  const repository = deps.repository || createCodeIndexRepository(require('../../db'));
  const batchSize = RESULT_LIMITS.INDEX_BATCH_SIZE;
  const totalFiles = files.length;
  const repoRoot = args.repoRoot || args.repoPath || null;

  let useWorkers = totalFiles >= WORKER_POOL.MIN_FILES_FOR_PARALLEL && !args.noWorkers;
  let pool = null;

  if (useWorkers) {
    try {
      pool = await createParsePool();
      emitProgress(args, 'init', {
        step: 'prepare-workers',
        message: `Preparing parser workers: using ${pool.numWorkers} worker threads for symbol extraction`,
      });
    } catch (e) {
      emitProgress(args, 'init', {
        step: 'prepare-workers',
        message: `Preparing parser workers failed (${e.message}); continuing with sequential symbol extraction`,
      });
      pool = null;
      useWorkers = false;
    }
  }

  let symbolCount = 0;
  let fileCount = 0;
  const skipped = [];
  const deferredBatches = [];
  const deferIndexWrites = Boolean(args.deferIndexWrites);
  const scopeDb = args.scopeDb || null;

  function validateSymbols(record, symbols) {
    if (symbols.length === 0 && record.content.trim().length > 0) {
      const hasExports = /\bexport\s/.test(record.content);
      const hasFunction = /\bfunction\b|\b=>\s|\bdef\s|\bfunc\s|\bfn\s/.test(record.content);
      if (hasExports || hasFunction) {
        skipped.push({
          file: record.filePath,
          error: 'Parse returned 0 symbols despite containing exports/functions',
          zeroSymbolFile: true,
        });
      }
    }
  }

  try {
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(totalFiles / batchSize);
      const firstBatchPath = batch[0] ? progressPath(batch[0], repoRoot) : '(empty batch)';
      emitProgress(
        args,
        'parsing',
        {
          step: 'read-files',
          current_file: firstBatchPath,
          message: `Reading source files for batch ${batchNum}/${totalBatches}: ${batch.length} files starting at ${firstBatchPath}`,
        },
        { files_total: totalFiles, files_done: fileCount, symbols: symbolCount },
      );

      // oxlint-disable-next-line no-await-in-loop
      const reads = await Promise.all(
        batch.map(async (fp) => {
          try {
            return await readFileRecord(fp);
          } catch (e) {
            skipped.push({ file: fp, error: e.message });
            recordDiagnostic(repository, repoId, { filePath: fp, content: '' }, 'error', e.message, 0, {
              defer: args.deferIndexWrites,
            });
            return null;
          }
        }),
      );

      const validReads = reads.filter((r) => r !== null);
      emitProgress(
        args,
        'parsing',
        {
          step: 'extract-symbols',
          current_file: validReads[0] ? progressPath(validReads[0].filePath, repoRoot) : firstBatchPath,
          message: `Extracting symbols for batch ${batchNum}/${totalBatches}: ${validReads.length} readable files${useWorkers ? ' with workers' : ' sequentially'}`,
        },
        { files_total: totalFiles, files_done: fileCount, symbols: symbolCount },
      );

      const parsedRecords = [];
      if (useWorkers && pool) {
        try {
          const workerInputs = validReads.map((r) => ({ filePath: r.filePath, content: r.content }));
          // oxlint-disable-next-line no-await-in-loop
          const workerResults = await pool.parseAll(workerInputs);
          const symbolMap = new Map(workerResults.map((r) => [r.filePath, r.symbols]));
          for (const record of validReads) {
            const symbols = symbolMap.get(record.filePath) || [];
            validateSymbols(record, symbols);
            recordDiagnostic(
              repository,
              repoId,
              record,
              symbols.length === 0 && record.content.trim().length > 0 ? 'zero_symbols' : 'ok',
              symbols.length === 0 && record.content.trim().length > 0
                ? 'No symbols extracted from non-empty file'
                : '',
              symbols.length,
              { defer: args.deferIndexWrites },
            );
            const hotSymbols = symbols.map((s) => normalizeSymbolHot(s, record.filePath));
            parsedRecords.push({ record, hotSymbols, coldSymbols: symbols, tree: null });
          }
        } catch (e) {
          emitProgress(args, 'parsing', {
            step: 'extract-symbols',
            message: `Worker symbol extraction failed (${e.message}); retrying this batch sequentially`,
          });
          useWorkers = false;
        }
      }

      if (!useWorkers || parsedRecords.length === 0) {
        let parsedInBatch = 0;
        for (const record of validReads) {
          const {
            hot: hotSymbols,
            cold: coldSymbols,
            tree,
          } = extractSymbolsSplit(record.filePath, registry, record.content);
          const symbols = hotSymbols;
          validateSymbols(record, symbols);
          recordDiagnostic(
            repository,
            repoId,
            record,
            symbols.length === 0 && record.content.trim().length > 0 ? 'zero_symbols' : 'ok',
            symbols.length === 0 && record.content.trim().length > 0 ? 'No symbols extracted from non-empty file' : '',
            symbols.length,
            { defer: args.deferIndexWrites },
          );
          parsedRecords.push({ record, hotSymbols, coldSymbols, tree });
          parsedInBatch++;
          const absoluteDone = i + parsedInBatch;
          if (shouldEmitFileProgress(absoluteDone, totalFiles)) {
            emitProgress(
              args,
              'parsing',
              {
                step: 'extract-symbols',
                current_file: progressPath(record.filePath, repoRoot),
                message: `Extracted symbols ${absoluteDone}/${totalFiles}: ${progressPath(record.filePath, repoRoot)} (${symbols.length} symbols)`,
              },
              { files_total: totalFiles, files_done: fileCount, symbols: symbolCount },
            );
          }
        }
      }

      emitProgress(
        args,
        'parsing',
        {
          step: deferIndexWrites ? 'buffer-index' : 'store-index',
          current_file: parsedRecords[0] ? progressPath(parsedRecords[0].record.filePath, repoRoot) : firstBatchPath,
          message: deferIndexWrites
            ? `Buffered index records for batch ${batchNum}/${totalBatches}: ${parsedRecords.length} files`
            : `Storing index records for batch ${batchNum}/${totalBatches}: ${parsedRecords.length} files`,
        },
        { files_total: totalFiles, files_done: fileCount, symbols: symbolCount },
      );

      if (deferIndexWrites) {
        for (const entry of parsedRecords) {
          symbolCount += entry.hotSymbols.length;
          fileCount++;
        }
        deferredBatches.push(parsedRecords);
        // oxlint-disable-next-line no-continue
        continue;
      }

      const writeCtx = {
        fileCount,
        symbolCount,
        skipped,
        totalFiles,
        args,
        repoRoot,
        registry,
        scopeDb,
        insideTransaction: false,
      };
      if (typeof repository.withTransaction === 'function') {
        repository.withTransaction(() => {
          writeCtx.insideTransaction = true;
          commitParsedBatch(repository, repoId, parsedRecords, writeCtx);
          fileCount = writeCtx.fileCount;
          symbolCount = writeCtx.symbolCount;
        });
      } else {
        commitParsedBatch(repository, repoId, parsedRecords, writeCtx);
        fileCount = writeCtx.fileCount;
        symbolCount = writeCtx.symbolCount;
      }
    }
  } catch (parseError) {
    console.error(`[indexer] parsePhase failed: ${parseError.message}`);
    emitProgress(args, 'error', {
      step: 'parse-failed',
      message: `Parse phase failed: ${parseError.message}. Index may be incomplete.`,
    });
    // Re-throw so the caller (indexRepository) knows parsing was incomplete
    throw parseError;
  } finally {
    if (pool) {
      await pool.terminate();
    }
  }

  return { fileCount, symbolCount, skipped, deferredBatches };
}

async function derivedPhase(db, repoId, args, totalFiles, fileCount, symbolCount, changedFileIds, deletedFileIds) {
  return rebuildDerivedIndexes(db, repoId, args, totalFiles, fileCount, symbolCount, changedFileIds, deletedFileIds);
}

async function indexRepository(deps, repoPath, repoName) {
  return withRepoIndexLock(repoName, async () => {
    const { db } = deps;
    const args = deps.args || {};
    const repository = deps.repository || createCodeIndexRepository(require('../../db'));
    const registry = deps.parserRegistry || createParserRegistry();
    const t0 = Date.now();

    if (!(await registry.ensureReady())) {
      return {
        error: `WASM tree-sitter parser not available. Run: cd ${path.resolve(__dirname, '..', '..')} && npm install web-tree-sitter`,
      };
    }

    emitProgress(args, 'init', { step: 'prepare-parser', message: 'Step 1/5: preparing tree-sitter parsers...' });
    emitProgress(args, 'discovery', { step: 'discover-files', message: 'Step 2/5: discovering code files to index...' });
    const scanResult = await scanPhase(repoPath, {}, args);
    if (scanResult.error) {
      return { error: scanResult.error };
    }
    const { files, absPath, skipReport } = scanResult;
    const scanMs = Date.now() - t0;
    const skipSummary = formatSkipReport(skipReport);

    emitProgress(args, 'discovery', {
      message: `Found ${files.length} code files to index (${scanMs}ms)`,
      files_total: files.length,
      detail: skipSummary,
    });
    if (skipSummary) {
      emitProgress(args, 'discovery', { message: skipSummary });
    }

    const repoId = repository.upsertRepo({ name: repoName, path: absPath });
    emitProgress(args, 'reset-index', {
      step: 'clear-index',
      message: `Step 3/5: will clear existing index rows for ${repoName} immediately before writing rebuilt data...`,
    });

    emitProgress(args, 'parsing', {
      step: 'parse-and-store',
      message: `Step 4/5: reading files, extracting symbols, and storing index rows for ${files.length} files...`,
      files_total: files.length,
    });
    const parseT0 = Date.now();
    let parseResult;
    try {
      parseResult = await parsePhase(files, { parserRegistry: registry, repository }, repoId, {
        ...args,
        repoRoot: absPath,
        deferIndexWrites: true,
        scopeDb: db,
      });
      emitProgress(args, 'reset-index', {
        step: 'clear-index',
        message: `Step 3/5: committing rebuilt index for ${repoName} in a single transaction...`,
      });
      const writeCtx = {
        fileCount: 0,
        symbolCount: 0,
        skipped: parseResult.skipped,
        totalFiles: files.length,
        args,
        repoRoot: absPath,
        registry,
        scopeDb: db,
        insideTransaction: true,
      };
      const clearT0 = Date.now();
      let clearTotals = {};
      repository.withTransaction(() => {
        clearTotals = repository.clearRepoIndexCore(repoId, {
          onProgress: (progress) => {
            emitProgress(args, 'reset-index', {
              step: 'clear-index',
              message: `Step 3/5: ${progress.message}`,
              rows_deleted: progress.deleted,
            });
          },
        });
        for (const batch of parseResult.deferredBatches || []) {
          commitParsedBatch(repository, repoId, batch, writeCtx);
        }
      });
      emitProgress(args, 'reset-index', {
        step: 'clear-index',
        message: `Step 3/5: committed rebuilt index rows for ${repoName} (${Date.now() - clearT0}ms)`,
        clear_totals: clearTotals,
      });
      parseResult.fileCount = writeCtx.fileCount;
      parseResult.symbolCount = writeCtx.symbolCount;
      parseResult.skipped = writeCtx.skipped;
    } catch (parseError) {
      const phase = parseResult ? 'commit' : 'parse';
      console.error(`[indexer] indexRepository: ${phase} phase failed: ${parseError.message}`);
      emitProgress(args, 'error', {
        step: phase === 'parse' ? 'parse-failed' : 'commit-failed',
        message:
          phase === 'parse'
            ? `Fatal: parse phase failed before index write: ${parseError.message}. Existing index preserved.`
            : `Fatal: index commit failed: ${parseError.message}. Existing index preserved.`,
      });
      return {
        error: `Index rebuild failed during ${phase} phase: ${parseError.message}. The existing index for "${repoName}" was preserved.`,
        repo: repoName,
      };
    }
    const parseMs = Date.now() - parseT0;

    emitProgress(args, 'analysis', {
      step: 'derived-indexes',
      message: 'Step 5/5: building derived indexes (imports, calls, complexity)...',
    });
    const derivedT0 = Date.now();
    const headCommit = getHeadCommit(absPath);
    let derived;
    try {
      derived = await derivedPhase(db, repoId, args, files.length, parseResult.fileCount, parseResult.symbolCount);
    } catch (derivedError) {
      console.error(`[indexer] indexRepository: derived phase failed after commit: ${derivedError.message}`);
      emitProgress(args, 'error', {
        step: 'derived-failed',
        message: `Symbols committed but derived indexes failed: ${derivedError.message}. Run reindex-repo to rebuild derived indexes.`,
      });
      return {
        error: `Index symbols committed but derived indexes failed: ${derivedError.message}. Run reindex-repo to rebuild derived indexes.`,
        repo: repoName,
        partial: true,
        files_indexed: parseResult.fileCount,
        symbols_extracted: parseResult.symbolCount,
      };
    }
    repository.updateRepoStats({
      repoId,
      headCommit,
      currentBranch: getCurrentBranch(absPath),
      baseHead: headCommit,
    });
    const derivedMs = Date.now() - derivedT0;

    const totalMs = Date.now() - t0;
    const result = {
      success: true,
      repo: repoName,
      path: absPath,
      files_indexed: parseResult.fileCount,
      symbols_extracted: parseResult.symbolCount,
      files_skipped: parseResult.skipped.length,
      import_edges: derived.importEdges,
      call_edges: derived.callEdges,
      complexity_symbols: derived.complexityCount,
      name: repoName,
      file_count: parseResult.fileCount,
      symbol_count: parseResult.symbolCount,
      skipped: parseResult.skipped,
      skip_report: skipReport,
      timing_ms: { scan: scanMs, parse: parseMs, derived: derivedMs, total: totalMs },
    };

    emitProgress(
      args,
      'done',
      {
        message: `Done: ${parseResult.fileCount} files, ${parseResult.symbolCount} symbols (${(totalMs / 1000).toFixed(1)}s)`,
      },
      { files_total: files.length, files_done: parseResult.fileCount, symbols: parseResult.symbolCount },
    );
    return result;
  });
}

async function reindexRepository(deps, repo, mode = 'incremental') {
  return withRepoIndexLock(repo, async () => {
    const { db } = deps;
  const args = deps.args || {};
  const repository = deps.repository || createCodeIndexRepository(require('../../db'));
  const registry = deps.parserRegistry || createParserRegistry();
  const t0 = Date.now();

  const existing = repository.findRepoByName(repo);
  if (!existing) {
    return { error: `Repo not found: ${repo}` };
  }

  if (mode === 'full') {
    return indexRepository({ ...deps, repository, parserRegistry: registry }, existing.path, repo);
  }

  if (!(await registry.ensureReady())) {
    return { error: 'WASM tree-sitter parser not available' };
  }

  emitProgress(args, 'init', {
    step: 'prepare-parser',
    message: `Step 1/5: preparing tree-sitter parsers for incremental reindex of "${repo}"...`,
  });
  emitProgress(args, 'discovery', { step: 'discover-files', message: 'Step 2/5: discovering code files to check...' });

  const explicitDelta = fs.existsSync(existing.path)
    ? parseChangedPathsInput(args.changedPaths || args['changed-paths'] || args.paths, existing.path)
    : null;
  const gitDelta =
    explicitDelta || (fs.existsSync(existing.path) ? getGitDelta(existing.path, existing.head_commit) : null);
  const gitChangedFiles = gitDelta
    ? gitDelta.changed.filter(
        (filePath) =>
          resolveRepoScopedPath(existing.path, filePath) &&
          fs.existsSync(filePath) &&
          registry.canParseFile(filePath) &&
          !SKIP_FILE_RE.test(filePath.replace(/\\/g, '/')),
      )
    : null;
  const gitDeletedFiles = gitDelta ? gitDelta.deleted : [];
  const explicitChangedPathMode = gitDelta && gitDelta.source === 'changed-paths';
  let scanResult;
  if (gitDelta) {
    scanResult = {
      files: gitChangedFiles,
      skipReport: { builtIn: {}, gitignore: {}, memorycodeignore: {}, unsupportedExt: 0 },
      source: 'git-diff',
    };
  } else if (fs.existsSync(existing.path)) {
    scanResult = await scanPhase(existing.path, {}, args);
  } else {
    scanResult = { files: [], skipReport: { builtIn: {}, gitignore: {}, memorycodeignore: {}, unsupportedExt: 0 } };
  }
  const files = scanResult.files;
  const skipReport = scanResult.skipReport;
  const skipSummary = formatSkipReport(skipReport);
  emitProgress(args, 'discovery', {
    message: gitDelta
      ? `Git diff from ${String(existing.head_commit || 'unknown').slice(0, 8)} to ${String(gitDelta.currentHead || 'unknown').slice(0, 8)} found ${files.length} changed code files and ${gitDeletedFiles.length} deleted files`
      : `Found ${files.length} code files to check`,
    files_total: files.length,
    detail: skipSummary,
  });
  if (skipSummary) {
    emitProgress(args, 'discovery', { message: skipSummary });
  }
  if (gitDelta?.rejected?.length) {
    emitProgress(args, 'discovery', {
      message: `Skipped ${gitDelta.rejected.length} git/changed-path entries outside the repo or blocked as secret files`,
      rejected_paths: gitDelta.rejected,
    });
  }

  const existingFiles = new Map(repository.listFiles(existing.id).map((file) => [file.path, file]));
  let reindexed = 0;
  let unchanged = 0;
  let symbolCount = 0;
  let hashed = 0;
  const skipped = [];
  const totalFiles = files.length;
  const changedFileIds = [];
  const deletedFileIds = [];
  const changedRecords = [];

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i];
    if (i % 50 === 0) {
      emitProgress(
        args,
        'parsing',
        {
          step: 'check-file',
          current_file: progressPath(filePath, existing.path),
          message: `Step 3/5: checking file ${i + 1}/${totalFiles}: ${progressPath(filePath, existing.path)}`,
        },
        { files_total: totalFiles, files_done: i, symbols: symbolCount },
      );
    }

    try {
      // oxlint-disable-next-line no-await-in-loop
      const record = await readFileRecord(filePath);
      const fileParams = fileRecordToParams(existing.id, record);
      hashed++;
      const prev = existingFiles.get(filePath);
      if (prev && prev.content_hash === fileParams.contentHash) {
        unchanged++;
      } else {
        changedRecords.push({ filePath, record, fileParams, prev });
      }
    } catch (e) {
      skipped.push({ file: filePath, error: e.message });
      recordDiagnostic(repository, existing.id, { filePath, content: '' }, 'error', e.message, 0);
    }

    const done = i + 1;
    if (shouldEmitFileProgress(done, totalFiles)) {
      emitProgress(
        args,
        'parsing',
        {
          step: 'check-file',
          current_file: progressPath(filePath, existing.path),
          message: `Step 3/5: checked ${done}/${totalFiles}: ${progressPath(filePath, existing.path)} (${changedRecords.length} changed, ${unchanged} unchanged)`,
        },
        { files_total: totalFiles, files_done: done, symbols: symbolCount },
      );
    }
  }

  if (changedRecords.length > 0) {
    emitProgress(
      args,
      'parsing',
      {
        step: 'extract-symbols',
        message: `Step 3/5: extracting symbols from ${changedRecords.length} changed files...`,
      },
      { files_total: totalFiles, files_done: unchanged, symbols: symbolCount },
    );

    const allSymbols = [];
    const scopeWork = [];
    const fileMutations = [];

    for (let ci = 0; ci < changedRecords.length; ci++) {
      const { filePath, record, fileParams, prev } = changedRecords[ci];
      try {
        const { hot: hotSymbols, cold: coldSymbols, tree } = extractSymbolsSplit(filePath, registry, record.content);
        recordDiagnostic(
          repository,
          existing.id,
          record,
          hotSymbols.length === 0 && record.content.trim().length > 0 ? 'zero_symbols' : 'ok',
          hotSymbols.length === 0 && record.content.trim().length > 0 ? 'No symbols extracted from non-empty file' : '',
          hotSymbols.length,
        );

        fileMutations.push({ prev, fileParams });
        const mutationIndex = fileMutations.length - 1;

        for (let si = 0; si < hotSymbols.length; si++) {
          const hot = hotSymbols[si];
          const cold = coldSymbols[si] || {};
          allSymbols.push({
            _mutationIndex: mutationIndex,
            repoId: existing.id,
            fileId: -1,
            filePath,
            name: hot.name,
            kind: hot.kind,
            qualifiedName: hot.qualified_name,
            startLine: hot.start_line,
            endLine: hot.end_line,
            startByte: hot.start_byte,
            endByte: hot.end_byte,
            signature: cold.signature || '',
            docstring: cold.docstring || '',
            bodyPreview: cold.body_preview || '',
            language: cold.language || '',
            parentName: cold.parent_name || '',
            stableSymbolId: cold.stable_symbol_id || '',
            contentHash: cold.content_hash || '',
            summary: cold.summary || '',
            decoratorsJson: cold.decorators_json || '[]',
            keywordsJson: cold.keywords_json || '[]',
            callReferencesJson: cold.call_references_json || '[]',
            ecosystemContext: cold.ecosystem_context || '',
          });
        }
        symbolCount += hotSymbols.length;
        reindexed++;
        scopeWork.push({ filePath, tree, mutationIndex });
      } catch (e) {
        skipped.push({ file: filePath, error: e.message });
        recordDiagnostic(repository, existing.id, { filePath, content: '' }, 'error', e.message, 0);
      }
    }

    const applyMutations = () => {
      const mutationFileIds = new Array(fileMutations.length);
      for (let mi = 0; mi < fileMutations.length; mi++) {
        const { prev, fileParams } = fileMutations[mi];
        let fileId;
        if (prev) {
          repository.clearFileSymbols(prev.id);
          repository.updateFile(prev.id, fileParams);
          fileId = prev.id;
        } else {
          fileId = repository.insertFile(fileParams);
        }
        mutationFileIds[mi] = fileId;
        changedFileIds.push(fileId);
      }

      for (const sym of allSymbols) {
        sym.fileId = mutationFileIds[sym._mutationIndex];
        delete sym._mutationIndex;
      }

      if (allSymbols.length > 0) {
        if (typeof repository.insertSymbolBulk === 'function') {
          repository.insertSymbolBulk(allSymbols);
        } else if (typeof repository.insertSymbolBatch === 'function') {
          repository.insertSymbolBatch(allSymbols);
        }
      }

      return mutationFileIds;
    };

    let mutationFileIds;
    if (typeof repository.withTransaction === 'function') {
      mutationFileIds = repository.withTransaction(applyMutations);
    } else {
      mutationFileIds = applyMutations();
    }

    for (const { filePath, tree, mutationIndex } of scopeWork) {
      try {
        const fileId = mutationFileIds[mutationIndex];
        const scopeBuilder = require('./scope-builder').getScopeBuilder;
        const builder = scopeBuilder(filePath);
        if (builder) {
          let treeObj = tree;
          if (!treeObj) {
            const parseResult = registry.parseTree(filePath, changedRecords[mutationIndex].record.content);
            treeObj = parseResult ? parseResult.tree : null;
          }
          if (treeObj) {
            const scopeBindings = builder(treeObj, changedRecords[mutationIndex].record.content, filePath);
            if (scopeBindings.length > 0) {
              insertScopeBindings(db, existing.id, fileId, scopeBindings);
            }
            treeObj.delete();
          }
        }
      } catch {
        // Best-effort scope binding extraction
      }
    }
  }

  const currentFilesSet = new Set(files);
  const staleFiles =
    gitDelta || explicitChangedPathMode
      ? [...existingFiles.entries()].filter(([filePath]) => gitDeletedFiles.includes(filePath))
      : [...existingFiles.entries()].filter(([filePath]) => !currentFilesSet.has(filePath));
  for (const [, fileInfo] of staleFiles) {
    deletedFileIds.push(fileInfo.id);
    repository.deleteFile(fileInfo.id);
  }

  if (changedRecords.length === 0 && unchanged === totalFiles && staleFiles.length === 0) {
    const totalMs = Date.now() - t0;
    const currentHead = gitDelta?.currentHead || getHeadCommit(existing.path);
    if (currentHead && currentHead !== existing.head_commit) {
      repository.updateRepoStats({
        repoId: existing.id,
        headCommit: currentHead,
        currentBranch: getCurrentBranch(existing.path),
        baseHead: existing.head_commit || null,
      });
    }
    const existingSymbolCount = (() => {
      try {
        const r = db.prepare('SELECT symbol_count FROM code_repos WHERE id = ?').get(existing.id);
        return r ? r.symbol_count : 0;
      } catch {
        return 0;
      }
    })();
    emitProgress(
      args,
      'done',
      {
        message: `No files changed: ${unchanged} unchanged (${(totalMs / 1000).toFixed(1)}s)`,
      },
      { files_total: totalFiles, files_done: totalFiles, symbols: existingSymbolCount },
    );
    return {
      success: true,
      repo,
      mode,
      name: repo,
      file_count: totalFiles,
      symbol_count: existingSymbolCount,
      files_checked: totalFiles,
      files_hashed: hashed,
      files_reindexed: 0,
      files_unchanged: unchanged,
      files_removed: 0,
      files_skipped: skipped.length,
      symbols_extracted: 0,
      strategy: gitDelta ? 'git-diff' : 'scan-hash',
      derived_scope: 'none',
      git_base: existing.head_commit || null,
      git_head: gitDelta?.currentHead || getHeadCommit(existing.path),
      git_renames: gitDelta ? gitDelta.renamed : [],
      import_edges: 0,
      call_edges: 0,
      complexity_symbols: 0,
      skipped,
      skip_report: skipReport,
      timing_ms: { total: totalMs },
    };
  }

  emitProgress(args, 'cleanup', {
    step: 'remove-stale-files',
    message: `Step 4/5: removing ${staleFiles.length} stale files from the index...`,
  });

  emitProgress(args, 'analysis', {
    step: 'derived-indexes',
    message: 'Step 5/5: rebuilding derived indexes (imports, calls, complexity)...',
  });
  const derived = rebuildDerivedIndexes(
    db,
    existing.id,
    args,
    totalFiles,
    totalFiles,
    symbolCount,
    changedFileIds,
    deletedFileIds,
  );
  repository.updateRepoStats({
    repoId: existing.id,
    headCommit: gitDelta?.currentHead || getHeadCommit(existing.path),
    currentBranch: getCurrentBranch(existing.path),
    baseHead: existing.head_commit || null,
  });

  const totalMs = Date.now() - t0;
  emitProgress(
    args,
    'done',
    { message: `Reindexed: ${reindexed} changed, ${unchanged} unchanged (${(totalMs / 1000).toFixed(1)}s)` },
    { files_total: totalFiles, files_done: totalFiles, symbols: symbolCount },
  );

  return {
    success: true,
    repo,
    mode,
    name: repo,
    file_count: reindexed + unchanged,
    symbol_count: (() => {
      try {
        const r = db.prepare('SELECT symbol_count FROM code_repos WHERE id = ?').get(existing.id);
        return r ? r.symbol_count : symbolCount;
      } catch {
        return symbolCount;
      }
    })(),
    files_checked: totalFiles,
    files_hashed: hashed,
    files_reindexed: reindexed,
    files_unchanged: unchanged,
    files_removed: staleFiles.length,
    files_skipped: skipped.length,
    symbols_extracted: symbolCount,
    strategy: gitDelta ? 'git-diff' : 'scan-hash',
    derived_scope: derived.derived_scope || 'repo',
    git_base: gitDelta ? existing.head_commit : null,
    git_head: gitDelta ? gitDelta.currentHead : null,
    git_renames: gitDelta ? gitDelta.renamed : [],
    import_edges: derived.importEdges,
    call_edges: derived.callEdges,
    complexity_symbols: derived.complexityCount,
    skipped,
    skip_report: skipReport,
    timing_ms: { total: totalMs },
    ...(gitDelta?.rejected?.length ? { rejected_paths: gitDelta.rejected } : {}),
  };
  });
}

async function getCodeRepoHealth(deps, repo) {
  const repository = deps.repository || createCodeIndexRepository(require('../../db'));
  const registry = deps.parserRegistry || createParserRegistry();
  const existing = repository.findRepoByName(repo);
  if (!existing) {
    return { error: `Repo not found: ${repo}` };
  }

  const pathExists = fs.existsSync(existing.path);
  const currentHead = pathExists ? getHeadCommit(existing.path) : null;
  const stale = Boolean(existing.head_commit && currentHead && existing.head_commit !== currentHead);
  const diagnostics = repository.summarizeDiagnostics(existing.id);
  const diagnosticCounts = Object.fromEntries(diagnostics.map((row) => [row.status, row.count]));
  const recentDiagnostics = repository.listDiagnostics(existing.id, RESULT_LIMITS.DEFAULT_SEARCH_LIMIT);
  let scan = null;

  if (pathExists) {
    const scanResult = scanRepository(existing.path, {});
    const parseableFiles = scanResult.files.filter((filePath) => registry.canParseFile(filePath));
    scan = {
      code_files_found: scanResult.files.length,
      parseable_files_found: parseableFiles.length,
      unsupported_files_skipped: scanResult.skipReport.unsupportedExt,
      skip_report: scanResult.skipReport,
      indexed_file_delta: parseableFiles.length - existing.file_count,
    };
  }

  const parseQuality =
    existing.file_count > 0
      ? Math.max(0, 1 - ((diagnosticCounts.error || 0) + (diagnosticCounts.zero_symbols || 0)) / existing.file_count)
      : 1;
  const healthScore = Math.round((((pathExists ? 1 : 0) + (stale ? 0 : 1) + parseQuality) / 3) * 100) / 100;

  return {
    ok: true,
    repo,
    path: existing.path,
    path_exists: pathExists,
    indexed_files: existing.file_count,
    indexed_symbols: existing.symbol_count,
    indexed_at: existing.indexed_at,
    updated_at: existing.updated_at,
    indexed_head: existing.head_commit,
    current_head: currentHead,
    stale,
    diagnostics: diagnosticCounts,
    recent_diagnostics: recentDiagnostics,
    scan,
    health_score: healthScore,
    recommendations: buildHealthRecommendations({ pathExists, stale, diagnosticCounts, scan }),
  };
}

function buildHealthRecommendations({ pathExists, stale, diagnosticCounts, scan }) {
  const recommendations = [];
  if (!pathExists) {
    recommendations.push('Indexed path no longer exists; remove or reindex this repo.');
  }
  if (stale) {
    recommendations.push('Repo HEAD changed since indexing; run reindex-repo.');
  }
  if ((diagnosticCounts.error || 0) > 0) {
    recommendations.push('Some files failed to read or index; inspect recent_diagnostics.');
  }
  if ((diagnosticCounts.zero_symbols || 0) > 0) {
    recommendations.push('Some non-empty files produced zero symbols; parser coverage may need improvement.');
  }
  if (scan && scan.indexed_file_delta !== 0) {
    recommendations.push('Discovered file count differs from indexed count; run reindex-repo.');
  }
  return recommendations;
}

module.exports = {
  emitProgress,
  fileRecordToParams,
  getHeadCommit,
  getCurrentBranch,
  parseChangedPathsInput,
  getCodeRepoHealth,
  indexRepository,
  insertSymbols,
  parsePhase,
  rebuildDerivedIndexes,
  rebuildDerivedIncremental,
  reindexRepository,
  scanPhase,
  derivedPhase,
};
