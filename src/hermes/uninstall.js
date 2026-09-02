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
 * `hooks_auto_accept` is removed only when the `hooks:` block ends up empty
 * (no other hooks remain) — otherwise it is left alone, since other hooks may
 * rely on it for headless consent.
 */

const fs = require('node:fs'), path = require('node:path'), {
  removeSubBlock,
  removeTopLevelBlock,
  removeListItems,
  removeEmptySubBlock,
  topBlockEmpty,
  removeScalar,
  readText,
  writeTextAtomic,
} = require('./config-editor'), { parseFlags, resolveHermesHome, hermesPaths, hookCommand, HOOK_EVENTS } = require('./install');





async function runUninstall(argv, io = {}) {
  const flags = parseFlags(argv),
    home = resolveHermesHome(flags, io),
    paths = hermesPaths(home),
    log = io.log || ((l) => console.log(l)),
    removed = [],
    command = hookCommand();

  // MCP server entry.
  let text = readText(paths.config);
  {
const beforeMcp = text,
  skillDir = (() => {

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
  
    // Prune empty `hooks.<event>` shells, then drop the `hooks:` block and the
    // `hooks_auto_accept` scalar — but only when no other hooks remain. The
    // Scalar is shared config that other hooks may rely on for headless consent.
    for (const { event } of HOOK_EVENTS) {
      text = removeEmptySubBlock(text, 'hooks', event);
    }
    if (topBlockEmpty(text, 'hooks')) {
      text = removeTopLevelBlock(text, 'hooks');
      text = removeScalar(text, 'hooks_auto_accept');
      removed.push('hooks (empty block)', 'hooks_auto_accept');
    }
    if (topBlockEmpty(text, 'mcp_servers')) {
      text = removeTopLevelBlock(text, 'mcp_servers');
      removed.push('mcp_servers (empty block)');
    }
  
    // Always write: if every LaPis-owned entry is gone the config may now be
    // Empty, and leaving stale content behind would be worse than an empty file.
    writeTextAtomic(paths.config, text);
  
    // Allowlist approvals for the LaPis hook command.
    try {
      const allow = JSON.parse(readText(paths.allowlist) || '{}');
      if (Array.isArray(allow.approvals)) {
        const before = allow.approvals.length;
        allow.approvals = allow.approvals.filter((a) => !(a && a.command === command));
        if (allow.approvals.length !== before) {
          if (allow.approvals.length === 0 && Object.keys(allow).length === 1) {
            // Nothing left to approve and the file holds only `approvals` (the
            // Shape install writes) — drop it so uninstall leaves no residue.
            try {
              fs.unlinkSync(paths.allowlist);
            } catch {
              // Fall back to writing the empty file if unlink fails.
              writeTextAtomic(paths.allowlist, `${JSON.stringify(allow, null, 2)}\n`);
            }
          } else {
            writeTextAtomic(paths.allowlist, `${JSON.stringify(allow, null, 2)}\n`);
          }
          removed.push(`allowlist (${before - allow.approvals.length} approval(s))`);
        }
      }
    } catch {
      // Corrupt allowlist → leave it; never destroy user data on uninstall.
    }
  
    // Skill directory (ours by path), then prune now-empty parent dirs so
    // Uninstall leaves zero residue under `skills/`.
    
  return (path.dirname(paths.skillFile));
})();if (fs.existsSync(paths.skillFile)) {
    fs.rmSync(skillDir, { recursive: true, force: true });
    removed.push(`skill (${path.join('skills', 'memory', 'lapis')})`);
    let parent = path.dirname(skillDir); // Skills/memory
    for (let depth = 0; depth < 2; depth++) {
      try {
        fs.rmdirSync(parent);
      } catch {
        break; // Not empty (or missing) — stop pruning
      }
      parent = path.dirname(parent);
    }
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
}

/** True when a top-level block exists but has no non-empty content lines. */
function topBlockEmptyLegacy(text, key) {
  return require('./config-editor').topBlockEmpty(text, key);
}

module.exports = { runUninstall, topBlockEmpty: topBlockEmptyLegacy };
