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
  withTransaction,
} = require('./db');
const { getConfig } = require('./config');
const obsDA = require('./data-access/observations');

const fs = require('fs');

const { buildCommandMap, getAllUsage, ANALYSIS_TOOLS, _wrapAnalysis } = require('./src/cli/gateway');
const { createRepositories } = require('./src/platform/storage/repositories');

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
  withTransaction,
});

const args = parseArgs(process.argv);
const cmd = process.argv[2];

function printHelp(targetCmd) {
  const usage = getAllUsage();
  if (targetCmd && usage[targetCmd] !== undefined) {
    const spec = usage[targetCmd];
    process.stdout.write(`Usage: lapis ${targetCmd}${spec ? ` ${spec}` : ''}\n`);
    return;
  }
  if (targetCmd) {
    process.stdout.write(`Usage: lapis ${targetCmd} [options]\n`);
    return;
  }
  const subcommands = [...Object.keys(commands), 'run'].sort();
  process.stdout.write(
    `Usage: lapis <subcommand> [--option value ...]\n` +
      `       lapis run [--raw] [--text] [--remember] <command...>\n` +
      `Subcommands: ${subcommands.join(', ')}\n`,
  );
}

const isHelpRequest = cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help === true || args._.includes('-h');

if (isHelpRequest) {
  printHelp(commands[cmd] ? cmd : null);
  process.exit(0);
}

(async () => {
  if (cmd === 'serve') {
    const { startHttpServer } = require('./src/http/server');
    await startHttpServer({
      host: args.host ?? '127.0.0.1',
      port: Number(args.port ?? 9100),
    });
    return;
  }

  if (cmd === 'mcp') {
    // MCP transport adapter. startMcpServer owns ensureDb() internally.
    const { startMcpServer } = require('./src/mcp/server');
    await startMcpServer();
    return;
  }

  if (cmd === 'claude-code') {
    const sub = process.argv[3];
    const subArgv = process.argv.slice(4);
    try {
      if (sub === 'install') {
        const { runInstall } = require('./src/claude-code/install');
        await runInstall(subArgv);
        return;
      }
      if (sub === 'uninstall') {
        const { runUninstall } = require('./src/claude-code/uninstall');
        await runUninstall(subArgv);
        return;
      }
      if (sub === 'doctor') {
        const { runDoctor } = require('./src/claude-code/doctor');
        const { ok } = runDoctor(subArgv);
        process.exitCode = ok ? 0 : 1;
        return;
      }
      if (sub === 'start') {
        const { runStart } = require('./src/claude-code/daemon');
        await runStart(subArgv);
        return;
      }
      if (sub === 'stop') {
        const { runStop } = require('./src/claude-code/daemon');
        await runStop(subArgv);
        return;
      }
      if (sub === 'gc') {
        const { runGc } = require('./src/claude-code/state-store');
        runGc(subArgv);
        return;
      }
    } catch (e) {
      process.stderr.write(`claude-code ${sub}: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
      return;
    }
    // Claude Code hooks bridge. Only `hook` routes here — a missing or unknown
    // subcommand should not fall through into the hook router (which would
    // print a confusing hook-specific usage). runHook owns ensureDb() internally.
    if (sub === 'hook') {
      const { runHook } = require('./src/claude-code/hooks');
      await runHook(process.argv.slice(3)); // ['hook', '<event>', ...flags]
      return;
    }
    process.stderr.write(
      `Unknown claude-code subcommand${sub ? ` "${sub}"` : ''}.\n` +
        'Usage: lapis claude-code <install|uninstall|doctor|start|stop|gc|hook …>\n',
    );
    process.exitCode = 2;
    return;
  }

  if (cmd === 'run') {
    ensureDb();
    const { executeAndCompress, formatTextOutput } = require('./src/cli/commands/token-saver');
    const runArgv = process.argv.slice(3);
    const runArgs = [];
    let raw = false;
    let text = false;
    let remember = false;
    let cwd = undefined;

    for (let i = 0; i < runArgv.length; i++) {
      if (runArgv[i] === '--raw' && runArgs.length === 0) {
        raw = true;
      } else if (runArgv[i] === '--text' && runArgs.length === 0) {
        text = true;
      } else if (runArgv[i] === '--remember' && runArgs.length === 0) {
        remember = true;
      } else if (runArgv[i] === '--cwd' && runArgs.length === 0 && runArgv[i + 1]) {
        cwd = runArgv[++i];
      } else {
        runArgs.push(runArgv[i]);
      }
    }

    if (runArgs.length === 0) {
      process.stderr.write(
        `${JSON.stringify({ error: 'Usage: lapis run [--raw] [--text] [--remember] <command...>' })}\n`,
      );
      process.exit(1);
    }

    const result = await executeAndCompress(runArgs, { raw, cwd });

    if (remember && result.summary) {
      try {
        sqlRun(
          `INSERT INTO observations (session_id, type, title, content, project, scope)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            'token-saver',
            'command-summary',
            `Command: ${result.command}`,
            result.summary,
            cwd || process.cwd(),
            'project',
          ],
        );
      } catch {}
    }

    if (text) {
      process.stdout.write(`${formatTextOutput(result)}\n`);
    } else {
      jsonOut(result);
    }

    process.exit(result.exitCode ?? 0);
    return;
  }

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
      `Usage: lapis <subcommand> [--option value ...]\n       lapis run [--raw] [--text] [--remember] <command...>\nSubcommands: ${[...Object.keys(commands), 'run'].sort().join(', ')}`,
    );
    process.exit(1);
  }
})();
