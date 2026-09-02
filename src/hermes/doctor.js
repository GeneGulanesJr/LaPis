'use strict';

/**
 * Hermes Agent install self-check — `lapis hermes doctor`.
 *
 * Verifies every piece `install` wires, mirroring `claude-code doctor`:
 * config file, MCP server entry, hook entries + consent, SQLite database,
 * native module, and the bundled skill. Exits 0 only when all checks pass.
 */

const fs = require('node:fs'),
  path = require('node:path'),
  { readText, topBlockRange } = require('./config-editor'),
  { parseFlags, resolveHermesHome, hermesPaths, hookCommand, HOOK_EVENTS } = require('./install');

function checkConfigFile(paths) {
  if (!fs.existsSync(paths.config)) {
    return {
      ok: false,
      name: 'Hermes config file',
      detail: `${paths.config} not found — run \`lapis hermes install\``,
    };
  }
  const text = readText(paths.config);
  if (text.trim() === '') {
    return { ok: false, name: 'Hermes config file', detail: `${paths.config} is empty` };
  }
  return { ok: true, name: 'Hermes config file', detail: paths.config };
}

function checkMcpConfig(paths, mcpName) {
  const text = readText(paths.config),
    range = topBlockRange(text, 'mcp_servers'),
    block = range ? text.split('\n').slice(range.start, range.end).join('\n') : undefined,
    subRe = range ? new RegExp(`^\\s{2}${mcpName}\\s*:`, 'm') : undefined;
  if (!range) {
    return { ok: false, name: `MCP server "${mcpName}"`, detail: 'no mcp_servers block in config' };
  }
  if (!subRe.test(block)) {
    return { ok: false, name: `MCP server "${mcpName}"`, detail: `mcp_servers.${mcpName} entry missing` };
  }
  if (!block.includes('memory-store.js') || !/\benabled:\s*true\b/.test(block)) {
    return {
      ok: false,
      name: `MCP server "${mcpName}"`,
      detail: 'entry looks incomplete (expected memory-store.js + enabled: true)',
    };
  }
  {
    const envOk = /LAPIS_HOME\s*:/.test(block);
    return {
      ok: true,
      name: `MCP server "${mcpName}"`,
      detail: `configured${envOk ? ' with LAPIS_HOME pinned' : ' (no LAPIS_HOME env — DB may split across homes)'}`,
    };
  }
}

function checkHooksConfig(paths) {
  const text = readText(paths.config),
    command = hookCommand(),
    missing = [];
  for (const { event, matcher } of HOOK_EVENTS) {
    const eventRe = new RegExp(`^\\s{2}${event}\\s*:`, 'm'),
      hasEvent = eventRe.test(text),
      hasItem = text.includes(`command: ${command}`) || text.includes(`command: "${command}"`);
    if (!hasEvent || !hasItem) {
      missing.push(event);
    }
    if (matcher && !text.includes(matcher)) {
      missing.push(`${event} matcher`);
    }
  }
  if (missing.length > 0) {
    return { ok: false, name: 'Hooks config', detail: `missing: ${missing.join(', ')}` };
  }
  if (!/hooks_auto_accept\s*:\s*true/.test(text)) {
    return {
      ok: false,
      name: 'Hooks config',
      detail: 'hooks_auto_accept not set to true (consent prompts may appear on non-TTY start)',
    };
  }
  return { ok: true, name: 'Hooks config', detail: `${HOOK_EVENTS.length} LaPis hook(s) wired` };
}

function checkAllowlist(paths) {
  const command = hookCommand();
  let data = { approvals: [] };
  try {
    data = JSON.parse(readText(paths.allowlist) || '{}');
  } catch {
    return { ok: false, name: 'Hook consent', detail: `${paths.allowlist} missing or corrupt` };
  }
  const approvals = Array.isArray(data.approvals) ? data.approvals : [],
    missing = HOOK_EVENTS.filter(
      ({ event }) => !approvals.some((a) => a && a.event === event && a.command === command),
    ).map(({ event }) => event);
  if (missing.length > 0) {
    return { ok: false, name: 'Hook consent', detail: `not allowlisted: ${missing.join(', ')}` };
  }
  return { ok: true, name: 'Hook consent', detail: `${HOOK_EVENTS.length} approval(s) present` };
}

function checkDatabase(io) {
  try {
    const db = require('../../db');
    db.ensureDb();
    {
      const conn = db.getDb(),
        row = conn.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get();
      if (!row || typeof row.n !== 'number') {
        return { ok: false, name: 'SQLite database', detail: 'schema query failed' };
      }
      return { ok: true, name: 'SQLite database', detail: `reachable at ${db.DB_PATH}` };
    }
  } catch (e) {
    return { ok: false, name: 'SQLite database', detail: e instanceof Error ? e.message : String(e) };
  }
}

function checkNativeModule(io) {
  try {
    require('better-sqlite3');
    return { ok: true, name: 'Native module', detail: 'better-sqlite3 loads' };
  } catch (e) {
    return {
      ok: false,
      name: 'Native module',
      detail: `better-sqlite3 failed to load: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

function checkSkill(paths) {
  if (!fs.existsSync(paths.skillFile)) {
    return {
      ok: false,
      name: 'Hermes skill',
      detail: `${paths.skillFile} not installed (re-run install, or pass --no-skill to skip)`,
    };
  }
  return { ok: true, name: 'Hermes skill', detail: `installed at ${paths.skillFile}` };
}

function runDoctor(argv, io = {}) {
  const flags = parseFlags(argv),
    home = resolveHermesHome(flags, io),
    paths = hermesPaths(home),
    log = io.log || ((l) => console.log(l)),
    checks = [
      checkConfigFile(paths),
      checkMcpConfig(paths, flags.mcpName),
      checkHooksConfig(paths),
      checkAllowlist(paths),
      checkDatabase(io),
      checkNativeModule(io),
      checkSkill(paths),
    ],
    ok = (() => {
      for (const check of checks) {
        log(`${check.ok ? '✓' : '✗'} ${check.name} — ${check.detail}`);
      }

      return checks.every((c) => c.ok);
    })();
  log(ok ? 'All checks passed.' : 'Some checks failed — see above.');
  return { ok, checks };
}

module.exports = {
  runDoctor,
  checkConfigFile,
  checkMcpConfig,
  checkHooksConfig,
  checkAllowlist,
  checkDatabase,
  checkNativeModule,
  checkSkill,
};
