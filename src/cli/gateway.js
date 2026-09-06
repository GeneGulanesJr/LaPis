// Module boundary:
// Owns CLI command-map composition and feature router registration. Routers map
// Command arguments to feature services; business logic belongs in feature
// Modules, and Pi extension state must stay outside this gateway.

const memoryRouter = require('./commands/memory'),
  codeIndexRouter = require('./commands/code-index'),
  codeAnalysisRouter = require('./commands/code-analysis'),
  docsRouter = require('./commands/docs'),
  trustRouter = require('./commands/trust'),
  maintenanceRouter = require('./commands/maintenance'),
  agentIntelRouter = require('./commands/agent-intel'),
  tokenSaverRouter = require('./commands/token-saver'),
  dashboardRouter = require('./commands/dashboard');

function buildCommandMap(deps) {
  const commands = {};

  memoryRouter.register(commands, deps);
  codeIndexRouter.register(commands, deps);
  codeAnalysisRouter.register(commands, deps);
  docsRouter.register(commands, deps);
  trustRouter.register(commands, deps);
  maintenanceRouter.register(commands, deps);
  agentIntelRouter.register(commands, deps);
  tokenSaverRouter.register(commands, deps);
  dashboardRouter.register(commands, deps);

  return commands;
}

function getAllUsage() {
  return {
    ...memoryRouter.USAGE,
    ...codeIndexRouter.USAGE,
    ...codeAnalysisRouter.USAGE,
    ...docsRouter.USAGE,
    ...trustRouter.USAGE,
    ...maintenanceRouter.USAGE,
    ...agentIntelRouter.USAGE,
    ...tokenSaverRouter.USAGE,
  };
}

module.exports = {
  buildCommandMap,
  getAllUsage,
  ANALYSIS_TOOLS: codeAnalysisRouter.ANALYSIS_TOOLS,
  _wrapAnalysis: codeAnalysisRouter._wrapAnalysis,
};

let _commands = null,
  _initPromise = null;

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

            _commands = buildCommandMap({
              ...baseStorageDeps,
              getDb: db.getDb,
              repositories,
              softDeleteObservation,
              _readTierConfig,
              TOOL_TIERS,
              ensureDb: db.ensureDb,
              DB_PATH: db.DB_PATH,
              getEngine: db.getEngine,
            });
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
