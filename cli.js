#!/usr/bin/env node
const {
  DB_PATH,
  sqlJson,
  sqlRun,
  sqlRaw,
  ensureDb,
  getDb,
  getEngine,
  jsonOut,
  jsonErrNoExit,
  parseArgs,
  MemoryError,
} = require('./db');
const { getConfig } = require('./config');
const obsDA = require('./data-access/observations');

const fs = require('fs');

const { buildCommandMap, ANALYSIS_TOOLS, _wrapAnalysis } = require('./src/cli/gateway');
const { createRepositories } = require('./src/platform/storage/repositories');

const TOOL_TIERS = {
  core: new Set([
    'search',
    'save',
    'context',
    'search-code',
    'get-code-source',
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

function _readTierConfig() {
  const configPath = getConfig().tier_config_path;
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const cleaned = raw.replace(/\/\/.*$/gm, '');
    return JSON.parse(cleaned);
  } catch {
    return { tier: 'full' };
  }
}

const softDeleteObservation = (id) => obsDA.softDeleteObservation({ sqlJson, sqlRun, sqlRaw }, id);

const baseStorageDeps = { sqlJson, sqlRun, sqlRaw, jsonErrNoExit };
const repositories = createRepositories(baseStorageDeps);

const commands = buildCommandMap({
  ...baseStorageDeps,
  getDb,
  repositories,
  softDeleteObservation,
  _readTierConfig,
  TOOL_TIERS,
  ensureDb,
  DB_PATH,
  getEngine,
});

const args = parseArgs(process.argv);
const cmd = process.argv[2];

(async () => {
  ensureDb();
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

    if (ANALYSIS_TOOLS.has(cmd) && !result.error) {
      const repoName = args.repo;
      if (repoName) {
        const repoRow = sqlJson('SELECT id, path, head_commit FROM code_repos WHERE name = ?', [repoName]);
        if (repoRow.length > 0) {
          jsonOut(_wrapAnalysis(cmd, result, repoRow[0], startTime, format, { getDb }));
          return;
        }
      }
    }

    jsonOut(result);
  } else {
    console.error(
      `Usage: memory-store <subcommand> [--option value ...]\nSubcommands: ${Object.keys(commands).join(', ')}`,
    );
    process.exit(1);
  }
})();
