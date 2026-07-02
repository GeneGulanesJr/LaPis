'use strict';

/**
 * Claude Code PostToolUse handler.
 *
 * Runs AFTER a tool succeeds. SILENT (returns null) — it never blocks or
 * annotates; its whole job is to reconstruct the in-process `state` mutations
 * Pi's tools perform synchronously but which are invisible across Claude Code's
 * process boundary (see issue #208 "Why the tool-state mirroring is critical").
 *
 * Roles (see tool-map.js):
 *   edit-track           Write|MultiEdit|Edit → record file_path in editedFiles
 *   git-trust            Bash git pull/checkout/merge/rebase/reset/stash-pop → sync-code-trust
 *   memory-save-mirror   memory-save (success) → memoriesSavedThisSession++
 *   memory-search-mirror memory-search → populate pendingRecallFeedback
 *   memory-get-mirror    memory-get|memory-delete → drop consumed ids (marked useful)
 *   memory-code-harvest  memory-code → harvest file paths into exploredFiles
 *
 * All state writes are load → mutate → save on the per-session state file.
 * lost-update under parallel PostToolUse is tolerated for counters (documented
 * risk); the set-like fields dedupe so a concurrent add is at worst a no-op.
 */

const {
  parseSearchResultIds,
  parseMemoryIds,
  wasSaveSuccessful,
  extractToolResponseText,
} = require('../../hooks-engine/tool-response-parse');
const { resolveCwd, projectFromCwd } = require('../../hooks-engine/project');
const { postToolRole } = require('../tool-map');

const GIT_TRUST_OP_RE = /\bgit\s+(pull|checkout|merge|rebase|reset|stash\s+pop)\b/;
// Harvest relative code paths from a memory-code response (parity with the Pi
// tool_result handler in tool-guardrails.ts).
const CODE_PATH_RE = /[\w/.-]+\.(ts|js|tsx|jsx|mjs|cjs|py|go|rs)/g;

function addEditedFile(state, filePath) {
  if (!filePath) {
    return;
  }
  if (!Array.isArray(state.editedFiles)) {
    state.editedFiles = [];
  }
  if (!state.editedFiles.includes(filePath)) {
    state.editedFiles.push(filePath);
  }
}

function addExploredPath(state, p) {
  if (!p) {
    return;
  }
  if (!Array.isArray(state.exploredFiles)) {
    state.exploredFiles = [];
  }
  const lower = String(p).toLowerCase();
  const base = lower.split('/').pop();
  for (const candidate of [lower, base]) {
    if (candidate && !state.exploredFiles.includes(candidate)) {
      state.exploredFiles.push(candidate);
    }
  }
}

/** Harvest file paths mentioned in a memory-code response into exploredFiles. */
function harvestExploredFiles(state, toolResponse) {
  const text = extractToolResponseText(toolResponse);
  if (!text) {
    return;
  }
  const matches = text.match(CODE_PATH_RE) || [];
  for (const fp of matches) {
    addExploredPath(state, fp);
  }
}

/** Append search-result ids to pendingRecallFeedback (array of [id, meta] pairs). */
function recordSearchRecall(state, ids, query) {
  if (!Array.isArray(state.pendingRecallFeedback)) {
    state.pendingRecallFeedback = [];
  }
  const known = new Set(state.pendingRecallFeedback.map(([id]) => id));
  const sessionId = state.sessionId || 0;
  for (const id of ids) {
    if (!known.has(id)) {
      known.add(id);
      state.pendingRecallFeedback.push([id, { sessionId, query: query || '' }]);
    }
  }
}

/** Drop ids from pendingRecallFeedback — a get/delete means the memory was useful. */
function consumeRecall(state, ids) {
  if (!Array.isArray(state.pendingRecallFeedback) || state.pendingRecallFeedback.length === 0) {
    return;
  }
  const drop = new Set(ids);
  state.pendingRecallFeedback = state.pendingRecallFeedback.filter(([id]) => !drop.has(id));
}

/**
 * Git-trust sync. Best-effort and awaited (a per-event hook process would exit
 * before a fire-and-forget dispatch ran). Never throws.
 */
async function gitTrustSync({ input, dispatch, getKnownRepos, state, cwd }) {
  const cmd = typeof input.command === 'string' ? input.command : '';
  if (!cmd || !GIT_TRUST_OP_RE.test(cmd)) {
    return;
  }
  const project = state.currentProject || projectFromCwd(cwd);
  if (!project) {
    return;
  }
  const repos = (typeof getKnownRepos === 'function' ? getKnownRepos() : []) || [];
  const repo = repos.find((r) => r.name && r.name.toLowerCase() === project.toLowerCase());
  if (!repo) {
    return;
  }
  try {
    await dispatch('sync-code-trust', { repo: repo.name });
  } catch {
    // Trust sync is best-effort; a failure must not surface to Claude Code.
  }
}

async function handlePostToolUse({ payload, dispatch, getKnownRepos, stateStore, roleFilter }) {
  const toolName = payload.tool_name;
  const role = postToolRole(toolName);
  if (!role) {
    return null;
  }
  // Role filter (`--only`/`--skip` from the install config): lets one Claude
  // Code event be split across two handlers — synchronous tracking/mirroring
  // vs an async `--only git-trust` handler — without double-firing a role.
  if (roleFilter && ((roleFilter.only && role !== roleFilter.only) || roleFilter.skip === role)) {
    return null;
  }

  const input = (payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {}) || {};
  const toolResponse = payload.tool_response;
  const claudeSessionId = payload.session_id;
  const cwd = resolveCwd(payload.cwd);

  const state = stateStore.loadState(claudeSessionId);
  if (!state.currentProject) {
    state.currentProject = projectFromCwd(cwd);
  }

  switch (role) {
    case 'edit-track':
      addEditedFile(state, input.file_path);
      break;
    case 'git-trust':
      await gitTrustSync({ input, dispatch, getKnownRepos, state, cwd });
      // Deliberately NO saveState: this role runs in the async split handler
      // (install config `--only git-trust`), gitTrustSync never mutates state,
      // and writing the pre-dispatch snapshot back after a slow sync-code-trust
      // would clobber whatever the synchronous handler saved in the meantime.
      return null;
    case 'memory-save-mirror':
      if (wasSaveSuccessful(toolResponse)) {
        state.memoriesSavedThisSession = (state.memoriesSavedThisSession || 0) + 1;
      }
      break;
    case 'memory-search-mirror':
      recordSearchRecall(state, parseSearchResultIds(toolResponse), input.query);
      break;
    case 'memory-get-mirror': {
      // memory-get / memory-delete both take a single `id`; prefer it, fall
      // back to parsing the response for robustness.
      const targetId = Number(input.id);
      const ids = Number.isFinite(targetId) ? [targetId] : parseMemoryIds(toolResponse);
      consumeRecall(state, ids);
      break;
    }
    case 'memory-code-harvest':
      harvestExploredFiles(state, toolResponse);
      break;
    default:
      return null;
  }

  stateStore.saveState(claudeSessionId, state);
  return null; // silent — PostToolUse injects nothing
}

module.exports = {
  handlePostToolUse,
  addEditedFile,
  addExploredPath,
  harvestExploredFiles,
  recordSearchRecall,
  consumeRecall,
  gitTrustSync,
  GIT_TRUST_OP_RE,
};
