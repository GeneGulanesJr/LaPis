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

/** Strip LaPis hooks + auto-allow from one settings file. Returns true if changed. */
function cleanSettingsFile(filePath, mcpName) {
  if (!fs.existsSync(filePath)) {
    return false;
  }
  const settings = readJson(filePath);
  const before = JSON.stringify(settings);
  stripLapisHooks(settings);
  if (settings.hooks && typeof settings.hooks === 'object' && Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }
  removeAutoAllow(settings, mcpName);
  if (JSON.stringify(settings) === before) {
    return false;
  }
  writeJsonOrRemove(filePath, settings);
  return true;
}

/**
 * Delete the named server from an mcpServers map, but only when the sentinel
 * confirms it is a LaPis entry — a user's unrelated server that happens to
 * share the name is left alone. Returns removed names.
 */
function removeLapisServers(servers, mcpName) {
  if (!servers || typeof servers !== 'object') {
    return [];
  }
  if (!(mcpName in servers) || !isLapisMcpEntry(servers[mcpName])) {
    return [];
  }
  delete servers[mcpName];
  return [mcpName];
}

/** Remove the project-scope entry from .mcp.json. */
function cleanProjectMcp(filePath, mcpName) {
  if (!fs.existsSync(filePath)) {
    return false;
  }
  const config = readJson(filePath);
  const removed = removeLapisServers(config.mcpServers, mcpName);
  if (removed.length === 0) {
    return false;
  }
  if (config.mcpServers && Object.keys(config.mcpServers).length === 0) {
    delete config.mcpServers;
  }
  writeJsonOrRemove(filePath, config);
  return true;
}

/**
 * Remove LaPis entries from ~/.claude.json. That file also holds OAuth state
 * and per-project caches, so it is mutated surgically and never deleted.
 */
function cleanClaudeJson(filePath, mcpName, { user, projectKey }) {
  if (!fs.existsSync(filePath)) {
    return false;
  }
  const config = readJson(filePath);
  let changed = false;
  if (user && removeLapisServers(config.mcpServers, mcpName).length > 0) {
    changed = true;
    if (Object.keys(config.mcpServers).length === 0) {
      delete config.mcpServers;
    }
  }
  if (projectKey && config.projects && typeof config.projects === 'object') {
    const project = config.projects[projectKey];
    if (project && removeLapisServers(project.mcpServers, mcpName).length > 0) {
      changed = true;
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
  if (changed) {
    writeJson(filePath, config);
  }
  return changed;
}

/**
 * Run `lapis claude-code uninstall`.
 *
 * @param {string[]} argv  flags after `uninstall` (--global, --mcp-name)
 * @param {{ cwd?: string, home?: string, log?: Function }} [io]
 * @returns {{ cleaned: string[] }}
 */
function runUninstall(argv, io) {
  const flags = parseFlags(argv);
  const { home, cwd, log } = resolveIo(io);
  const paths = configPaths({ home, cwd });
  const cleaned = [];

  if (flags.global) {
    if (cleanSettingsFile(paths.userSettings, flags.mcpName)) {
      cleaned.push(paths.userSettings);
    }
    if (cleanClaudeJson(paths.claudeJson, flags.mcpName, { user: true })) {
      cleaned.push(paths.claudeJson);
    }
    if (removeClaudeMdBlock(paths.userClaudeMd)) {
      cleaned.push(paths.userClaudeMd);
    }
  } else {
    if (cleanProjectMcp(paths.projectMcp, flags.mcpName)) {
      cleaned.push(paths.projectMcp);
    }
    if (cleanSettingsFile(paths.projectSettings, flags.mcpName)) {
      cleaned.push(paths.projectSettings);
    }
    if (cleanSettingsFile(paths.localSettings, flags.mcpName)) {
      cleaned.push(paths.localSettings);
    }
    if (cleanClaudeJson(paths.claudeJson, flags.mcpName, { projectKey: cwd })) {
      cleaned.push(paths.claudeJson);
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
