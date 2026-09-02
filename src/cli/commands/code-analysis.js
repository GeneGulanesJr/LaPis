const codeAnalysis = require('../../code-analysis');
const { formatAnalysisForLlm } = require('../../platform/protocol/llm-format'),
  USAGE = {
    'import-graph': '--repo X [--file F] [--direction imports|importers|both] [--depth N]',
    'call-hierarchy': '--symbol S --repo X [--direction callers|callees] [--depth N]',
    'blast-radius': '--symbol S --repo X [--depth N]',
    'dead-code': '--repo X [--min-confidence 0.5] [--include-tests true]',
    outline: '--file F --repo X',
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
    'coding-context': '--repo X [--symbol S | --file F] [--depth N] [--top N]',
  },
  ANALYSIS_TOOLS = new Set([
    'import-graph',
    'call-hierarchy',
    'blast-radius',
    'dead-code',
    'complexity',
    'outline',
    'churn',
    'hotspots',
    'cycles',
    'importance',
    'coupling',
    'extractable',
    'hierarchy',
    'signal-chains',
    'layer-violations',
    'winnow',
    'ast-patterns',
    'provenance',
    'untested',
    'pr-risk',
    'coding-context',
  ]);

function _dispatch(cmd, repoName, fn, deps) {
  if (!repoName) {
    return deps.jsonErrNoExit(`Missing --repo. Usage: ${cmd} ${USAGE[cmd] || ''}`);
  }
  const repoRow = deps.sqlJson('SELECT id, path, head_commit FROM code_repos WHERE name = ?', [repoName]);
  if (!repoRow.length) {
    return deps.jsonErrNoExit(`Repo "${repoName}" not found. Run index-repo first.`);
  }
  return fn(repoRow[0]);
}

function _wrapAnalysis(toolName, data, repoRow, startTime, format, deps) {
  return formatAnalysisForLlm(toolName, data, repoRow, startTime, format, deps);
}

function register(commands, deps) {
  const { sqlJson, jsonErrNoExit, getDb } = deps,
    dispatchDeps = { sqlJson, jsonErrNoExit, getDb };

  commands['import-graph'] = (args) =>
    _dispatch(
      'import-graph',
      args.repo,
      (r) =>
        codeAnalysis.getImportGraph(getDb(), r.id, {
          file: args.file || null,
          direction: args.direction || 'both',
          depth: parseInt(args.depth || '1'),
        }),
      dispatchDeps,
    );
  commands['call-hierarchy'] = (args) => {
    if (!args.symbol) {
      return jsonErrNoExit('Missing --symbol. Usage: call-hierarchy --symbol S --repo X');
    }
    return _dispatch(
      'call-hierarchy',
      args.repo,
      (r) =>
        codeAnalysis.getCallHierarchy(getDb(), r.id, {
          symbol: args.symbol,
          direction: args.direction || 'callers',
          depth: parseInt(args.depth || '3'),
        }),
      dispatchDeps,
    );
  };
  commands['blast-radius'] = (args) => {
    if (!args.symbol) {
      return jsonErrNoExit('Missing --symbol. Usage: blast-radius --symbol S --repo X');
    }
    return _dispatch(
      'blast-radius',
      args.repo,
      (r) => codeAnalysis.getBlastRadius(getDb(), r.id, { symbol: args.symbol, depth: parseInt(args.depth || '3') }),
      dispatchDeps,
    );
  };
  commands['dead-code'] = (args) =>
    _dispatch(
      'dead-code',
      args.repo,
      (r) =>
        codeAnalysis.getDeadCode(getDb(), r.id, {
          minConfidence: parseFloat(args['min-confidence'] || '0.5'),
          includeTests: args['include-tests'] === 'true',
        }),
      dispatchDeps,
    );
  commands.complexity = (args) =>
    _dispatch(
      'complexity',
      args.repo,
      (r) => {
        const symbolId = args.symbol
          ? (sqlJson('SELECT id FROM code_symbols WHERE repo_id = ? AND name = ?', [r.id, args.symbol])[0]?.id ?? null)
          : null;
        return codeAnalysis.getComplexity(getDb(), r.id, symbolId);
      },
      dispatchDeps,
    );
  commands.outline = (args) => {
    if (!args.file) {
      return jsonErrNoExit('Missing --file. Usage: outline --file F --repo X');
    }
    return _dispatch('outline', args.repo, (r) => codeAnalysis.getFileOutline(getDb(), r.id, args.file), dispatchDeps);
  };
  commands.churn = (args) =>
    _dispatch(
      'churn',
      args.repo,
      (r) =>
        codeAnalysis.getChurn(
          getDb(),
          r.id,
          args.file || '__all__',
          parseInt(args.days || '90'),
          args.refresh === 'true',
        ),
      dispatchDeps,
    );
  commands.hotspots = (args) =>
    _dispatch(
      'hotspots',
      args.repo,
      (r) =>
        codeAnalysis.getHotspots(getDb(), r.id, {
          top: args.top ? parseInt(args.top) : 20,
          days: args.days ? parseInt(args.days) : 90,
        }),
      dispatchDeps,
    );
  commands.cycles = (args) =>
    _dispatch('cycles', args.repo, (r) => codeAnalysis.getDependencyCycles(getDb(), r.id), dispatchDeps);
  commands.importance = (args) =>
    _dispatch(
      'importance',
      args.repo,
      (r) =>
        codeAnalysis.getSymbolImportance(getDb(), r.id, {
          top: args.top ? parseInt(args.top) : 20,
          scope: args.scope || null,
        }),
      dispatchDeps,
    );
  commands.coupling = (args) =>
    _dispatch(
      'coupling',
      args.repo,
      (r) =>
        codeAnalysis.getCouplingMetrics(getDb(), r.id, {
          file: args.file || null,
          minCa: args['min-ca'] ? parseInt(args['min-ca']) : 0,
          sortBy: args['sort-by'] || 'instability',
        }),
      dispatchDeps,
    );
  commands.extractable = (args) =>
    _dispatch(
      'extractable',
      args.repo,
      (r) =>
        codeAnalysis.getExtractionCandidates(getDb(), r.id, {
          minComplexity: args['min-complexity'] ? parseInt(args['min-complexity']) : 5,
          minCallers: args['min-callers'] ? parseInt(args['min-callers']) : 2,
          top: args.top ? parseInt(args.top) : 20,
        }),
      dispatchDeps,
    );
  commands.hierarchy = (args) =>
    _dispatch(
      'hierarchy',
      args.repo,
      (r) =>
        codeAnalysis.getClassHierarchy(getDb(), r.id, {
          class: args.class,
          symbol: args.symbol,
          direction: args.direction || 'both',
        }),
      dispatchDeps,
    );
  commands['signal-chains'] = (args) =>
    _dispatch(
      'signal-chains',
      args.repo,
      (r) =>
        codeAnalysis.getSignalChains(getDb(), r.id, {
          kind: args.kind || null,
          symbol: args.symbol || null,
          maxDepth: args['max-depth'] ? parseInt(args['max-depth']) : 5,
        }),
      dispatchDeps,
    );
  commands['layer-violations'] = (args) => {
    let rules = null;
    if (args.rules) {
      try {
        rules = JSON.parse(args.rules);
      } catch (e) {
        return jsonErrNoExit(`Invalid rules JSON: ${e.message}`);
      }
    }
    return _dispatch(
      'layer-violations',
      args.repo,
      (r) => codeAnalysis.getLayerViolations(getDb(), r.id, { rules }),
      dispatchDeps,
    );
  };
  commands.winnow = (args) =>
    _dispatch(
      'winnow',
      args.repo,
      (repoRow) =>
        codeAnalysis.winnow(getDb(), repoRow.id, {
          kind: args.kind || null,
          minComplexity: args['min-complexity'] ? parseInt(args['min-complexity']) : null,
          minChurn: args['min-churn'] ? parseInt(args['min-churn']) : null,
          minPageRank: args['min-pagerank'] ? parseFloat(args['min-pagerank']) : null,
          minCallers: args['min-callers'] ? parseInt(args['min-callers']) : null,
          fileGlob: args['file-glob'] || null,
          nameRegex: args['name-regex'] || null,
          sortBy: args['sort-by'] || 'pagerank',
          top: args.top ? parseInt(args.top) : 20,
        }),
      dispatchDeps,
    );
  commands['ast-patterns'] = (args) =>
    _dispatch(
      'ast-patterns',
      args.repo,
      (repoRow) =>
        codeAnalysis.scanAstPatterns(getDb(), repoRow.id, {
          category: args.category || 'all',
          patterns: args.pattern ? args.pattern.split(',').map((s) => s.trim()) : [],
          limit: args.limit ? parseInt(args.limit) : 200,
        }),
      dispatchDeps,
    );
  commands.provenance = (args) =>
    _dispatch(
      'provenance',
      args.repo,
      (repoRow) => codeAnalysis.getProvenance(getDb(), repoRow.id, args.symbol),
      dispatchDeps,
    );
  commands.untested = (args) =>
    _dispatch(
      'untested',
      args.repo,
      (repoRow) =>
        codeAnalysis.getUntestedSymbols(getDb(), repoRow.id, {
          minConfidence: args['min-confidence'] ? parseFloat(args['min-confidence']) : 0.5,
          includePrivate: args['include-private'] === 'true',
        }),
      dispatchDeps,
    );
  commands['pr-risk'] = (args) =>
    _dispatch(
      'pr-risk',
      args.repo,
      (repoRow) =>
        codeAnalysis.getPrRiskProfile(getDb(), repoRow.id, {
          branch: args.branch || 'HEAD',
          base: args.base || 'main',
        }),
      dispatchDeps,
    );
  commands['coding-context'] = (args) => {
    if (!args.symbol && !args.file) {
      return jsonErrNoExit('Missing --symbol or --file. Usage: coding-context --repo X [--symbol S | --file F]');
    }
    return _dispatch(
      'coding-context',
      args.repo,
      (repoRow) =>
        codeAnalysis.getCodingContext(getDb(), repoRow.id, {
          symbol: args.symbol || null,
          file: args.file || null,
          depth: args.depth ? parseInt(args.depth) : 2,
          top: args.top ? parseInt(args.top) : 10,
          days: args.days ? parseInt(args.days) : 90,
        }),
      dispatchDeps,
    );
  };
}

module.exports = { register, USAGE, ANALYSIS_TOOLS, _wrapAnalysis };
