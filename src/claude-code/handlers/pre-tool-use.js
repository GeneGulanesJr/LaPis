'use strict';

/**
 * Claude Code PreToolUse handler.
 *
 * Guardrails for Read, Grep (primary), Glob, Bash (secondary), and
 * mcp__lapis__* memory tools. Auto-index on miss is intentionally NOT done
 * here (hook timeout risk); guidance points to manual memory-code index-repo.
 */

const path = require('node:path');
const { isCodeFile } = require('../../code-index/scanner');
const { resolveCwd, projectFromCwd, findMatchingRepo } = require('../../hooks-engine/project');
const {
  CONFIG_FILENAMES,
  RAW_CODE_DISCOVERY_RE,
  CODE_PATH_HINT_RE,
  isPipedOutputFilter,
  isTargetedSymbolLookup,
  isTargetedGrepLookup,
  isBroadGlobDiscovery,
} = require('../../hooks-engine/guardrail-utils');
const { mcpShortName } = require('../tool-map');
const { addExploredFile, hasExploredFile, resetMemoryReminder } = require('../state-mutations');

const GIT_TRUST_RE = /\bgit\s+(pull|checkout|merge|rebase|reset|stash\s+pop)\b/;

function deny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

function memoryCodeGuidance(repoName, extras = '') {
  return (
    `Use \`memory-code\` instead:\n` +
    `• \`memory-code search --repo ${repoName} --query <query>\` — find code symbols\n` +
    `• \`memory-code outline --repo ${repoName} --file <path>\` — file structure\n` +
    `• \`memory-code callers --repo ${repoName} --symbol <name>\` — call hierarchy\n` +
    `• \`memory-code deps --repo ${repoName}\` — dependency graph\n` +
    `• \`memory-code importance --repo ${repoName}\` — hotspots & churn` +
    (extras ? `\n${extras}` : '')
  );
}

function findRepoForCwd(repos, cwd, project) {
  const resolvedCwd = path.resolve(cwd);
  return (
    repos.find((r) => resolvedCwd.startsWith(path.resolve(r.path))) ||
    repos.find((r) => project && project.toLowerCase() === r.name.toLowerCase()) ||
    findMatchingRepo(resolvedCwd, repos)
  );
}

function handleReadGuardrail({ toolInput, repos, cwd, state }) {
  const filePath = toolInput.file_path;
  if (!filePath || typeof filePath !== 'string') {
    return null;
  }
  if (!isCodeFile(filePath)) {
    return null;
  }
  if (typeof toolInput.offset === 'number' || typeof toolInput.limit === 'number') {
    return null;
  }
  const basename = path.basename(filePath);
  if (CONFIG_FILENAMES.has(basename)) {
    return null;
  }
  if (filePath.includes('node_modules')) {
    return null;
  }

  const absPath = path.resolve(filePath);
  const resolvedCwd = path.resolve(cwd);
  if (absPath !== resolvedCwd && !absPath.startsWith(`${resolvedCwd}${path.sep}`)) {
    return null;
  }

  const matchedRepo = findMatchingRepo(absPath, repos);
  if (!matchedRepo) {
    const projectDir = absPath.startsWith(resolvedCwd) ? resolvedCwd : path.dirname(absPath);
    const projectName = state.currentProject || projectFromCwd(projectDir);
    return deny(
      `Cannot read "${basename}" — project is not indexed.\n` +
        `Index manually: \`memory-code index-repo --path ${projectDir} --name ${projectName}\`\n` +
        `Then use \`memory-code outline --repo ${projectName} --file <path>\` before reading.`,
    );
  }

  if (hasExploredFile(state, filePath, matchedRepo.path)) {
    return null;
  }

  const relPath = path.relative(matchedRepo.path, absPath);
  return deny(
    `Use \`memory-code\` first to understand "${basename}" before reading it:\n` +
      `• \`memory-code outline --repo ${matchedRepo.name} --file ${relPath || basename}\` — file structure & symbols\n` +
      `• \`memory-code callers --repo ${matchedRepo.name} --symbol <name>\` — who calls what\n` +
      `• \`memory-code deps --repo ${matchedRepo.name}\` — dependency graph\n` +
      `After reviewing the outline, use \`read\` with \`offset\`/\`limit\` for targeted editing.`,
  );
}

function handleGrepGuardrail({ toolInput, repos, cwd, project }) {
  const pattern = toolInput.pattern;
  const searchPath = toolInput.path || cwd;

  if (isTargetedGrepLookup(pattern, searchPath)) {
    return null;
  }

  const matchedRepo = findRepoForCwd(repos, cwd, project);
  if (!matchedRepo) {
    return null;
  }

  const searchHint = CODE_PATH_HINT_RE.test(String(pattern)) ? 'Code search' : 'Raw repository search';
  return deny(`${searchHint} detected in indexed repo "${matchedRepo.name}". ${memoryCodeGuidance(matchedRepo.name)}`);
}

function handleGlobGuardrail({ toolInput, repos, cwd, project }) {
  const pattern = toolInput.pattern;
  if (!isBroadGlobDiscovery(pattern)) {
    return null;
  }

  const matchedRepo = findRepoForCwd(repos, cwd, project);
  if (!matchedRepo) {
    return null;
  }

  return deny(
    `Broad file discovery (\`${pattern}\`) in indexed repo "${matchedRepo.name}". ` +
      `Use \`memory-code search --repo ${matchedRepo.name} --query <query>\` or ` +
      `\`memory-code outline --repo ${matchedRepo.name} --file <path>\` instead of Glob.`,
  );
}

function handleBashGuardrail({ toolInput, repos, cwd, project }) {
  const cmd = toolInput.command;
  if (!cmd || typeof cmd !== 'string' || !RAW_CODE_DISCOVERY_RE.test(cmd)) {
    return null;
  }

  const matchedRepo = findRepoForCwd(repos, cwd, project);
  if (!matchedRepo) {
    return null;
  }

  if (isPipedOutputFilter(cmd)) {
    return null;
  }
  if (isTargetedSymbolLookup(cmd)) {
    return null;
  }

  const searchHint = CODE_PATH_HINT_RE.test(cmd) ? 'Code search' : 'Raw repository search';
  return deny(`${searchHint} detected in indexed repo "${matchedRepo.name}". ${memoryCodeGuidance(matchedRepo.name)}`);
}

function handleMcpMemoryCodePre({ toolInput, state }) {
  resetMemoryReminder(state);
  const file = toolInput.file;
  if (file) {
    addExploredFile(state, file);
  }
  return null;
}

function handleMcpMemoryPre({ state }) {
  resetMemoryReminder(state);
  return null;
}

/**
 * Run PreToolUse guardrails.
 *
 * @returns {Promise<object|null>} deny envelope or null (allow)
 */
async function handlePreToolUse({ payload, getKnownRepos, stateStore }) {
  const toolName = payload.tool_name;
  const toolInput = payload.tool_input || {};
  const claudeSessionId = payload.session_id;
  const cwd = resolveCwd(payload.cwd);
  const project = projectFromCwd(cwd);

  const state = stateStore.loadState(claudeSessionId);

  const short = mcpShortName(toolName);
  if (short === 'memory-code') {
    handleMcpMemoryCodePre({ toolInput, state });
    stateStore.saveState(claudeSessionId, state);
    return null;
  }
  if (short && short.startsWith('memory-')) {
    handleMcpMemoryPre({ state });
    stateStore.saveState(claudeSessionId, state);
    return null;
  }

  const repos = await getKnownRepos();

  let decision = null;
  if (toolName === 'Read') {
    decision = handleReadGuardrail({ toolInput, repos, cwd, state });
  } else if (toolName === 'Grep') {
    decision = handleGrepGuardrail({ toolInput, repos, cwd, project });
  } else if (toolName === 'Glob') {
    decision = handleGlobGuardrail({ toolInput, repos, cwd, project });
  } else if (toolName === 'Bash') {
    if (!GIT_TRUST_RE.test(toolInput.command || '')) {
      decision = handleBashGuardrail({ toolInput, repos, cwd, project });
    }
  }

  return decision;
}

module.exports = {
  handlePreToolUse,
  deny,
  GIT_TRUST_RE,
};
