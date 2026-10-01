// Module boundary:
// Owns CLI command-map composition and feature router registration. Routers map
// Command arguments to feature services; business logic belongs in feature
// Modules, and Pi extension state must stay outside this gateway.

// Routers are loaded lazily, per command. Hook processes dispatch 1-3 commands
// Per process lifetime; eagerly requiring all nine routers cost ~34ms of
// Module-load time on EVERY direct-mode dispatch. COMMAND_ROUTERS maps each
// Command to its owning router (keep in sync with src/cli/commands/*); any
// Command missing from the map falls back to full registration, so newly added
// Commands keep working exactly as before — only slower to first dispatch.
const ROUTER_PATHS = {
  memory: './commands/memory',
  'code-index': './commands/code-index',
  'code-analysis': './commands/code-analysis',
  docs: './commands/docs',
  trust: './commands/trust',
  maintenance: './commands/maintenance',
  'agent-intel': './commands/agent-intel',
  'token-saver': './commands/token-saver',
  dashboard: './commands/dashboard',
},
  COMMAND_ROUTERS = {
  // Memory router commands
  'suggest-topic-key': 'memory',
  'save-prompt': 'memory',
  'capture-passive': 'memory',
  'log-negative-recall': 'memory',
  'check-dup': 'memory',
  'mark-dup': 'memory',
  save: 'memory',
  search: 'memory',
  context: 'memory',
  get: 'memory',
  update: 'memory',
  delete: 'memory',
  timeline: 'memory',
  stats: 'memory',
  // Code-index router commands
  'index-repo': 'code-index',
  'reindex-repo': 'code-index',
  'health-code-repo': 'code-index',
  'search-code': 'code-index',
  'ranked-code-context': 'code-index',
  'get-code-source': 'code-index',
  'list-code-repos': 'code-index',
  'remove-code-repo': 'code-index',
  'index-repo-async': 'code-index',
  'index-status': 'code-index',
  'cancel-index': 'code-index',
  'list-index-jobs': 'code-index',
  // Code-analysis router commands
  'import-graph': 'code-analysis',
  'call-hierarchy': 'code-analysis',
  'blast-radius': 'code-analysis',
  'dead-code': 'code-analysis',
  'signal-chains': 'code-analysis',
  'layer-violations': 'code-analysis',
  'ast-patterns': 'code-analysis',
  'pr-risk': 'code-analysis',
  'coding-context': 'code-analysis',
  complexity: 'code-analysis',
  outline: 'code-analysis',
  churn: 'code-analysis',
  hotspots: 'code-analysis',
  cycles: 'code-analysis',
  coupling: 'code-analysis',
  importance: 'code-analysis',
  extractable: 'code-analysis',
  hierarchy: 'code-analysis',
  winnow: 'code-analysis',
  provenance: 'code-analysis',
  untested: 'code-analysis',
  // Docs router commands
  'doc-orphans': 'docs',
  'doc-coverage': 'docs',
  'stale-pages': 'docs',
  'doc-duplicates': 'docs',
  'index-docs': 'docs',
  'list-doc-repos': 'docs',
  'reindex-docs': 'docs',
  'doc-search': 'docs',
  'doc-outline': 'docs',
  'broken-links': 'docs',
  'tutorial-path': 'docs',
  'code-examples': 'docs',
  backlinks: 'docs',
  glossary: 'docs',
  // Trust router commands
  'link-symbol': 'trust',
  'auto-link': 'trust',
  'adjust-trust': 'trust',
  'record-recall': 'trust',
  'stale-links': 'trust',
  'sync-code-trust': 'trust',
  'symbol-cluster': 'trust',
  related: 'trust',
  // Maintenance router commands
  'session-start': 'maintenance',
  'session-end': 'maintenance',
  'session-summary': 'maintenance',
  'auto-recover': 'maintenance',
  'recover-orphans': 'maintenance',
  'trust-recovery': 'maintenance',
  'list-projects': 'maintenance',
  'list-workspaces': 'maintenance',
  'create-workspace': 'maintenance',
  'archive-workspace': 'maintenance',
  'cleanup-sessions': 'maintenance',
  init: 'maintenance',
  compact: 'maintenance',
  dream: 'maintenance',
  // Agent-intel router commands
  'agent-pack': 'agent-intel',
  'enrich-symbols': 'agent-intel',
  'symbol-meta': 'agent-intel',
  'audit-diff': 'agent-intel',
  'runtime-ingest': 'agent-intel',
  'hot-symbols': 'agent-intel',
  'cold-symbols': 'agent-intel',
  'stale-flags': 'agent-intel',
  preflight: 'agent-intel',
  dupes: 'agent-intel',
  blast: 'agent-intel',
  // Token-saver router commands
  'token-saver-stats': 'token-saver',
  'token-saver-clear': 'token-saver',
  // Dashboard router commands
  dashboard: 'dashboard',
};

function requireAllRouters() {
  return {
    memory: require('./commands/memory'),
    'code-index': require('./commands/code-index'),
    'code-analysis': require('./commands/code-analysis'),
    docs: require('./commands/docs'),
    trust: require('./commands/trust'),
    maintenance: require('./commands/maintenance'),
    'agent-intel': require('./commands/agent-intel'),
    'token-saver': require('./commands/token-saver'),
    dashboard: require('./commands/dashboard'),
  };
}

function buildCommandMap(deps) {
  const commands = {},
    routers = requireAllRouters();
  for (const name of [
    'memory',
    'code-index',
    'code-analysis',
    'docs',
    'trust',
    'maintenance',
    'agent-intel',
    'token-saver',
    'dashboard',
  ]) {
    routers[name].register(commands, deps);
  }

  return commands;
}

function getAllUsage() {
  const routers = requireAllRouters();
  return {
    ...routers.memory.USAGE,
    ...routers['code-index'].USAGE,
    ...routers['code-analysis'].USAGE,
    ...routers.docs.USAGE,
    ...routers.trust.USAGE,
    ...routers.maintenance.USAGE,
    ...routers['agent-intel'].USAGE,
    ...routers['token-saver'].USAGE,
  };
}

function codeAnalysisRouter() {
  if (!_codeAnalysisModule) {
    _codeAnalysisModule = require('./commands/code-analysis');
  }
  return _codeAnalysisModule;
}

module.exports = {
  buildCommandMap,
  getAllUsage,
  get ANALYSIS_TOOLS() {
    return codeAnalysisRouter().ANALYSIS_TOOLS;
  },
  get _wrapAnalysis() {
    return codeAnalysisRouter()._wrapAnalysis;
  },
};

let _commands = null,
  _loadedRouters = null,
  _deps = null,
  _initPromise = null,
  _codeAnalysisModule = null;

async function dispatch(cmd, args) {
  if (!_commands) {
    if (!_initPromise) {
      _initPromise = (async () => {
        const db = require('../../db'),
          obsDA = require('../../data-access/observations'),
          { createRepositories } = require('../platform/storage/repositories'),
          fs = require('fs');

        db.ensureDb();

        {
          const baseStorageDeps = {
              sqlJson: db.sqlJson,
              sqlRun: db.sqlRun,
              sqlRaw: db.sqlRaw,
              jsonErrNoExit: db.jsonErrNoExit,
            },
            repositories = createRepositories(baseStorageDeps),
            softDeleteObservation = (id) => obsDA.softDeleteObservation(baseStorageDeps, id);

          function _readTierConfig() {
            const { getConfig } = require('../../config'),
              configPath = getConfig().tier_config_path;
            try {
              const raw = fs.readFileSync(configPath, 'utf-8'),
                cleaned = raw.replace(/\/\/.*$/gm, '');
              return JSON.parse(cleaned);
            } catch {
              return { tier: 'full' };
            }
          }

          {
            const TOOL_TIERS = {
              core: new Set([
                'search',
                'save',
                'context',
                'search-code',
                'get-code-source',
                'preflight',
                'agent-pack',
                'importance',
                'outline',
                'winnow',
                'dream',
              ]),
              standard: new Set([
                'search',
                'save',
                'context',
                'search-code',
                'get-code-source',
                'preflight',
                'agent-pack',
                'importance',
                'outline',
                'winnow',
                'dream',
                'complexity',
                'dead-code',
                'hotspots',
                'blast-radius',
                'call-hierarchy',
                'cycles',
                'coupling',
              ]),
              full: null,
            };

            _deps = {
              ...baseStorageDeps,
              getDb: db.getDb,
              repositories,
              softDeleteObservation,
              _readTierConfig,
              TOOL_TIERS,
              ensureDb: db.ensureDb,
              DB_PATH: db.DB_PATH,
              getEngine: db.getEngine,
            };
            _commands = {};
            _loadedRouters = new Set();
          }
        }
      })().catch((e) => {
        // A rejected init must not be cached forever: drop it so the next
        // Dispatch re-runs initialization (a transient locked-DB error at
        // Startup would otherwise brick every MCP tool call until restart).
        _initPromise = null;
        throw e;
      });
    }
    await _initPromise;
  }

  if (!_commands[cmd]) {
    // Lazy router registration: load only the router owning this command.
    const routerName = COMMAND_ROUTERS[cmd];
    if (routerName && !_loadedRouters.has(routerName)) {
      require(ROUTER_PATHS[routerName]).register(_commands, _deps);
      _loadedRouters.add(routerName);
    }
    if (!_commands[cmd]) {
      // Command not in COMMAND_ROUTERS (new or unknown): register every
      // Remaining router — identical to the previous always-eager behavior.
      for (const [name, routerPath] of Object.entries(ROUTER_PATHS)) {
        if (!_loadedRouters.has(name)) {
          require(routerPath).register(_commands, _deps);
          _loadedRouters.add(name);
        }
      }
    }
  }

  if (!_commands[cmd]) {
    return { error: `Unknown command: ${cmd}` };
  }

  try {
    return await _commands[cmd](args || {});
  } catch (e) {
    if (e.name === 'MemoryError') {
      return { error: e.message };
    }
    throw e;
  }
}

module.exports.dispatch = dispatch;
