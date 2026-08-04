'use strict';

/**
 * Hermes Agent uninstaller — `lapis hermes uninstall`.
 *
 * Reverses `lapis hermes install`, touching only LaPis-owned entries:
 *   - `mcp_servers.<name>` sub-block (other MCP servers untouched)
 *   - `hooks.<event>` list items whose command is the LaPis hook command
 *     (other user hooks untouched; empty `hooks:` block removed)
 *   - allowlist approvals for the LaPis hook command
 *   - `skills/memory/lapis/` skill directory
 * `hooks_auto_accept` is left alone — it may be used by other hooks.
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  removeSubBlock,
  removeTopLevelBlock,
  removeListItems,
  removeEmptySubBlock,
  topBlockEmpty,
  removeScalar,
  readText,
  writeTextAtomic,
} = require('./config-editor');
const { parseFlags, resolveHermesHome, hermesPaths, hookCommand, HOOK_EVENTS } = require('./install');

async function runUninstall(argv, io = {}) {
  const flags = parseFlags(argv);
  const home = resolveHermesHome(flags, io);
  const paths = hermesPaths(home);
  const log = io.log || ((l) => console.log(l));
  const removed = [];

  const command = hookCommand();

  // MCP server entry.
  let text = readText(paths.config);
  const beforeMcp = text;
  text = removeSubBlock(text, 'mcp_servers', flags.mcpName);
  if (text !== beforeMcp) {
    removed.push(`mcp_servers.${flags.mcpName}`);
  }

  // Hook entries (one list item per event, keyed by the LaPis command).
  for (const { event } of HOOK_EVENTS) {
    const beforeHooks = text;
    text = removeListItems(text, 'hooks', event, command);
    if (text !== beforeHooks) {
      removed.push(`hooks.${event}`);
    }
  }

  // Drop empty `hooks:` block and the `hooks_auto_accept` scalar we added.
  text = removeScalar(text, 'hooks_auto_accept');
  for (const { event } of HOOK_EVENTS) {
    text = removeEmptySubBlock(text, 'hooks', event);
  }
  if (topBlockEmpty(text, 'mcp_servers')) {
    text = removeTopLevelBlock(text, 'mcp_servers');
    removed.push('mcp_servers (empty block)');
  }
  if (topBlockEmpty(text, 'hooks')) {
    text = removeTopLevelBlock(text, 'hooks');
    removed.push('hooks (empty block)');
  }

  // Always write: if every LaPis-owned entry is gone the config may now be
  // empty, and leaving stale content behind would be worse than an empty file.
  writeTextAtomic(paths.config, text);

  // Allowlist approvals for the LaPis hook command.
  try {
    const allow = JSON.parse(readText(paths.allowlist) || '{}');
    if (Array.isArray(allow.approvals)) {
      const before = allow.approvals.length;
      allow.approvals = allow.approvals.filter((a) => !(a && a.command === command));
      if (allow.approvals.length !== before) {
        writeTextAtomic(paths.allowlist, `${JSON.stringify(allow, null, 2)}\n`);
        removed.push(`allowlist (${before - allow.approvals.length} approval(s))`);
      }
    }
  } catch {
    // Corrupt allowlist → leave it; never destroy user data on uninstall.
  }

  // Skill directory (ours by path).
  const skillDir = path.dirname(paths.skillFile);
  if (fs.existsSync(paths.skillFile)) {
    fs.rmSync(skillDir, { recursive: true, force: true });
    removed.push(`skill (${path.join('skills', 'memory', 'lapis')})`);
  }

  if (removed.length === 0) {
    log('Nothing to uninstall — LaPis is not configured for Hermes Agent.');
  } else {
    log(`Uninstalled LaPis from Hermes Agent (${home}).`);
    for (const item of removed) {
      log(`  - removed ${item}`);
    }
    log('Restart Hermes for the changes to take effect.');
  }

  return { removed, home, config: paths.config };
}

/** True when a top-level block exists but has no non-empty content lines. */
function topBlockEmptyLegacy(text, key) {
  return require('./config-editor').topBlockEmpty(text, key);
}

module.exports = { runUninstall, topBlockEmpty: topBlockEmptyLegacy };
