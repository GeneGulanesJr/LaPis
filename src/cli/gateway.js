// Module boundary:
// Owns CLI command-map composition and feature router registration. Routers map
// Command arguments to feature services; business logic belongs in feature
// Modules, and Pi extension state must stay outside this gateway.

const memoryRouter = require('./commands/memory');
const codeIndexRouter = require('./commands/code-index');
const codeAnalysisRouter = require('./commands/code-analysis');
const docsRouter = require('./commands/docs');
const trustRouter = require('./commands/trust');
const maintenanceRouter = require('./commands/maintenance');
const agentIntelRouter = require('./commands/agent-intel');
const tokenSaverRouter = require('./commands/token-saver');

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

let _commands = null;
let _initPromise = null;

async function dispatch(cmd, args) {
  if (!_commands) {
    if (!_initPromise) {
      _initPromise = (async () => {
        const db = require('../../db');
        const obsDA = require('../../data-access/observations');
        const { createRepositories } = require('../platform/storage/repositories');
        const fs = require('fs');

        db.ensureDb();

        const baseStorageDeps = {
          sqlJson: db.sqlJson,
          sqlRun: db.sqlRun,
          sqlRaw: db.sqlRaw,
          jsonErrNoExit: db.jsonErrNoExit,
        };
        const repositories = createRepositories(baseStorageDeps);
        const softDeleteObservation = (id) => obsDA.softDeleteObservation(baseStorageDeps, id);

        function _readTierConfig() {
          const { getConfig } = require('../../config');
          const configPath = getConfig().tier_config_path;
          try {
            const raw = fs.readFileSync(configPath, 'utf-8');
            const cleaned = raw.replace(/\/\/.*$/gm, '');
            return JSON.parse(cleaned);
          } catch {
            return { tier: 'full' };
          }
        }

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
      })();
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
