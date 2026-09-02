// Module boundary:
// Agent-facing coding intelligence orchestration. Composes existing memory,
// Code-index, doc-index, and static analysis read models into compact
// Before-coding context. Must not mutate memory or code indexes.

const codeSearch = require('../code-index/source-retrieval');
const memorySearch = require('../memory-domain/search');
const path = require('path');
const docIndex = require('../doc-index'),
  DEFAULT_LIMITS = {
    code: 8,
    memory: 5,
    docs: 5,
    relatedFiles: 8,
  };

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function uniq(items) {
  return [...new Set((items || []).filter(Boolean))];
}

function basename(file) {
  if (!file) {
    return '';
  }
  return String(file).split('/').pop() || String(file);
}

function normalizeName(text) {
  return String(text || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_./:-]+/g, ' ')
    .toLowerCase()
    .replace(
      /\b(get|set|create|add|insert|update|delete|remove|load|fetch|find|list|handle|service|manager|helper)\b/g,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

function taskTerms(task) {
  return normalizeName(task)
    .split(/\s+/)
    .filter((term) => term.length >= 3);
}

function inferRepoName(db, cwd) {
  const repos = db.prepare('SELECT name, path FROM code_repos ORDER BY updated_at DESC, indexed_at DESC').all(),
  resolvedCwd = !(repos.length === 0) ? (path.resolve(cwd || process.cwd()).toLowerCase()) : undefined,
  cwdMatch = !(repos.length === 0) ? (repos.find((repo) => {
      const repoPath = path.resolve(repo.path).toLowerCase();
      return resolvedCwd === repoPath || resolvedCwd.startsWith(`${repoPath}${path.sep}`);
    })) : undefined;
  if (repos.length === 0) {
    return null;
  }
  if (cwdMatch) {
    return cwdMatch.name;
  }
  return repos.length === 1 ? repos[0].name : null;
}

function getRepoRow(db, repoName) {
  const rows = db
    .prepare('SELECT id, name, path, file_count, symbol_count, head_commit FROM code_repos WHERE name = ?')
    .all(repoName);
  return rows[0] || null;
}

function listDocRepos(db, preferredName) {
  const rows = db.prepare('SELECT id, name FROM doc_repos ORDER BY name').all();
  if (!preferredName) {
    return rows;
  }
  return rows.sort((a, b) => {
    if (a.name === preferredName) {
      return -1;
    }
    if (b.name === preferredName) {
      return 1;
    }
    return 0;
  });
}

function mapCodeResult(result) {
  return {
    symbol: result.symbol,
    qualified_name: result.qualified_name,
    kind: result.kind,
    file: result.file,
    line: result.line,
    score: Number(result.score || 0),
    signature: result.signature || '',
    reason: 'Matched task terms in indexed symbol name, signature, docs, or body preview.',
  };
}

function findSymbolRows(db, repoId, codeResults) {
  const rows = [],
    seen = new Set();
  for (const item of codeResults || []) {
    if (!item.file || !item.symbol) {
      // Skip incomplete search rows; preflight still has enough evidence from complete rows.
    } else {
      const matches = db
        .prepare(
          `SELECT id, name, qualified_name, kind, file_path, start_line
         FROM code_symbols
         WHERE repo_id = ? AND file_path = ? AND (name = ? OR qualified_name = ?)
         LIMIT 3`,
        )
        .all(repoId, item.file, item.symbol, item.qualified_name || item.symbol);
      for (const row of matches) {
        if (!seen.has(row.id)) {
          seen.add(row.id);
          rows.push(row);
        }
      }
    }
  }
  return rows;
}

function getRelatedFiles(db, repoId, symbolRows, codeResults, limit) {
  const files = [];
  for (const result of codeResults || []) {
    files.push(result.file);
  }
  for (const symbol of symbolRows.slice(0, 5)) {
    const rows = db
      .prepare(
        `SELECT DISTINCT cs.file_path AS file_path
         FROM code_calls cc
         JOIN code_symbols cs ON cs.id = cc.caller_symbol_id
         WHERE cc.repo_id = ? AND (cc.callee_symbol_id = ? OR cc.callee_name = ?)
         UNION
         SELECT DISTINCT cs.file_path AS file_path
         FROM code_calls cc
         JOIN code_symbols cs ON cs.id = cc.callee_symbol_id
         WHERE cc.repo_id = ? AND cc.caller_symbol_id = ?
         LIMIT ?`,
      )
      .all(repoId, symbol.id, symbol.name, repoId, symbol.id, limit);
    for (const row of rows) {
      files.push(row.file_path);
    }
  }
  return uniq(files).slice(0, limit);
}

function getLikelyTests(db, repoId, relatedFiles, limit) {
  if (!relatedFiles.length) {
    return [];
  }
  const bases = relatedFiles
      .map((file) =>
        basename(file)
          .replace(/\.[^.]+$/, '')
          .toLowerCase(),
      )
      .filter(Boolean),
    rows = db
      .prepare(
        `SELECT path
       FROM code_files
       WHERE repo_id = ?
         AND (LOWER(path) LIKE '%test%' OR LOWER(path) LIKE '%spec%')
       ORDER BY path
       LIMIT 200`,
      )
      .all(repoId),
    scored = rows
      .map((row) => {
        const lower = row.path.toLowerCase(),
          score = bases.reduce((acc, base) => acc + (lower.includes(base) ? 1 : 0), 0);
        return { path: row.path, score };
      })
      .filter((row) => row.score > 0 || relatedFiles.some((file) => row.path.includes(basename(file).split('.')[0])))
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return uniq(scored.map((row) => row.path)).slice(0, limit);
}

function getMemoryMatches(deps, task, repoName, limit) {
  const result = memorySearch.search(deps, {
    query: task,
    project: repoName,
    limit: String(limit),
  });
  return (result.results || []).map((memory) => ({
    id: memory.id,
    title: memory.title,
    type: memory.type,
    project: memory.project,
    confidence: Number(memory._score || 0),
    snippet: memory.snippet || '',
    trust_score: memory.trust_score ?? null,
  }));
}

function getDocMatches(db, task, repoName, limit) {
  const docRepos = listDocRepos(db, repoName).slice(0, 2),
    out = [];
  for (const repo of docRepos) {
    const result = docIndex.searchDocs(db, repo.id, task, {});
    for (const item of result.results || []) {
      out.push({
        repo: repo.name,
        title: item.title,
        file: item.file_path,
        role: item.role,
        level: item.level,
        snippet: item.snippet || '',
      });
      if (out.length >= limit) {
        return out;
      }
    }
  }
  return out;
}

function duplicateWarnings(task, codeItems) {
  const terms = taskTerms(task),
    warnings = [],
  overlapThreshold = !(terms.length === 0) ? (Math.min(2, Math.max(1, terms.length))) : undefined;
  if (terms.length === 0) {
    return warnings;
  }
  for (const item of codeItems.slice(0, 6)) {
    const normalizedSymbol = normalizeName(`${item.symbol} ${item.qualified_name || ''} ${item.signature || ''}`),
      overlap = terms.filter((term) => normalizedSymbol.includes(term));
    if (overlap.length >= overlapThreshold) {
      warnings.push({
        symbol: item.symbol,
        file: item.file,
        reason: `Existing symbol overlaps task intent (${overlap.slice(0, 4).join(', ')}).`,
      });
    }
  }
  return warnings;
}

function riskLevel({ codeItems, memories, warnings, relatedFiles }) {
  if (warnings.length >= 2 || codeItems.length >= 5) {
    return 'high';
  }
  if (warnings.length || codeItems.length >= 2 || memories.length || relatedFiles.length >= 4) {
    return 'medium';
  }
  return 'low';
}

function recommendedAction(risk, warnings, codeItems) {
  if (warnings.length > 0) {
    const top = warnings[0];
    return `Review and extend existing ${top.symbol} in ${top.file} before creating new code.`;
  }
  if (codeItems.length > 0) {
    const top = codeItems[0];
    return `Start from ${top.symbol} in ${top.file}; confirm whether it already owns this behavior.`;
  }
  if (risk === 'low') {
    return 'No obvious existing implementation found; proceed with a small plan and save the decision after implementation.';
  }
  return 'Review the related files and memories before editing.';
}

function preflight(deps, args) {
  const task = args.task || args.query || args._?.[0];
  if (!task) {
    return deps.jsonErrNoExit
      ? deps.jsonErrNoExit('Usage: preflight --task <task> --repo <repo>')
      : { error: 'Missing task' };
  }
  const db = deps.getDb ? deps.getDb() : deps.db,
    repoName = args.repo || inferRepoName(db, process.cwd()),
  repo = repoName ? (getRepoRow(db, repoName)) : undefined;
  if (!repoName) {
    return deps.jsonErrNoExit
      ? deps.jsonErrNoExit('Usage: preflight --task <task> --repo <repo>')
      : { error: 'Missing repo' };
  }

  if (!repo) {
    return deps.jsonErrNoExit
      ? deps.jsonErrNoExit(`Repo "${repoName}" not found. Run index-repo first.`)
      : { error: `Repo "${repoName}" not found. Run index-repo first.` };
  }

  const codeLimit = clampInt(
      args['code-limit'] || args.codeLimit || args['max-results'] || args.top,
      DEFAULT_LIMITS.code,
      1,
      25,
    ),
    memoryLimit = clampInt(args['memory-limit'] || args.memoryLimit, DEFAULT_LIMITS.memory, 0, 15),
    docLimit = clampInt(args['doc-limit'] || args.docLimit, DEFAULT_LIMITS.docs, 0, 15),
    codeSearchResult = codeSearch.searchCode(task, repoName, null, codeLimit),
    codeItems = (codeSearchResult.results || []).map(mapCodeResult),
    symbolRows = findSymbolRows(db, repo.id, codeItems),
    relatedFiles = getRelatedFiles(db, repo.id, symbolRows, codeItems, DEFAULT_LIMITS.relatedFiles),
    likelyTests = getLikelyTests(db, repo.id, relatedFiles, DEFAULT_LIMITS.relatedFiles),
    memories = memoryLimit > 0 ? getMemoryMatches(deps, task, repoName, memoryLimit) : [],
    docs = docLimit > 0 ? getDocMatches(db, task, repoName, docLimit) : [],
    warnings = duplicateWarnings(task, codeItems),
    risk = riskLevel({ codeItems, memories, warnings, relatedFiles });
  let duplicateRisk = 'low',
  structuralDuplicates = (() => {

    if (risk === 'high') {
      duplicateRisk = 'high';
    } else if (warnings.length) {
      duplicateRisk = 'medium';
    }
  
    // Enrich with structural duplicates and symbol metadata
    
  return ([]);
})();try {
    const dupesModule = require('./dupes'),
      persistedDupes = dupesModule.loadDupes(db, repo.id);
    structuralDuplicates = persistedDupes
      .filter((g) => g.instances && g.instances.length >= 2)
      .slice(0, 3)
      .map((g) => ({
        intent: g.intent,
        risk: g.risk,
        instances: g.instances.map((i) => `${i.file_path}:${i.symbol_name}`),
        recommendation: g.recommendation,
      }));
  } catch {
    // Dupes table may not exist yet — graceful degradation
  }

  // Enrich top code items with metadata
  let enrichedCodeItems = codeItems,
  runtimeHotness = (() => {

    try {
      const enrichment = require('./symbol-enrichment');
      enrichedCodeItems = codeItems.slice(0, 5).map((item) => {
        const symRow = symbolRows.find((s) => s.name === item.symbol && s.file_path === item.file);
        if (symRow) {
          const meta = enrichment.getSymbolMeta(db, symRow.id);
          if (meta) {
            return {
              ...item,
              intent: meta.intent || undefined,
              constraints: meta.constraints ? JSON.parse(meta.constraints) : undefined,
            };
          }
        }
        return item;
      });
    } catch {
      // Enrichment module may not exist yet
    }
  
    // Enrich with runtime hotness data if available
    
  return (null);
})();try {
    const runtimeIngest = require('./runtime-ingest'),
      hotSymbols = runtimeIngest.getHotSymbols(db, repo.id, 50),
      // Check if any of the top code items are hot paths
      topFiles = codeItems.slice(0, 3).map((item) => item.file),
      hotMatches = hotSymbols.filter(
        (s) => s.file_path && topFiles.some((f) => s.file_path.includes(f) || f.includes(s.file_path)),
      );

    if (hotMatches.length > 0) {
      runtimeHotness = {
        is_hot_path: true,
        hot_matches: hotMatches.slice(0, 3).map((s) => ({
          symbol: s.function_name,
          file: s.file_path,
          traffic: s.traffic,
          hit_count: s.hit_count,
        })),
      };
    }
  } catch {
    // Runtime data not available — graceful degradation
  }

  // Recalculate risk with runtime consideration
  const effectiveRisk =
    runtimeHotness && runtimeHotness.is_hot_path
      ? risk === 'low'
        ? 'medium'
        : risk === 'medium'
          ? 'high'
          : risk
      : risk;

  return {
    task_summary: task,
    repo: repoName,
    likely_existing_code: enrichedCodeItems,
    similar_past_tasks: memories,
    related_files: relatedFiles,
    tests_likely_affected: likelyTests,
    relevant_docs: docs,
    duplicate_risk: duplicateRisk,
    duplicate_warnings: warnings,
    structural_duplicates: structuralDuplicates,
    runtime_hotness: runtimeHotness,
    risk: effectiveRisk,
    recommended_action: recommendedAction(effectiveRisk, warnings, codeItems),
    evidence: {
      code_search_strategy: codeSearchResult.strategy,
      code_results_considered: codeItems.length,
      memory_results_considered: memories.length,
      doc_results_considered: docs.length,
      indexed_repo: {
        files: repo.file_count,
        symbols: repo.symbol_count,
        head_commit: repo.head_commit,
      },
    },
  };
}

function agentPack(deps, args) {
  const result = preflight(deps, args),
  relevantSymbols = !(result.error) ? (result.likely_existing_code.slice(0, 8).map((item) => ({
      symbol: item.symbol,
      file: item.file,
      line: item.line,
      reason: item.reason,
    }))) : undefined,
  pastDecisions = !(result.error) ? (result.similar_past_tasks.slice(0, 5).map((memory) => ({
      id: memory.id,
      title: memory.title,
      type: memory.type,
      snippet: memory.snippet,
    }))) : undefined,
  mustRead = !(result.error) ? (uniq([
      ...result.related_files.slice(0, 5),
      ...result.tests_likely_affected.slice(0, 3),
      ...result.relevant_docs.slice(0, 3).map((doc) => doc.file),
    ]).slice(0, 10)) : undefined,
  suggestedPlan = !(result.error) ? ([]) : undefined;
  if (result.error) {
    return result;
  }
  if (result.duplicate_warnings.length > 0) {
    suggestedPlan.push('Inspect the existing matching symbol before creating new code.');
    suggestedPlan.push('Prefer extending or reusing the existing abstraction unless it is demonstrably wrong.');
  } else if (result.likely_existing_code.length > 0) {
    suggestedPlan.push('Open the top matching files and determine ownership for the requested behavior.');
  } else {
    suggestedPlan.push(
      'No strong existing implementation found; choose the smallest cohesive location for the change.',
    );
  }
  if (result.tests_likely_affected.length > 0) {
    suggestedPlan.push('Update or add tests near the likely affected test files.');
  }
  suggestedPlan.push('After editing, save the implementation decision and link it to changed symbols.');

  return {
    task_summary: result.task_summary,
    repo: result.repo,
    must_read: mustRead,
    relevant_symbols: relevantSymbols,
    past_decisions: pastDecisions,
    duplicate_warnings: result.duplicate_warnings,
    risk: result.risk,
    recommended_action: result.recommended_action,
    suggested_plan: suggestedPlan,
    compact_context: {
      related_files: result.related_files.slice(0, 8),
      tests_likely_affected: result.tests_likely_affected.slice(0, 5),
      relevant_docs: result.relevant_docs.slice(0, 5),
      evidence: result.evidence,
    },
  };
}

module.exports = {
  preflight,
  agentPack,
  _private: {
    inferRepoName,
    normalizeName,
    duplicateWarnings,
    riskLevel,
  },
};
