#!/usr/bin/env node
const { DB_PATH, sqlJson, sqlRun, sqlRaw, ensureDb, getDb, getEngine, jsonOut, jsonErrNoExit, parseArgs, MemoryError } = require('./db');
const { getConfig } = require('./config');
const { TRUST_DELTA, DEDUP, TIME_WINDOWS, RESULT_LIMITS, RANKING, CONTEXT, CAPTURE_PASSIVE } = require('./constants');

const deps = { sqlJson, sqlRun, sqlRaw };

const codeAnalysis = require('./code-analysis');
const gitAnalysis = require('./git-analysis');
const docIndexer = require('./doc-indexer');
const responseMeta = require('./response-meta');
const wireFormat = require('./wire-format');
const astPatterns = require('./ast-patterns');

const codeIndexingService = require('./services/code-indexing');
const codeSearchService = require('./services/code-search');

const obsCmd = require('./commands/observation');
const sesCmd = require('./commands/session');
const symCmd = require('./commands/symbols');
const searchCmd = require('./commands/search');
const wsCmd = require('./commands/workspace');
const wfCmd = require('./commands/workflow');
const codeCmd = require('./commands/code-impl');

const obsDA = require('./data-access/observations');
const wsDA = require('./data-access/workspaces');
const symDA = require('./data-access/symbols');
const dedupService = require('./services/dedup');
const recoveryService = require('./services/recovery');

const path = require('path');
const fs = require('fs');

const _STRIP_FIELDS = ['symbol_id', 'id'];

const TOOL_TIERS = {
  core: new Set(['search', 'save', 'context', 'search-code', 'get-code-source', 'importance', 'outline', 'winnow', 'dream']),
  standard: new Set([
    'search', 'save', 'context', 'search-code', 'get-code-source',
    'importance', 'outline', 'winnow', 'dream',
    'complexity', 'dead-code', 'hotspots', 'blast-radius',
    'call-hierarchy', 'cycles', 'coupling',
  ]),
  full: null,
};

function _readTierConfig() {
  const configPath = getConfig().tier_config_path;
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const cleaned = raw.replace(/\/\/.*$/gm, '');
    return JSON.parse(cleaned);
  } catch (_) {
    return { tier: 'full' };
  }
}

const softDeleteObservation = (id) => obsDA.softDeleteObservation(deps, id);

const commands = {
  'session-start': (args) => sesCmd.sessionStart({ sqlJson, sqlRun, _readTierConfig, TOOL_TIERS, commands, softDeleteObservation }, args),
  'session-end': (args) => sesCmd.sessionEnd({ sqlJson, sqlRun, softDeleteObservation }, args),
  save: (args) => obsCmd.save({ sqlJson, sqlRun, sqlRaw, jsonErrNoExit }, args),
  search: (args) => searchCmd.search({ sqlJson, sqlRun, jsonErrNoExit, searchCode: (q, repo, kind, limit) => codeSearchService.searchCode(q, repo, kind, limit) }, args),
  context: (args) => searchCmd.context({ sqlJson, sqlRun, jsonErrNoExit, searchCode: (q, repo, kind, limit) => codeSearchService.searchCode(q, repo, kind, limit) }, args),
  get: (args) => obsCmd.get({ sqlJson, sqlRun, jsonErrNoExit }, args),
  update: (args) => obsCmd.update({ sqlJson, sqlRun, jsonErrNoExit }, args),
  'delete': (args) => obsCmd.del({ sqlJson, sqlRun, jsonErrNoExit }, args),
  timeline: (args) => obsCmd.timeline({ sqlJson, sqlRun, jsonErrNoExit }, args),
  'suggest-topic-key': (args) => obsCmd.suggestTopicKey(args),
  'save-prompt': (args) => obsCmd.savePrompt({ sqlJson, sqlRun, jsonErrNoExit }, args),
  'capture-passive': (args) => obsCmd.capturePassive({ sqlJson, sqlRun, jsonErrNoExit }, args),
  stats: () => obsCmd.getStats(deps),
  'session-summary': (args) => sesCmd.sessionSummary({ sqlJson, jsonErrNoExit }, args),
  'link-symbol': (args) => symCmd.linkSymbol({ sqlJson, sqlRun, jsonErrNoExit }, args),
  'auto-link': (args) => symCmd.autoLink({ sqlJson, sqlRun, jsonErrNoExit }, args),
  'adjust-trust': (args) => symCmd.adjustTrust({ sqlJson, sqlRun, jsonErrNoExit }, args),
  'record-recall': (args) => symCmd.recordRecall({ sqlJson, sqlRun, jsonErrNoExit }, args),
  'trust-recovery': (args) => sesCmd.trustRecovery(args),
  'stale-links': (args) => symCmd.staleLinks({ sqlJson, jsonErrNoExit }, args),
  'sync-code-trust': (args) => symCmd.syncCodeTrust({ sqlJson, jsonErrNoExit }, args),
  'list-projects': () => wsCmd.listProjects(deps),
  'list-workspaces': () => wsCmd.listWorkspaces(deps),
  'create-workspace': (args) => wsCmd.createWorkspace(deps, args),
  'archive-workspace': (args) => wsCmd.archiveWorkspace(deps, args),
  'symbol-cluster': (args) => symCmd.symbolCluster({ sqlJson, jsonErrNoExit }, args),
  related: (args) => symCmd.related({ sqlJson, jsonErrNoExit }, args),
  'check-dup': (args) => searchCmd.checkDuplicate({ sqlJson, jsonErrNoExit }, args),
  'mark-dup': (args) => searchCmd.markDuplicate({ sqlJson, sqlRun, jsonErrNoExit }, args),
  'auto-recover': (args) => sesCmd.autoRecover({ sqlJson, sqlRun, jsonErrNoExit, softDeleteObservation }, args),
  'recover-orphans': () => sesCmd.recoverOrphans({ sqlJson, sqlRun, softDeleteObservation }),
  'save-workflow': (args) => wfCmd.saveWorkflow({ sqlJson, sqlRun, jsonErrNoExit }, args),
  'record-step': (args) => wfCmd.recordStep({ sqlJson, sqlRun, jsonErrNoExit }, args),
  'step-outcome': (args) => wfCmd.stepOutcome({ sqlJson, sqlRun, jsonErrNoExit }, args),
  'get-workflow': (args) => wfCmd.getWorkflow({ sqlJson, jsonErrNoExit }, args),
  init: () => { ensureDb(); return { ok: true, db: DB_PATH, engine: getEngine() }; },
  compact: () => sesCmd.compact(),
  dream: () => sesCmd.dream({ sqlJson, sqlRun, softDeleteObservation }),
  'index-repo': (args) => codeCmd.indexRepo(args),
  'reindex-repo': (args) => codeCmd.reindexRepo(args),
  'search-code': (args) => codeCmd.searchCode(args),
  'get-code-source': (args) => codeCmd.getCodeSource(args),
  'list-code-repos': () => codeCmd.listCodeRepos(),
  'remove-code-repo': (args) => codeCmd.removeCodeRepo(args),
};

function _dispatch(cmd, repoName, fn) {
  if (!repoName) {
    return jsonErrNoExit(`Missing --repo. Usage: ${cmd} ${_USAGE[cmd] || ''}`);
  }
  const repoRow = sqlJson('SELECT id, path, head_commit FROM code_repos WHERE name = ?', [repoName]);
  if (!repoRow.length) {
    return jsonErrNoExit(`Repo "${repoName}" not found. Run index-repo first.`);
  }
  return fn(repoRow[0]);
}

function _dispatchDoc(cmd, repoName, fn) {
  if (!repoName) {
    return jsonErrNoExit(`Missing --repo. Usage: ${cmd} ${_USAGE[cmd] || ''}`);
  }
  const repoRow = sqlJson('SELECT id FROM doc_repos WHERE name = ?', [repoName]);
  if (!repoRow.length) {
    return jsonErrNoExit(`Doc repo "${repoName}" not found. Run index-docs first.`);
  }
  return fn(repoRow[0]);
}

function _wrapAnalysis(toolName, data, repoRow, startTime, format) {
  const toolMap = {
    'import-graph': 'getImportGraph', 'call-hierarchy': 'getCallHierarchy', 'blast-radius': 'getBlastRadius',
    'dead-code': 'getDeadCode', complexity: 'getComplexity', outline: 'getFileOutline',
    churn: 'getChurn', hotspots: 'getHotspots', cycles: 'getDependencyCycles',
    importance: 'getSymbolImportance', coupling: 'getCouplingMetrics', extractable: 'getExtractionCandidates',
    hierarchy: 'getClassHierarchy', 'signal-chains': 'getSignalChains', 'layer-violations': 'getLayerViolations',
    winnow: 'winnow', 'ast-patterns': 'astPatterns', provenance: 'getProvenance',
    untested: 'getUntestedSymbols', 'pr-risk': 'getPrRiskProfile',
  };
  const internalName = toolMap[toolName] || toolName;
  const wrapped = responseMeta.buildEnvelope({
    toolName: internalName, data, db: getDb(), repoId: repoRow.id,
    repoPath: repoRow.path, storedHeadCommit: repoRow.head_commit || null, startTime,
  });
  if (format === 'compact') {
    wrapped.data = wireFormat.compactResponse(wrapped.data, { stripFields: _STRIP_FIELDS });
  } else if (format === 'auto') {
    const autoFmt = wireFormat.autoFormat(wrapped.data);
    if (autoFmt === 'compact') {
      wrapped.data = wireFormat.compactResponse(wrapped.data, { stripFields: _STRIP_FIELDS });
    }
  }
  return wrapped;
}

const _USAGE = {
  'import-graph': '--repo X [--file F] [--direction imports|importers|both] [--depth N]',
  'call-hierarchy': '--symbol S --repo X [--direction callers|callees] [--depth N]',
  'blast-radius': '--symbol S --repo X [--depth N]',
  'dead-code': '--repo X [--min-confidence 0.5] [--include-tests true]',
  complexity: '--repo X [--symbol S | --file F]',
  churn: '--repo X [--file F] [--days 90] [--refresh]',
  hotspots: '--repo X [--top N] [--days N]',
  cycles: '--repo X',
  importance: '--repo X [--top N] [--scope dir/]',
  coupling: '--repo X [--file F] [--sort-by instability|afferent|efferent]',
  extractable: '--repo X [--min-complexity N] [--min-callers N] [--top N]',
  hierarchy: '--repo X --symbol S [--direction both|ancestors|descendants]',
  'signal-chains': '--repo X [--kind http|cli] [--symbol S] [--max-depth N]',
  'layer-violations': '--repo X [--rules JSON]',
  winnow: '--repo X [--kind K] [--min-complexity N] [--top N] ...',
  'ast-patterns': '--repo X [--category C] [--pattern P] [--limit N]',
  provenance: '--repo X --symbol S',
  untested: '--repo X [--min-confidence 0.5] [--include-private]',
  'pr-risk': '--repo X [--branch B] [--base B]',
  'doc-orphans': '--repo X [--include-same-doc]',
  'stale-pages': '--repo X',
  'doc-duplicates': '--repo X',
  'reindex-docs': '--repo X [--mode full|incremental] [--ignore GLOB]',
  'doc-search': '--query Q --repo X [--level N] [--role TYPE]',
  'doc-outline': '--repo X [--file F]',
  backlinks: '--repo X --path F',
  'broken-links': '--repo X',
  glossary: '--repo X [--term T]',
  'tutorial-path': '--section S --repo X',
  'code-examples': '--query Q --repo X [--lang X]',
};

Object.assign(commands, {
  'import-graph': (args) => _dispatch('import-graph', args.repo, (r) => codeAnalysis.getImportGraph(getDb(), r.id, { file: args.file || null, direction: args.direction || 'both', depth: parseInt(args.depth || '1') })),
  'call-hierarchy': (args) => {
    if (!args.symbol) return jsonErrNoExit('Missing --symbol. Usage: call-hierarchy --symbol S --repo X');
    return _dispatch('call-hierarchy', args.repo, (r) => codeAnalysis.getCallHierarchy(getDb(), r.id, { symbol: args.symbol, direction: args.direction || 'callers', depth: parseInt(args.depth || '3') }));
  },
  'blast-radius': (args) => {
    if (!args.symbol) return jsonErrNoExit('Missing --symbol. Usage: blast-radius --symbol S --repo X');
    return _dispatch('blast-radius', args.repo, (r) => codeAnalysis.getBlastRadius(getDb(), r.id, { symbol: args.symbol, depth: parseInt(args.depth || '3') }));
  },
  'dead-code': (args) => _dispatch('dead-code', args.repo, (r) => codeAnalysis.getDeadCode(getDb(), r.id, { minConfidence: parseFloat(args['min-confidence'] || '0.5'), includeTests: args['include-tests'] === 'true' })),
  complexity: (args) => _dispatch('complexity', args.repo, (r) => {
    const symbolId = args.symbol ? (sqlJson('SELECT id FROM code_symbols WHERE repo_id = ? AND name = ?', [r.id, args.symbol])[0]?.id ?? null) : null;
    return codeAnalysis.getComplexity(getDb(), r.id, symbolId);
  }),
  outline: (args) => { if (!args.file) return jsonErrNoExit('Missing --file. Usage: outline --file F --repo X'); return _dispatch('outline', args.repo, (r) => codeAnalysis.getFileOutline(getDb(), r.id, args.file)); },
  churn: (args) => _dispatch('churn', args.repo, (r) => gitAnalysis.getChurn(getDb(), r.id, args.file || '__all__', parseInt(args.days || '90'), args.refresh === 'true')),
  hotspots: (args) => _dispatch('hotspots', args.repo, (r) => codeAnalysis.getHotspots(getDb(), r.id, { top: args.top ? parseInt(args.top) : 20, days: args.days ? parseInt(args.days) : 90 })),
  cycles: (args) => _dispatch('cycles', args.repo, (r) => codeAnalysis.getDependencyCycles(getDb(), r.id)),
  importance: (args) => _dispatch('importance', args.repo, (r) => codeAnalysis.getSymbolImportance(getDb(), r.id, { top: args.top ? parseInt(args.top) : 20, scope: args.scope || null })),
  coupling: (args) => _dispatch('coupling', args.repo, (r) => codeAnalysis.getCouplingMetrics(getDb(), r.id, { file: args.file || null, minCa: args['min-ca'] ? parseInt(args['min-ca']) : 0, sortBy: args['sort-by'] || 'instability' })),
  extractable: (args) => _dispatch('extractable', args.repo, (r) => codeAnalysis.getExtractionCandidates(getDb(), r.id, { minComplexity: args['min-complexity'] ? parseInt(args['min-complexity']) : 5, minCallers: args['min-callers'] ? parseInt(args['min-callers']) : 2, top: args.top ? parseInt(args.top) : 20 })),
  hierarchy: (args) => _dispatch('hierarchy', args.repo, (r) => codeAnalysis.getClassHierarchy(getDb(), r.id, { class: args.class, symbol: args.symbol, direction: args.direction || 'both' })),
  'signal-chains': (args) => _dispatch('signal-chains', args.repo, (r) => codeAnalysis.getSignalChains(getDb(), r.id, { kind: args.kind || null, symbol: args.symbol || null, maxDepth: args['max-depth'] ? parseInt(args['max-depth']) : 5 })),
  'layer-violations': (args) => { let rules = null; if (args.rules) { try { rules = JSON.parse(args.rules); } catch (e) { return jsonErrNoExit(`Invalid rules JSON: ${e.message}`); } } return _dispatch('layer-violations', args.repo, (r) => codeAnalysis.getLayerViolations(getDb(), r.id, { rules })); },
  winnow: (args) => _dispatch('winnow', args.repo, (repoRow) => codeAnalysis.winnow(getDb(), repoRow.id, { kind: args.kind || null, minComplexity: args['min-complexity'] ? parseInt(args['min-complexity']) : null, minChurn: args['min-churn'] ? parseInt(args['min-churn']) : null, minPageRank: args['min-pagerank'] ? parseFloat(args['min-pagerank']) : null, minCallers: args['min-callers'] ? parseInt(args['min-callers']) : null, fileGlob: args['file-glob'] || null, nameRegex: args['name-regex'] || null, sortBy: args['sort-by'] || 'pagerank', top: args.top ? parseInt(args.top) : 20 })),
  'ast-patterns': (args) => _dispatch('ast-patterns', args.repo, (repoRow) => astPatterns.scanAstPatterns(getDb(), repoRow.id, { category: args.category || 'all', patterns: args.pattern ? args.pattern.split(',').map((s) => s.trim()) : [], limit: args.limit ? parseInt(args.limit) : 200 })),
  provenance: (args) => _dispatch('provenance', args.repo, (repoRow) => gitAnalysis.getProvenance(getDb(), repoRow.id, args.symbol)),
  untested: (args) => _dispatch('untested', args.repo, (repoRow) => codeAnalysis.getUntestedSymbols(getDb(), repoRow.id, { minConfidence: args['min-confidence'] ? parseFloat(args['min-confidence']) : 0.5, includePrivate: args['include-private'] === 'true' })),
  'pr-risk': (args) => _dispatch('pr-risk', args.repo, (repoRow) => codeAnalysis.getPrRiskProfile(getDb(), repoRow.id, { branch: args.branch || 'HEAD', base: args.base || 'main' })),
  'doc-orphans': (args) => _dispatchDoc('doc-orphans', args.repo, (r) => docIndexer.getOrphanSections(getDb(), r.id, { includeSameDoc: args['include-same-doc'] === 'true' })),
  'doc-coverage': (args) => {
    const codeRepo = args.repo; const docRepo = args['doc-repo'] || codeRepo;
    if (!codeRepo) return jsonErrNoExit('Missing --repo');
    const codeRepoRow = sqlJson('SELECT id FROM code_repos WHERE name = ?', [codeRepo]);
    if (!codeRepoRow.length) return jsonErrNoExit(`Code repo "${codeRepo}" not found. Run index-repo first.`);
    const docRepoRow = sqlJson('SELECT id FROM doc_repos WHERE name = ?', [docRepo]);
    if (!docRepoRow.length) return jsonErrNoExit(`Doc repo "${docRepo}" not found. Run index-docs first.`);
    return docIndexer.getDocCoverage(getDb(), codeRepoRow[0].id, docRepoRow[0].id);
  },
  'stale-pages': (args) => _dispatchDoc('stale-pages', args.repo, (r) => docIndexer.getStalePages(getDb(), r.id)),
  'doc-duplicates': (args) => _dispatchDoc('doc-duplicates', args.repo, (r) => docIndexer.getDuplicateSections(getDb(), r.id)),
  'index-docs': async (args) => {
    const docPath = args.path; const name = args.name;
    if (!docPath || !name) return jsonErrNoExit('Usage: index-docs --path P --name X [--ignore GLOB]');
    return docIndexer.indexDocs(getDb(), path.resolve(docPath), name, args.ignore || null);
  },
  'reindex-docs': async (args) => _dispatchDoc('reindex-docs', args.repo, async (r) => docIndexer.reindexDocs(getDb(), r.id, args.mode || 'full', args.ignore || null)),
  'doc-search': (args) => { if (!args.query) return jsonErrNoExit('Missing --query. Usage: doc-search --query Q --repo X'); return _dispatchDoc('doc-search', args.repo, (r) => docIndexer.searchDocs(getDb(), r.id, args.query, { level: args.level ? parseInt(args.level) : null, role: args.role || null })); },
  'doc-outline': (args) => _dispatchDoc('doc-outline', args.repo, (r) => docIndexer.getDocOutline(getDb(), r.id, args.file || null)),
  backlinks: (args) => { if (!args.path) return jsonErrNoExit('Missing --path. Usage: backlinks --repo X --path F'); return _dispatchDoc('backlinks', args.repo, (r) => docIndexer.getBacklinks(getDb(), r.id, args.path)); },
  'broken-links': (args) => _dispatchDoc('broken-links', args.repo, (r) => ({ broken_links: docIndexer.getBrokenLinks(getDb(), r.id) })),
  glossary: (args) => _dispatchDoc('glossary', args.repo, (r) => docIndexer.lookupTerm(getDb(), r.id, args.term || null)),
  'tutorial-path': (args) => { if (!args.section) return jsonErrNoExit('Missing --section. Usage: tutorial-path --section S --repo X'); return _dispatchDoc('tutorial-path', args.repo, (r) => docIndexer.getTutorialPath(getDb(), r.id, parseInt(args.section))); },
  'code-examples': (args) => { if (!args.query) return jsonErrNoExit('Missing --query. Usage: code-examples --query Q --repo X'); return _dispatchDoc('code-examples', args.repo, (r) => docIndexer.findCodeExamples(getDb(), r.id, args.query, args.lang || null)); },
});

const _ANALYSIS_TOOLS = new Set([
  'import-graph', 'call-hierarchy', 'blast-radius', 'dead-code', 'complexity', 'outline',
  'churn', 'hotspots', 'cycles', 'importance', 'coupling', 'extractable', 'hierarchy',
  'signal-chains', 'layer-violations', 'winnow', 'ast-patterns', 'provenance', 'untested', 'pr-risk',
]);

const args = parseArgs(process.argv);
const cmd = process.argv[2];

(async () => {
  ensureDb();
  const db = getDb();
  const format = args.format || 'json';

  if (cmd && commands[cmd]) {
    const startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
    let result;
    try {
      result = await commands[cmd](args);
    } catch (e) {
      if (e instanceof MemoryError) {
        process.stderr.write(`${JSON.stringify({ error: e.message })}\n`);
        process.exit(1);
      }
      throw e;
    }

    if (result && result.error) {
      process.stderr.write(`${JSON.stringify(result)}\n`);
      process.exit(1);
    }

    if (_ANALYSIS_TOOLS.has(cmd) && !result.error) {
      const repoName = args.repo;
      if (repoName) {
        const repoRow = sqlJson('SELECT id, path, head_commit FROM code_repos WHERE name = ?', [repoName]);
        if (repoRow.length > 0) {
          jsonOut(_wrapAnalysis(cmd, result, repoRow[0], startTime, format));
          return;
        }
      }
    }

    jsonOut(result);
  } else {
    console.error(
      `Usage: memory-store <subcommand> [--option value ...]\n` +
        `Subcommands: ${Object.keys(commands).join(', ')}`,
    );
    process.exit(1);
  }
})();