'use strict';

/**
 * Claude Code bridge: `lapis claude-code uninstall` — reverse the install.
 *
 * Removal is by SENTINEL IDENTITY, never by position: hook handlers are
 * matched by the `claude-code hook` argument grammar and MCP entries by the
 * LaPis spawn signature (see install.js). Everything the sentinel does not
 * match — other people's hooks, other MCP servers, unrelated permissions —
 * is left byte-for-byte intact. Files that end up carrying no meaningful
 * config are deleted.
 *
 * Scope mirrors install:
 *   - default: project files (.mcp.json, .claude/settings.json,
 *     .claude/settings.local.json, .claude/CLAUDE.md) plus the local-scope
 *     entry under ~/.claude.json projects[<cwd>].
 *   - --global: ~/.claude/settings.json, ~/.claude/CLAUDE.md, and the
 *     user-scope mcpServers in ~/.claude.json.
 */

const fs = require('node:fs');
const {
  parseFlags,
  stripLapisHooks,
  removeAutoAllow,
  isLapisMcpEntry,
  readJson,
  writeJson,
  writeJsonOrRemove,
  removeClaudeMdBlock,
  resolveIo,
  configPaths,
} = require('./install');

/**
 * Strip LaPis hooks + auto-allow rules for every removed server name from one
 * settings file. Returns true if changed.
 */
function cleanSettingsFile(filePath, mcpNames) {
  if (!fs.existsSync(filePath)) {
    return false;
  }
  const settings = readJson(filePath),
    before = JSON.stringify(settings);
  stripLapisHooks(settings);
  if (settings.hooks && typeof settings.hooks === 'object' && Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }
  for (const name of mcpNames) {
    removeAutoAllow(settings, name);
  }
  if (JSON.stringify(settings) === before) {
    return false;
  }
  writeJsonOrRemove(filePath, settings);
  return true;
}

/**
 * Delete every LaPis server from an mcpServers map, whatever it was named —
 * sentinel identity, not name-keyed lookup, so `uninstall` without
 * `--mcp-name` still reverses an install that used a custom name. A user's
 * unrelated server that merely shares the name is left alone (the sentinel
 * requires the LaPis spawn signature). Returns removed names.
 */
function removeLapisServers(servers) {
  if (!servers || typeof servers !== 'object') {
    return [];
  }
  const removed = [];
  for (const [name, entry] of Object.entries(servers)) {
    if (isLapisMcpEntry(entry)) {
      delete servers[name];
      removed.push(name);
    }
  }
  return removed;
}

/** Remove the project-scope entries from .mcp.json. Returns removed names. */
function cleanProjectMcp(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const config = readJson(filePath),
    removed = removeLapisServers(config.mcpServers);
  if (removed.length === 0) {
    return [];
  }
  if (config.mcpServers && Object.keys(config.mcpServers).length === 0) {
    delete config.mcpServers;
  }
  writeJsonOrRemove(filePath, config);
  return removed;
}

/**
 * Remove LaPis entries from ~/.claude.json. That file also holds OAuth state
 * and per-project caches, so it is mutated surgically and never deleted.
 * Returns removed server names.
 */
function cleanClaudeJson(filePath, { user, projectKey }) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const config = readJson(filePath),
    removed = [];
  if (user) {
    const names = removeLapisServers(config.mcpServers);
    removed.push(...names);
    if (names.length > 0 && Object.keys(config.mcpServers).length === 0) {
      delete config.mcpServers;
    }
  }
  if (projectKey && config.projects && typeof config.projects === 'object') {
    const project = config.projects[projectKey],
      names = project ? removeLapisServers(project.mcpServers) : [];
    removed.push(...names);
    if (names.length > 0) {
      if (Object.keys(project.mcpServers).length === 0) {
        delete project.mcpServers;
      }
      if (Object.keys(project).length === 0) {
        delete config.projects[projectKey];
      }
      if (Object.keys(config.projects).length === 0) {
        delete config.projects;
      }
    }
  }
  if (removed.length > 0) {
    writeJson(filePath, config);
  }
  return removed;
}

/**
 * Run `lapis claude-code uninstall`.
 *
 * @param {string[]} argv  flags after `uninstall` (--global, --mcp-name)
 * @param {{ cwd?: string, home?: string, log?: Function }} [io]
 * @returns {{ cleaned: string[] }}
 */
async function runUninstall(argv, io) {
  const flags = parseFlags(argv),
    { home, cwd, log } = resolveIo(io),
    paths = configPaths({ home, cwd }),
    cleaned = [];

  // Best-effort: stop a daemon left by `install --daemon` so hooks don't keep
  // POSTing to a server whose config we just removed.
  try {
    const { readLockfile, runStop, defaultLockfilePath } = require('./daemon'),
      lockfilePath = io?.lockfilePath || defaultLockfilePath();
    if (readLockfile(lockfilePath)) {
      await runStop([], { ...io, lockfilePath, log: () => {} });
    }
  } catch {
    // Daemon stop must never block uninstall.
  }

  if (flags.global) {
    // MCP first so auto-allow cleanup covers whatever names were removed
    // (an install renamed via --mcp-name is still fully reversed).
    const removedNames = cleanClaudeJson(paths.claudeJson, { user: true });
    if (removedNames.length > 0) {
      cleaned.push(paths.claudeJson);
    }
    const mcpNames = [...new Set([flags.mcpName, ...removedNames])];
    if (cleanSettingsFile(paths.userSettings, mcpNames)) {
      cleaned.push(paths.userSettings);
    }
    if (removeClaudeMdBlock(paths.userClaudeMd)) {
      cleaned.push(paths.userClaudeMd);
    }
  } else {
    const removedNames = cleanProjectMcp(paths.projectMcp);
    if (removedNames.length > 0) {
      cleaned.push(paths.projectMcp);
    }
    const removedLocal = cleanClaudeJson(paths.claudeJson, { projectKey: cwd });
    if (removedLocal.length > 0) {
      cleaned.push(paths.claudeJson);
    }
    const mcpNames = [...new Set([flags.mcpName, ...removedNames, ...removedLocal])];
    if (cleanSettingsFile(paths.projectSettings, mcpNames)) {
      cleaned.push(paths.projectSettings);
    }
    if (cleanSettingsFile(paths.localSettings, mcpNames)) {
      cleaned.push(paths.localSettings);
    }
    if (removeClaudeMdBlock(paths.projectClaudeMd)) {
      cleaned.push(paths.projectClaudeMd);
    }
  }

  if (cleaned.length === 0) {
    log('Nothing to uninstall — no LaPis Claude Code config found.');
  } else {
    log('Uninstalled LaPis from Claude Code:');
    for (const file of cleaned) {
      log(`  cleaned ${file}`);
    }
  }
  return { cleaned };
}

module.exports = { runUninstall, cleanSettingsFile, cleanProjectMcp, cleanClaudeJson, removeLapisServers };
