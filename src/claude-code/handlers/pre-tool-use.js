'use strict';

const path = require('node:path');
const {
  CONFIG_FILENAMES,
  RAW_CODE_DISCOVERY_RE,
  CODE_PATH_HINT_RE,
  isBroadGlobPattern,
  isCodeFile,
  isPipedOutputFilter,
  isTargetedGrepPattern,
  isTargetedSymbolLookup,
} = require('../../hooks-engine/guardrail-utils');
const { findMatchingRepo, projectFromCwd, resolveCwd } = require('../../hooks-engine/project');
const { isLapisMemoryCodeTool, isLapisMemoryTool } = require('../tool-map');

function deny(reason) {
  return {
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
  };
}

function loadState(stateStore, claudeSessionId) {
  return claudeSessionId ? stateStore.loadState(claudeSessionId) : stateStore.defaultState();
}

function saveState(stateStore, claudeSessionId, state) {
  if (claudeSessionId) {
    stateStore.saveState(claudeSessionId, state);
  }
}

function arraySet(values) {
  return new Set((Array.isArray(values) ? values : []).filter((v) => typeof v === 'string'));
}

function addExploredFile(state, file, repoPath) {
  if (typeof file !== 'string' || !file.trim()) {
    return false;
  }
  const explored = arraySet(state.exploredFiles);
  const before = explored.size;
  const normalized = file.trim();
  const lower = normalized.toLowerCase();
  explored.add(lower);
  explored.add(path.basename(normalized).toLowerCase());
  if (repoPath) {
    const abs = path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(repoPath, normalized);
    explored.add(abs.toLowerCase());
    explored.add(path.relative(repoPath, abs).toLowerCase());
  }
  state.exploredFiles = [...explored];
  return explored.size !== before;
}

function hasExploredFile(state, matchedRepo, absPath) {
  const explored = arraySet(state.exploredFiles);
  const fileBase = path.basename(absPath).toLowerCase();
  const repoPath = path.resolve(matchedRepo.path);
  const relPath = path.relative(repoPath, absPath).toLowerCase();
  return explored.has(fileBase) || explored.has(relPath) || explored.has(absPath.toLowerCase());
}

function resolveFilePath(cwd, filePath) {
  return path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(cwd, filePath);
}

function isInsideCwd(absPath, cwd) {
  const resolvedCwd = path.resolve(cwd);
  return absPath === resolvedCwd || absPath.startsWith(`${resolvedCwd}${path.sep}`);
}

function safeKnownRepos(getKnownRepos) {
  try {
    return getKnownRepos() || [];
  } catch {
    return [];
  }
}

function findRepoForPath(absPath, repos) {
  const normalized = path.resolve(absPath);
  return (
    repos.find((r) => {
      const repoPath = path.resolve(r.path);
      const fileLower = normalized.toLowerCase();
      const repoLower = repoPath.toLowerCase();
      return fileLower === repoLower || fileLower.startsWith(`${repoLower}${path.sep}`);
    }) || null
  );
}

function indexGuidance({ projectName, projectDir, noun }) {
  return (
    `${noun} in an unindexed project. Auto-indexing is disabled for Claude Code hooks to keep PreToolUse fast.\n` +
    `Index manually first: \`memory-code index-repo --path ${projectDir} --name ${projectName}\`\n` +
    `Then use \`memory-code search --repo ${projectName} --query <query>\` or ` +
    `\`memory-code outline --repo ${projectName} --file <path>\`.`
  );
}

function searchGuidance(searchHint, repoName) {
  return (
    `${searchHint} detected in indexed repo "${repoName}". Use \`memory-code\` instead:\n` +
    `- \`memory-code search --repo ${repoName} --query <query>\` - find code symbols\n` +
    `- \`memory-code outline --repo ${repoName} --file <path>\` - file structure\n` +
    `- \`memory-code callers --repo ${repoName} --symbol <name>\` - call hierarchy\n` +
    `- \`memory-code deps --repo ${repoName}\` - dependency graph\n` +
    `Targeted single-file Grep lookups remain allowed after you know which file to inspect.`
  );
}

function evaluateRead({ input, cwd, state, getKnownRepos }) {
  const filePath = input?.file_path || input?.path;
  if (typeof filePath !== 'string' || !isCodeFile(filePath)) {
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(input, 'offset') || Object.prototype.hasOwnProperty.call(input, 'limit')) {
    return null;
  }
  const basename = path.basename(filePath);
  if (CONFIG_FILENAMES.has(basename) || filePath.includes('node_modules')) {
    return null;
  }

  const absPath = resolveFilePath(cwd, filePath);
  if (!isInsideCwd(absPath, cwd)) {
    return null;
  }

  const repos = safeKnownRepos(getKnownRepos);
  const matchedRepo = findRepoForPath(absPath, repos);
  if (!matchedRepo) {
    const projectName = state.currentProject || projectFromCwd(cwd);
    return deny(
      `Cannot read "${basename}" before indexing this project.\n` +
        indexGuidance({ projectName, projectDir: path.resolve(cwd), noun: 'Whole-file code read' }),
    );
  }

  if (hasExploredFile(state, matchedRepo, absPath)) {
    return null;
  }

  const repoPath = path.resolve(matchedRepo.path);
  const relPath = path.relative(repoPath, absPath).toLowerCase() || basename;
  return deny(
    `Use \`memory-code\` first to understand "${basename}" before reading it:\n` +
      `- \`memory-code outline --repo ${matchedRepo.name} --file ${relPath}\` - file structure and symbols\n` +
      `- \`memory-code callers --repo ${matchedRepo.name} --symbol <name>\` - who calls what\n` +
      `- \`memory-code deps --repo ${matchedRepo.name}\` - dependency graph\n` +
      `After reviewing the outline, use Read with offset/limit for targeted editing.`,
  );
}

function getSearchRoot(cwd, input) {
  const rawPath = typeof input?.path === 'string' && input.path.trim() ? input.path.trim() : cwd;
  return resolveFilePath(cwd, rawPath);
}

function evaluateBroadSearch({ cwd, state, getKnownRepos, searchText, searchRoot }) {
  if (!isInsideCwd(searchRoot, cwd)) {
    return null;
  }
  const repos = safeKnownRepos(getKnownRepos);
  const matchedRepo = findRepoForPath(searchRoot, repos) || findMatchingRepo(path.resolve(cwd), repos);
  const searchHint = CODE_PATH_HINT_RE.test(searchText) ? 'Code search' : 'Raw repository search';
  if (matchedRepo) {
    return deny(searchGuidance(searchHint, matchedRepo.name));
  }
  const projectName = state.currentProject || projectFromCwd(cwd);
  return deny(indexGuidance({ projectName, projectDir: path.resolve(cwd), noun: searchHint }));
}

function evaluateGrep({ input, cwd, state, getKnownRepos }) {
  const pattern = input?.pattern;
  if (typeof pattern !== 'string') {
    return null;
  }
  if (isTargetedGrepPattern(pattern, input?.path)) {
    return null;
  }
  const searchRoot = getSearchRoot(cwd, input);
  return evaluateBroadSearch({ cwd, state, getKnownRepos, searchText: `${pattern} ${input?.path || ''}`, searchRoot });
}

function evaluateGlob({ input, cwd, state, getKnownRepos }) {
  const pattern = input?.pattern;
  if (!isBroadGlobPattern(pattern)) {
    return null;
  }
  const searchRoot = getSearchRoot(cwd, input);
  return evaluateBroadSearch({ cwd, state, getKnownRepos, searchText: `${pattern} ${input?.path || ''}`, searchRoot });
}

function evaluateBash({ input, cwd, state, getKnownRepos }) {
  const command = input?.command;
  if (typeof command !== 'string' || !RAW_CODE_DISCOVERY_RE.test(command)) {
    return null;
  }
  if (isPipedOutputFilter(command) || isTargetedSymbolLookup(command)) {
    return null;
  }
  return evaluateBroadSearch({ cwd, state, getKnownRepos, searchText: command, searchRoot: path.resolve(cwd) });
}

async function handlePreToolUse({ payload, getKnownRepos, stateStore }) {
  const toolName = payload?.tool_name || payload?.toolName;
  const input = payload?.tool_input || payload?.input || {};
  const cwd = path.resolve(resolveCwd(payload?.cwd));
  const claudeSessionId = payload?.session_id;
  const state = loadState(stateStore, claudeSessionId);

  if (isLapisMemoryTool(toolName)) {
    state.lastMemoryToolCall = Date.now();
    state.callsSinceLastMemory = 0;
    if (isLapisMemoryCodeTool(toolName)) {
      const repos = safeKnownRepos(getKnownRepos);
      const matchedRepo = findMatchingRepo(cwd, repos);
      addExploredFile(state, input.file || input.path, matchedRepo ? path.resolve(matchedRepo.path) : cwd);
    }
    saveState(stateStore, claudeSessionId, state);
    return null;
  }

  if (toolName === 'Read') {
    return evaluateRead({ input, cwd, state, getKnownRepos });
  }
  if (toolName === 'Grep') {
    return evaluateGrep({ input, cwd, state, getKnownRepos });
  }
  if (toolName === 'Glob') {
    return evaluateGlob({ input, cwd, state, getKnownRepos });
  }
  if (toolName === 'Bash') {
    return evaluateBash({ input, cwd, state, getKnownRepos });
  }
  return null;
}

module.exports = {
  handlePreToolUse,
  evaluateRead,
  evaluateGrep,
  evaluateGlob,
  evaluateBash,
  addExploredFile,
};
