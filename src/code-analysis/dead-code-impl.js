// Dead code detection via call graph reachability analysis.

const { _requireNativeDb, DEAD_CODE } = require('./shared-deps');

function getDeadCode(db, repoId, opts) {
  const guard = _requireNativeDb(db),
    minConfidence = !guard ? opts.minConfidence || DEAD_CODE.DEFAULT_MIN_CONFIDENCE : undefined,
    includeTests = !guard ? opts.includeTests || false : undefined,
    entryFiles = !guard ? new Set() : undefined,
    entryPatterns = !guard
      ? ['%main.js', '%index.js', '%index.ts', '%mod.ts', '%cli.js', '%app.js', '%app.ts', '%server.js', '%server.ts']
      : undefined;
  if (guard) {
    return guard;
  }
  for (const pattern of entryPatterns) {
    const rows = db.prepare('SELECT id FROM code_files WHERE repo_id = ? AND path LIKE ?').all(repoId, pattern);
    for (const r of rows) {
      entryFiles.add(r.id);
    }
  }

  // 2. Shebang files
  {
    const shebangFiles = db
        .prepare("SELECT id FROM code_files WHERE repo_id = ? AND content LIKE '#!/usr/bin/env%'")
        .all(repoId),
      exportDefaultFiles = (() => {
        for (const r of shebangFiles) {
          entryFiles.add(r.id);
        }

        // 3. export default

        return db
          .prepare("SELECT id FROM code_files WHERE repo_id = ? AND content LIKE '%export default%'")
          .all(repoId);
      })();
    for (const r of exportDefaultFiles) {
      entryFiles.add(r.id);
    }

    // 4. package.json bin/main/exports fields
    {
      const packageJsonFiles = db
          .prepare("SELECT id, path, content FROM code_files WHERE repo_id = ? AND path LIKE '%/package.json'")
          .all(repoId),
        barrelFiles = (() => {
          for (const pkg of packageJsonFiles) {
            try {
              const pkgData = JSON.parse(pkg.content);
              if (pkgData.main) {
                const mainRow = db
                  .prepare('SELECT id FROM code_files WHERE repo_id = ? AND path LIKE ?')
                  .get(repoId, `%${pkgData.main}%`);
                if (mainRow) {
                  entryFiles.add(mainRow.id);
                }
              }
              if (pkgData.bin) {
                const bins = typeof pkgData.bin === 'string' ? [pkgData.bin] : Object.values(pkgData.bin);
                for (const bin of bins) {
                  const binRow = db
                    .prepare('SELECT id FROM code_files WHERE repo_id = ? AND path LIKE ?')
                    .get(repoId, `%${bin}%`);
                  if (binRow) {
                    entryFiles.add(binRow.id);
                  }
                }
              }
            } catch {}
          }

          // 5. Barrel files (index.js/ts that re-export other modules)

          return db
            .prepare(
              "SELECT source_file_id as file_id FROM code_imports WHERE import_type = 're-export' AND repo_id = ? GROUP BY source_file_id",
            )
            .all(repoId);
        })();
      for (const b of barrelFiles) {
        entryFiles.add(b.file_id);
      }

      // ── BFS from entry points through import graph ──
      {
        const reachable = new Set(entryFiles),
          queue = [...entryFiles];
        while (queue.length > 0) {
          const current = queue.shift(),
            importers = db
              .prepare(
                'SELECT DISTINCT source_file_id FROM code_imports WHERE target_file_id = ? AND source_file_id IS NOT NULL',
              )
              .all(current);
          for (const imp of importers) {
            if (!reachable.has(imp.source_file_id)) {
              reachable.add(imp.source_file_id);
              queue.push(imp.source_file_id);
            }
          }
        }

        {
          const allFiles = db.prepare('SELECT id, path FROM code_files WHERE repo_id = ?').all(repoId),
            deadFiles = allFiles.filter((f) => !reachable.has(f.id)),
            deadFileSet = new Set(deadFiles.map((f) => f.id)),
            // ── Symbols with zero callers ──
            uncalledSymbols = db
              .prepare(`
    SELECT cs.id, cs.name, cs.file_path, cs.kind, cs.file_id FROM code_symbols cs
    WHERE cs.repo_id = ? AND cs.id NOT IN (SELECT callee_symbol_id FROM code_calls WHERE callee_symbol_id IS NOT NULL AND repo_id = ?)
  `)
              .all(repoId, repoId),
            // ── Symbols that are re-exported (barrel exports) ──
            // Populate the name set from `file_scope_bindings` where kind='re_export'.
            // `code_imports` only stores the target module path (e.g. './utils') — it
            // does NOT record the exported identifier name — so we cannot derive the
            // exported symbol name set from that table alone. Scope bindings, however,
            // capture the binding name (`export { foo } from './bar'` → name='foo').
            // Falling back to scope bindings is the correct fix; the previous
            // implementation compared module paths against symbol names and matched
            // essentially never, so the RE_EXPORTED_PENALTY was dead and the
            // NO_CALLERS_WEIGHT was always added even for barrel-re-exported symbols.
            reExportedNames = new Set(
              db
                .prepare(
                  "SELECT name FROM file_scope_bindings WHERE repo_id = ? AND kind = 're_export' AND name IS NOT NULL AND name != ''",
                )
                .all(repoId)
                .map((row) => row.name),
            ),
            // PERF: Batch-retrieved re-export target file IDs (replaces per-symbol SQL query).
            // Do NOT replace with per-element queries — see issue #138.
            // This Set must remain a pre-computed lookup; moving the query back inside the
            // Loop below reintroduces N+1 SQLite round-trips that dominate runtime for
            // Large repos (thousands of uncalled symbols → thousands of sequential queries).
            reExportedFileIds = new Set(
              db
                .prepare(
                  "SELECT DISTINCT target_file_id FROM code_imports WHERE import_type = 're-export' AND target_file_id IS NOT NULL",
                )
                .all()
                .map((r) => r.target_file_id),
            ),
            results = [];
          for (const sym of uncalledSymbols) {
            const isFileDead = deadFileSet.has(sym.file_id),
              isReExported = reExportedFileIds.has(sym.file_id),
              isNameReExported = reExportedNames.has(sym.name),
              signals = [];

            let confidence = 0;

            if (!isReExported && !isNameReExported) {
              confidence += DEAD_CODE.NO_CALLERS_WEIGHT;
              signals.push('no_callers');
            }
            if (isFileDead) {
              confidence += DEAD_CODE.UNREACHABLE_FILE_WEIGHT;
              signals.push('unreachable_file');
            }
            if (isNameReExported) {
              confidence -= DEAD_CODE.RE_EXPORTED_PENALTY;
              signals.push('re_exported');
            }

            if (!includeTests && /test|spec|__tests__|\.test\./.test(sym.file_path)) {
              // oxlint-disable-next-line no-continue
              continue;
            }
            if (confidence >= minConfidence) {
              results.push({
                symbol_id: sym.id,
                name: sym.name,
                kind: sym.kind,
                file: sym.file_path,
                confidence: Math.round(confidence * 100) / 100,
                signals,
              });
            }
          }

          return {
            dead_files: deadFiles.map((f) => ({ id: f.id, path: f.path })),
            dead_symbols: results,
            total_symbols: allFiles.length,
          };
        }
      }
    }
  }
}

module.exports = { getDeadCode };
