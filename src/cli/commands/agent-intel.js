const agentIntel = require('../../agent-intel/preflight'),
  USAGE = {
    preflight: '--repo X --task "what to implement" [--code-limit N] [--memory-limit N] [--doc-limit N]',
    'agent-pack': '--repo X --task "what to implement" [--code-limit N] [--memory-limit N] [--doc-limit N]',
    dupes: '--repo X [--threshold 0.65] [--top 20]',
    'enrich-symbols': '--repo X',
    'symbol-meta': '--symbol-id N',
    'audit-diff': '--repo X --files f1,f2 [--task "description"]',
    'runtime-ingest': '--repo X --coverage <path>',
    'hot-symbols': '--repo X [--limit N]',
    'cold-symbols': '--repo X [--limit N]',
    blast: '--repo X --symbol <name>',
    'stale-flags': '--repo X',
  };

function register(commands, deps) {
  commands.preflight = (args) => agentIntel.preflight(deps, args);
  commands['agent-pack'] = (args) => agentIntel.agentPack(deps, args);

  const dupesModule = require('../../agent-intel/dupes');
  commands.dupes = (args) => {
    const db = deps.getDb ? deps.getDb() : deps.db,
      repoName = args.repo;
    if (!repoName) {
      return deps.jsonErrNoExit('Missing --repo. Usage: dupes --repo X');
    }
    const repoRow = deps.sqlJson('SELECT id, path, head_commit FROM code_repos WHERE name = ?', [repoName]);
    if (!repoRow.length) {
      return deps.jsonErrNoExit(`Repo "${repoName}" not found. Run index-repo first.`);
    }
    return dupesModule.findDupes(db, repoRow[0].id, {
      threshold: args.threshold ? parseFloat(args.threshold) : undefined,
      topK: args.top ? parseInt(args.top) : undefined,
    });
  };

  const enrichment = require('../../agent-intel/symbol-enrichment');
  commands['enrich-symbols'] = (args) => {
    const db = deps.getDb ? deps.getDb() : deps.db,
      repoName = args.repo;
    if (!repoName) {
      return deps.jsonErrNoExit('Missing --repo. Usage: enrich-symbols --repo X');
    }
    const repoRow = deps.sqlJson('SELECT id, path FROM code_repos WHERE name = ?', [repoName]);
    if (!repoRow.length) {
      return deps.jsonErrNoExit(`Repo "${repoName}" not found.`);
    }
    return enrichment.enrichSymbols(db, repoRow[0].id);
  };
  commands['symbol-meta'] = (args) => {
    const db = deps.getDb ? deps.getDb() : deps.db,
      symbolId = args['symbol-id'];
    if (!symbolId) {
      return deps.jsonErrNoExit('Missing --symbol-id');
    }
    return enrichment.getSymbolMeta(db, parseInt(symbolId));
  };

  const auditDiffModule = require('../../agent-intel/audit-diff');
  commands['audit-diff'] = (args) => {
    const db = deps.getDb ? deps.getDb() : deps.db,
      repoName = args.repo;
    if (!repoName) {
      return deps.jsonErrNoExit('Missing --repo. Usage: audit-diff --repo X --files f1,f2');
    }
    const repoRow = deps.sqlJson('SELECT id, path FROM code_repos WHERE name = ?', [repoName]),
    files = repoRow.length ? ((args.files || '')
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean)) : undefined;
    if (!repoRow.length) {
      return deps.jsonErrNoExit(`Repo "${repoName}" not found.`);
    }
    return auditDiffModule.auditDiff(db, repoRow[0].id, {
      files,
      task: args.task || '',
    });
  };

  // Runtime ingest commands
  const runtimeIngest = require('../../agent-intel/runtime-ingest');
  commands['runtime-ingest'] = (args) => {
    const db = deps.getDb ? deps.getDb() : deps.db,
      repoName = args.repo;
    if (!repoName) {
      return deps.jsonErrNoExit('Missing --repo. Usage: runtime-ingest --repo X --coverage <path>');
    }
    const repoRow = deps.sqlJson('SELECT id FROM code_repos WHERE name = ?', [repoName]),
    coveragePath = repoRow.length ? (args.coverage) : undefined;
    if (!repoRow.length) {
      return deps.jsonErrNoExit(`Repo "${repoName}" not found. Run index-repo first.`);
    }
    if (!coveragePath) {
      return deps.jsonErrNoExit('Missing --coverage <path>');
    }
    return runtimeIngest.ingestCoverage(db, repoRow[0].id, coveragePath, coveragePath);
  };

  commands['hot-symbols'] = (args) => {
    const db = deps.getDb ? deps.getDb() : deps.db,
      repoName = args.repo;
    if (!repoName) {
      return deps.jsonErrNoExit('Missing --repo. Usage: hot-symbols --repo X');
    }
    const repoRow = deps.sqlJson('SELECT id FROM code_repos WHERE name = ?', [repoName]);
    if (!repoRow.length) {
      return deps.jsonErrNoExit(`Repo "${repoName}" not found.`);
    }
    const limit = args.limit ? parseInt(args.limit) : 20;
    return { hot_symbols: runtimeIngest.getHotSymbols(db, repoRow[0].id, limit) };
  };

  commands['cold-symbols'] = (args) => {
    const db = deps.getDb ? deps.getDb() : deps.db,
      repoName = args.repo;
    if (!repoName) {
      return deps.jsonErrNoExit('Missing --repo. Usage: cold-symbols --repo X');
    }
    const repoRow = deps.sqlJson('SELECT id FROM code_repos WHERE name = ?', [repoName]);
    if (!repoRow.length) {
      return deps.jsonErrNoExit(`Repo "${repoName}" not found.`);
    }
    const limit = args.limit ? parseInt(args.limit) : 20;
    return { cold_symbols: runtimeIngest.getColdSymbols(db, repoRow[0].id, limit) };
  };

  // Blast radius command
  const blastModule = require('../../agent-intel/blast');
  commands.blast = (args) => {
    const db = deps.getDb ? deps.getDb() : deps.db,
      repoName = args.repo;
    if (!repoName) {
      return deps.jsonErrNoExit('Missing --repo. Usage: blast --repo X --symbol <name>');
    }
    const repoRow = deps.sqlJson('SELECT id FROM code_repos WHERE name = ?', [repoName]),
    symbolName = repoRow.length ? (args.symbol) : undefined;
    if (!repoRow.length) {
      return deps.jsonErrNoExit(`Repo "${repoName}" not found.`);
    }
    if (!symbolName) {
      return deps.jsonErrNoExit('Missing --symbol <name>');
    }
    return blastModule.blastRadius(db, repoRow[0].id, symbolName);
  };

  // Stale flags detection
  const staleFlags = require('../../agent-intel/stale-flags');
  commands['stale-flags'] = (args) => {
    const db = deps.getDb ? deps.getDb() : deps.db,
      repoName = args.repo;
    if (!repoName) {
      return deps.jsonErrNoExit('Missing --repo. Usage: stale-flags --repo X');
    }
    const repoRow = deps.sqlJson('SELECT id, path FROM code_repos WHERE name = ?', [repoName]),
    findings = repoRow.length ? (staleFlags.detectStaleFlagsInRepo(db, repoRow[0].id, repoRow[0].path)) : undefined;
    if (!repoRow.length) {
      return deps.jsonErrNoExit(`Repo "${repoName}" not found.`);
    }
    staleFlags.persistStaleFlags(db, findings);
    return { stale_flags: findings };
  };
}

module.exports = { register, USAGE };
