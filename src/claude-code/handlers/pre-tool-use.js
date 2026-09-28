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
 * Guardrails only fire inside an already-indexed repo. A call that lands in an
 * UNINDEXED git repo is allowed through, but starts a detached background
 * `index-repo` (see ../auto-index.js — it never indexes inline, so the hook
 * timeout is untouched) and tells the agent so. Once the index exists the
 * guardrails apply on their own. Opt out: config `auto_index.enabled=false` or
 * LAPIS_AUTO_INDEX=0.
 */

const path = require('node:path'),
  { isCodeFile } = require('../../code-index/scanner'),
  { resolveIndexedRepo, normalizeRepoPath } = require('../../hooks-engine/project'),
  { resolveProjectForCwd } = require('../project-resolve'),
  { maybeStartAutoIndex, describeAutoIndex } = require('../auto-index'),
  {
    isPipedOutputFilter,
    isTargetedSymbolLookup,
    isTargetedGrepLookup,
    isBroadGlob,
    CONFIG_FILENAMES,
    RAW_CODE_DISCOVERY_RE,
    CODE_PATH_HINT_RE,
  } = require('../../hooks-engine/guardrail-utils'),
  { preToolRole } = require('../tool-map'),
  { addNormalized, normalizePathForCompare } = require('../file-keys');

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

/** Resolve the indexed repo the current cwd belongs to (path prefix or project name). */
function resolveRepo(resolvedCwd, repos, currentProject) {
  return resolveIndexedRepo(resolvedCwd, repos, currentProject);
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
  {
    const basename = path.basename(filePath);
    if (CONFIG_FILENAMES.has(basename)) {
      return null;
    }
    if (filePath.includes('node_modules')) {
      return null;
    }

    {
      const absPath = path.resolve(cwd, filePath),
        absNorm = normalizeRepoPath(absPath),
        cwdNorm = normalizeRepoPath(cwd);
      // Cross-project reads (outside cwd) bypass the outline guard.
      if (absNorm !== cwdNorm && !absNorm.startsWith(`${cwdNorm}/`)) {
        return null;
      }

      {
        const matchedRepo = repos.find((r) => {
          const rp = normalizeRepoPath(r.path);
          return absNorm === rp || absNorm.startsWith(`${rp}/`);
        });
        // Unindexed project: allowed through (no outline to point at); the
        // Background index is started by autoIndexOnMiss.
        if (!matchedRepo) {
          return null;
        }

        {
          const relPath = normalizePathForCompare(path.relative(matchedRepo.path, absPath)),
            explored = Array.isArray(state.exploredFiles) ? state.exploredFiles : [],
            exploredNorm = explored.map(normalizePathForCompare),
            basenameNorm = basename.toLowerCase();
          if (exploredNorm.includes(basenameNorm) || exploredNorm.includes(relPath) || exploredNorm.includes(absNorm)) {
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
      }
    }
  }
}

function searchGuardrail({ input, repos, cwd, state }) {
  const pattern = input.pattern,
    searchPath = input.path,
    repo = resolveRepo(cwd, repos, state.currentProject);
  if (!repo) {
    return null; // Unindexed → allow (autoIndexOnMiss starts the background index)
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
  const pattern = input.pattern,
    repo = resolveRepo(cwd, repos, state.currentProject);
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
    return null; // Unindexed → allow (autoIndexOnMiss starts the background index)
  }
  // Allow grep/rg used purely to filter another command's stdout.
  if (isPipedOutputFilter(cmd)) {
    return null;
  }
  // Allow targeted single-symbol lookups.
  if (isTargetedSymbolLookup(cmd)) {
    return null;
  }
  {
    const searchHint = CODE_PATH_HINT_RE.test(cmd) ? 'Code search' : 'Raw repository search';
    return deny(
      `${searchHint} detected in indexed repo "${repo.name}". Use \`memory-code\` instead:\n` +
        `• \`memory-code search --repo ${repo.name} --query <query>\` — find code symbols\n` +
        `• \`memory-code outline --repo ${repo.name} --file <path>\` — file structure\n` +
        `• \`memory-code callers --repo ${repo.name} --symbol <name>\` — call hierarchy\n` +
        `• \`memory-code deps --repo ${repo.name}\` — dependency graph`,
    );
  }
}

/**
 * A guardrail let the call through. If the cwd is an unindexed git repo, start
 * the detached background index (once — the marker dedupes) and, on the call
 * that actually started it, tell the agent why memory-code has no data yet.
 */
function autoIndexOnMiss({ args, autoIndex }) {
  const { repos, cwd, state } = args;
  if (resolveRepo(cwd, repos, state.currentProject)) {
    return null;
  }
  try {
    const result = autoIndex({ cwd, repos, currentProject: state.currentProject }),
      note = result.status === 'started' ? describeAutoIndex(result) : null;
    return note ? { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: note } } : null;
  } catch {
    return null; // Auto-index must never affect the tool call.
  }
}

async function handlePreToolUse({
  payload,
  getKnownRepos,
  getKnownProjects,
  stateStore,
  autoIndex = maybeStartAutoIndex,
}) {
  const toolName = payload.tool_name,
    role = preToolRole(toolName),
    input = (payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {}) || {},
    claudeSessionId = payload.session_id;
  if (!role) {
    return null;
  }

  // Memory-tool cadence bookkeeping (state mutations Pi's tool_call hook does).
  // Routed through mutateState so a parallel memory-* tool can't lose the
  // Update (#228). Falls back to load/save when the injected store lacks it.
  if (role === 'memory-code-seed' || role === 'memory-reminder-reset') {
    const mutate = stateStore.mutateState
      ? (mutator) => stateStore.mutateState(claudeSessionId, mutator)
      : (mutator) => {
          const state = stateStore.loadState(claudeSessionId),
            r = mutator(state);
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

  const { resolvedCwd: cwd, repos, project } = resolveProjectForCwd(payload.cwd, getKnownRepos, getKnownProjects),
    state = stateStore.loadState(claudeSessionId),
    args = (() => {
      if (!state.currentProject) {
        state.currentProject = project;
      }

      return { input, repos, cwd, state };
    })();
  const guardrails = {
      'read-guardrail': readGuardrail,
      'search-guardrail': searchGuardrail,
      'glob-guardrail': globGuardrail,
      'bash-guardrail': bashGuardrail,
    },
    guardrail = guardrails[role];
  if (!guardrail) {
    return null;
  }
  // A deny only happens inside an indexed repo, so auto-index runs only when the
  // Call was allowed through.
  return guardrail(args) || autoIndexOnMiss({ args, autoIndex });
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
