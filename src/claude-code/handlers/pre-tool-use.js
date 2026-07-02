'use strict';

/**
 * Claude Code PreToolUse handler.
 *
 * Runs BEFORE a tool executes and can block it (permissionDecision:"deny").
 * Hooks fail open — a crash/timeout here lets the tool proceed — so every
 * branch is cheap, synchronous where possible, and wrapped so an error never
 * blocks Claude Code (the router already catches throws).
 *
 * Roles (see tool-map.js):
 *   read-guardrail        block whole-file reads of indexed code
 *   search-guardrail      PRIMARY code-search guardrail (Grep)
 *   glob-guardrail        secondary discovery guardrail (Glob)
 *   bash-guardrail        secondary search guardrail (Bash grep/rg/find)
 *   memory-code-seed      seed exploredFiles from a memory-code call
 *   memory-reminder-reset reset the memory-reminder cadence on any memory-* tool
 *
 * Auto-index is DEFERRED (documented divergence from the Pi extension): a miss
 * never triggers indexing (that blows the hook timeout). Guardrails only fire
 * inside an already-indexed repo; unindexed projects are allowed through with
 * (for search) guidance to index manually.
 */

const path = require('node:path');
const { isCodeFile } = require('../../code-index/scanner');
const { resolveCwd, projectFromCwd, findMatchingRepo } = require('../../hooks-engine/project');
const {
  isPipedOutputFilter,
  isTargetedSymbolLookup,
  isTargetedGrepLookup,
  isBroadGlob,
  CONFIG_FILENAMES,
  RAW_CODE_DISCOVERY_RE,
  CODE_PATH_HINT_RE,
} = require('../../hooks-engine/guardrail-utils');
const { preToolRole } = require('../tool-map');
const { addNormalized } = require('../file-keys');

/** Build the PreToolUse deny envelope. */
function deny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

/** Add a file (and its basename) to the state's exploredFiles array, deduped. */
function addExploredFile(state, filePath) {
  if (!filePath) {
    return;
  }
  if (!Array.isArray(state.exploredFiles)) {
    state.exploredFiles = [];
  }
  addNormalized(state.exploredFiles, filePath);
}

/** Resolve the indexed repo the current cwd belongs to (cwd prefix or project name). */
function resolveRepo(resolvedCwd, repos, currentProject) {
  const byPath = findMatchingRepo(resolvedCwd, repos);
  if (byPath) {
    return byPath;
  }
  if (currentProject) {
    return repos.find((r) => r.name && r.name.toLowerCase() === currentProject.toLowerCase()) || null;
  }
  return null;
}

// --- guardrails ---------------------------------------------------------

function readGuardrail({ input, repos, cwd, state }) {
  const filePath = typeof input.file_path === 'string' ? input.file_path : input.path;
  if (typeof filePath !== 'string' || !filePath) {
    return null;
  }
  if (!isCodeFile(filePath)) {
    return null;
  }
  // Targeted slice read — the agent already knows where to look.
  if (typeof input.offset === 'number' || typeof input.limit === 'number') {
    return null;
  }
  const basename = path.basename(filePath);
  if (CONFIG_FILENAMES.has(basename)) {
    return null;
  }
  if (filePath.includes('node_modules')) {
    return null;
  }

  const absPath = path.resolve(cwd, filePath);
  // Cross-project reads (outside cwd) bypass the outline guard.
  if (absPath !== cwd && !absPath.startsWith(cwd + path.sep)) {
    return null;
  }

  const matchedRepo = repos.find(
    (r) =>
      absPath.toLowerCase().startsWith(`${r.path.toLowerCase()}${path.sep}`) ||
      absPath.toLowerCase() === r.path.toLowerCase(),
  );
  // Deferred auto-index: an unindexed project is allowed through (no outline to
  // point at, and indexing inline would blow the hook timeout).
  if (!matchedRepo) {
    return null;
  }

  const relPath = path.relative(matchedRepo.path, absPath).toLowerCase();
  const explored = Array.isArray(state.exploredFiles) ? state.exploredFiles : [];
  if (
    explored.includes(basename.toLowerCase()) ||
    explored.includes(relPath) ||
    explored.includes(absPath.toLowerCase())
  ) {
    return null;
  }

  return deny(
    `Use \`memory-code\` first to understand "${basename}" before reading it:\n` +
      `• \`memory-code outline --repo ${matchedRepo.name} --file ${relPath || basename}\` — file structure & symbols\n` +
      `• \`memory-code callers --repo ${matchedRepo.name} --symbol <name>\` — who calls what\n` +
      `• \`memory-code deps --repo ${matchedRepo.name}\` — dependency graph\n` +
      `After reviewing the outline, use \`read\` with \`offset\`/\`limit\` for targeted editing.`,
  );
}

function searchGuardrail({ input, repos, cwd, state }) {
  const pattern = input.pattern;
  const searchPath = input.path;
  const repo = resolveRepo(cwd, repos, state.currentProject);
  if (!repo) {
    return null; // unindexed → deferred, allow
  }
  if (isTargetedGrepLookup({ pattern, path: searchPath })) {
    return null;
  }
  return deny(
    `Broad code search detected in indexed repo "${repo.name}". Use \`memory-code\` instead of Grep:\n` +
      `• \`memory-code search --repo ${repo.name} --query <query>\` — find code symbols semantically\n` +
      `• \`memory-code outline --repo ${repo.name} --file <path>\` — file structure\n` +
      `• \`memory-code callers --repo ${repo.name} --symbol <name>\` — call hierarchy\n` +
      `For a single-symbol lookup, scope Grep to one file or use a plain symbol pattern (no regex).`,
  );
}

function globGuardrail({ input, repos, cwd, state }) {
  const pattern = input.pattern;
  const repo = resolveRepo(cwd, repos, state.currentProject);
  if (!repo) {
    return null;
  }
  if (!isBroadGlob(pattern)) {
    return null;
  }
  return deny(
    `Broad file discovery (\`${pattern}\`) in indexed repo "${repo.name}". Prefer \`memory-code\`:\n` +
      `• \`memory-code search --repo ${repo.name} --query <query>\`\n` +
      `• \`memory-code outline --repo ${repo.name} --file <path>\`\n` +
      `Scope the glob to a subdirectory (e.g. \`src/**/*.ts\`) if you must enumerate files.`,
  );
}

function bashGuardrail({ input, repos, cwd, state }) {
  const cmd = typeof input.command === 'string' ? input.command : '';
  if (!cmd || !RAW_CODE_DISCOVERY_RE.test(cmd)) {
    return null;
  }
  const repo = resolveRepo(cwd, repos, state.currentProject);
  if (!repo) {
    return null; // deferred auto-index: allow in unindexed projects
  }
  // Allow grep/rg used purely to filter another command's stdout.
  if (isPipedOutputFilter(cmd)) {
    return null;
  }
  // Allow targeted single-symbol lookups.
  if (isTargetedSymbolLookup(cmd)) {
    return null;
  }
  const searchHint = CODE_PATH_HINT_RE.test(cmd) ? 'Code search' : 'Raw repository search';
  return deny(
    `${searchHint} detected in indexed repo "${repo.name}". Use \`memory-code\` instead:\n` +
      `• \`memory-code search --repo ${repo.name} --query <query>\` — find code symbols\n` +
      `• \`memory-code outline --repo ${repo.name} --file <path>\` — file structure\n` +
      `• \`memory-code callers --repo ${repo.name} --symbol <name>\` — call hierarchy\n` +
      `• \`memory-code deps --repo ${repo.name}\` — dependency graph`,
  );
}

async function handlePreToolUse({ payload, getKnownRepos, stateStore }) {
  const toolName = payload.tool_name;
  const role = preToolRole(toolName);
  if (!role) {
    return null;
  }

  const input = (payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {}) || {};
  const claudeSessionId = payload.session_id;

  // Memory-tool cadence bookkeeping (state mutations Pi's tool_call hook does).
  // Routed through mutateState so a parallel memory-* tool can't lose the
  // update (#228). Falls back to load/save when the injected store lacks it.
  if (role === 'memory-code-seed' || role === 'memory-reminder-reset') {
    const mutate = stateStore.mutateState
      ? (mutator) => stateStore.mutateState(claudeSessionId, mutator)
      : (mutator) => {
          const state = stateStore.loadState(claudeSessionId);
          const r = mutator(state);
          stateStore.saveState(claudeSessionId, state);
          return r;
        };
    await mutate((state) => {
      state.lastMemoryToolCall = Date.now();
      state.callsSinceLastMemory = 0;
      if (role === 'memory-code-seed') {
        addExploredFile(state, input.file);
      }
    });
    return null;
  }

  const cwd = path.resolve(resolveCwd(payload.cwd));
  const repos = (typeof getKnownRepos === 'function' ? getKnownRepos() : []) || [];
  const state = stateStore.loadState(claudeSessionId);
  if (!state.currentProject) {
    state.currentProject = projectFromCwd(cwd);
  }

  const args = { input, repos, cwd, state };
  switch (role) {
    case 'read-guardrail':
      return readGuardrail(args);
    case 'search-guardrail':
      return searchGuardrail(args);
    case 'glob-guardrail':
      return globGuardrail(args);
    case 'bash-guardrail':
      return bashGuardrail(args);
    default:
      return null;
  }
}

module.exports = {
  handlePreToolUse,
  readGuardrail,
  searchGuardrail,
  globGuardrail,
  bashGuardrail,
  addExploredFile,
  resolveRepo,
};
