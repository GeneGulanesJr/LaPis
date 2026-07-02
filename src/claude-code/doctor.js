'use strict';

/**
 * Claude Code bridge: `lapis claude-code doctor` — install self-check.
 *
 * Verifies the three things that break a fresh install in practice:
 *   1. the LaPis database is reachable and writable (config db_path),
 *   2. the better-sqlite3 native module loads in THIS node runtime,
 *   3. the installed MCP `command`/`args` actually resolve on this machine
 *      (PATH lookup for bare names, fs check for paths / node scripts),
 * plus reports where hooks are configured and whether the per-session
 * state-store directory is writable.
 *
 * Exit contract: prints one line per check; returns { ok, checks }. The CLI
 * maps ok:false to exit code 1.
 */

const fs = require('node:fs');
const path = require('node:path');
const { parseFlags, isLapisHookHandler, isLapisMcpEntry, readJson, resolveIo, configPaths } = require('./install');

/** which(1): resolve a bare command name against PATH (with PATHEXT on Windows). */
function resolveOnPath(command, env = process.env) {
  if (typeof command !== 'string' || !command) {
    return null;
  }
  if (command.includes('/') || command.includes('\\')) {
    return fs.existsSync(command) ? command : null;
  }
  const pathVar = env.PATH || env.Path || '';
  const exts = process.platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext.toLowerCase());
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // keep scanning
      }
    }
  }
  return null;
}

/** Locate the installed LaPis MCP entry across the three scopes. */
function findMcpEntry(paths, mcpName, cwd) {
  const candidates = [
    { scope: 'project', file: paths.projectMcp, get: (c) => c.mcpServers },
    { scope: 'local', file: paths.claudeJson, get: (c) => c.projects?.[cwd]?.mcpServers },
    { scope: 'user', file: paths.claudeJson, get: (c) => c.mcpServers },
  ];
  for (const { scope, file, get } of candidates) {
    let config;
    try {
      config = readJson(file);
    } catch {
      continue;
    }
    const entry = get(config)?.[mcpName];
    if (entry && isLapisMcpEntry(entry)) {
      return { scope, file, entry };
    }
  }
  return null;
}

/** Count LaPis hook handlers per settings file. */
function countLapisHooks(filePath) {
  let settings;
  try {
    settings = readJson(filePath);
  } catch {
    return 0;
  }
  let count = 0;
  for (const groups of Object.values(settings.hooks || {})) {
    if (!Array.isArray(groups)) {
      continue;
    }
    for (const group of groups) {
      for (const handler of group?.hooks || []) {
        if (isLapisHookHandler(handler)) {
          count++;
        }
      }
    }
  }
  return count;
}

// --- individual checks (each returns { name, ok, detail }) -------------------

function checkNativeModule(deps) {
  try {
    (deps.requireModule || require)('better-sqlite3');
    return { name: 'better-sqlite3 native module', ok: true, detail: 'loads in this runtime' };
  } catch (e) {
    return {
      name: 'better-sqlite3 native module',
      ok: false,
      detail: `failed to load: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

function checkDatabase(deps) {
  try {
    const db = deps.db || require('../../db');
    db.ensureDb();
    const dbPath = db.DB_PATH;
    fs.accessSync(dbPath, fs.constants.W_OK);
    db.getDb().prepare('SELECT 1').get();
    return { name: 'database', ok: true, detail: `writable at ${dbPath}` };
  } catch (e) {
    return {
      name: 'database',
      ok: false,
      detail: `not writable: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

function checkMcpConfig(paths, mcpName, cwd, env) {
  const found = findMcpEntry(paths, mcpName, cwd);
  if (!found) {
    return {
      name: 'MCP server config',
      ok: false,
      detail: `no "${mcpName}" server found — run \`lapis claude-code install\``,
    };
  }
  const { entry, scope, file } = found;
  const args = Array.isArray(entry.args) ? entry.args : [];
  if (args[args.length - 1] !== 'mcp') {
    return { name: 'MCP server config', ok: false, detail: `entry in ${file} does not spawn \`mcp\`` };
  }
  // node-script invocation: the script path must exist; otherwise resolve the
  // command itself (PATH lookup for bare names, fs check for paths).
  const base = path.basename(String(entry.command || ''));
  if ((base === 'node' || base === 'node.exe') && args.length > 1) {
    if (!fs.existsSync(args[0])) {
      return { name: 'MCP server config', ok: false, detail: `script not found: ${args[0]}` };
    }
    return { name: 'MCP server config', ok: true, detail: `"${mcpName}" (${scope} scope) → node ${args[0]}` };
  }
  const resolved = resolveOnPath(entry.command, env);
  if (!resolved) {
    return { name: 'MCP server config', ok: false, detail: `command not found on PATH: ${entry.command}` };
  }
  return { name: 'MCP server config', ok: true, detail: `"${mcpName}" (${scope} scope) → ${resolved}` };
}

function checkHooksConfig(paths) {
  const sources = [
    ['project', paths.projectSettings],
    ['local', paths.localSettings],
    ['user', paths.userSettings],
  ];
  const found = sources
    .map(([label, file]) => ({ label, file, count: countLapisHooks(file) }))
    .filter((s) => s.count > 0);
  if (found.length === 0) {
    return {
      name: 'hooks config',
      ok: false,
      detail: 'no LaPis hooks found — run `lapis claude-code install`',
    };
  }
  const detail = found.map((s) => `${s.count} handlers (${s.label}: ${s.file})`).join(', ');
  return { name: 'hooks config', ok: true, detail };
}

function checkStateStore(deps) {
  try {
    const stateStore = deps.stateStore || require('./state-store');
    const dir = stateStore.DEFAULT_DIR;
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.doctor-probe-${process.pid}`);
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.unlinkSync(probe);

    // Observability into the state dir: TTL window + size + oldest file (#233).
    const ttl = typeof stateStore.defaultTtlHours === 'function' ? stateStore.defaultTtlHours() : 24;
    let bytes = 0;
    let oldestName = null;
    let oldestMs = Infinity;
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (!entry.endsWith('.json')) {
          continue;
        }
        const full = path.join(dir, entry);
        const stat = fs.statSync(full);
        bytes += stat.size;
        if (stat.mtimeMs < oldestMs) {
          oldestMs = stat.mtimeMs;
          oldestName = entry;
        }
      }
    } catch {
      // Ignore readdir/stat failures; the writability check above is the gate.
    }
    const kib = (bytes / 1024).toFixed(1);
    const age =
      oldestName && Number.isFinite(oldestMs) ? `${((Date.now() - oldestMs) / 3600000).toFixed(1)}h old` : 'none';
    const detail = `writable at ${dir} · TTL ${ttl}h · ${kib} KiB across .json · oldest: ${oldestName || 'none'} (${age})`;
    return { name: 'session state store', ok: true, detail };
  } catch (e) {
    return {
      name: 'session state store',
      ok: false,
      detail: `not writable: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Run `lapis claude-code doctor`.
 *
 * @param {string[]} argv  flags after `doctor` (--mcp-name)
 * @param {{ cwd?, home?, log?, env?, requireModule?, db?, stateStore? }} [io]
 * @returns {{ ok: boolean, checks: Array<{name, ok, detail}> }}
 */
function runDoctor(argv, io = {}) {
  const flags = parseFlags(argv);
  const { home, cwd, log } = resolveIo(io);
  const paths = configPaths({ home, cwd });
  const env = io.env || process.env;

  const checks = [
    checkNativeModule(io),
    checkDatabase(io),
    checkMcpConfig(paths, flags.mcpName, cwd, env),
    checkHooksConfig(paths),
    checkStateStore(io),
  ];

  for (const check of checks) {
    log(`${check.ok ? '✓' : '✗'} ${check.name} — ${check.detail}`);
  }
  const ok = checks.every((c) => c.ok);
  log(ok ? 'All checks passed.' : 'Some checks failed — see above.');
  return { ok, checks };
}

module.exports = {
  runDoctor,
  resolveOnPath,
  findMcpEntry,
  countLapisHooks,
  checkNativeModule,
  checkDatabase,
  checkMcpConfig,
  checkHooksConfig,
  checkStateStore,
};
