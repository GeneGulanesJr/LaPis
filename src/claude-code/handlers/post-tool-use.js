'use strict';

const path = require('node:path');
const {
  normalizeToolResponseText,
  parseMemoryIds,
  parseSearchResultIds,
  wasSaveSuccessful,
} = require('../../hooks-engine');
const { findMatchingRepo, resolveCwd } = require('../../hooks-engine/project');
const {
  isEditTool,
  isGitTrustBash,
  isLapisMemoryCodeTool,
  isLapisMemoryTool,
  normalizeMemoryToolName,
} = require('../tool-map');

const CODE_PATH_RE = /[\w/.-]+\.(?:ts|js|tsx|jsx|mjs|cjs|py|go|rs)/g;

function loadState(stateStore, claudeSessionId) {
  return claudeSessionId ? stateStore.loadState(claudeSessionId) : stateStore.defaultState();
}

function saveState(stateStore, claudeSessionId, state) {
  if (claudeSessionId) {
    stateStore.saveState(claudeSessionId, state);
  }
}

function addToArrayField(state, field, value, { lower = false } = {}) {
  if (typeof value !== 'string' || !value.trim()) {
    return false;
  }
  const normalized = lower ? value.trim().toLowerCase() : value.trim();
  const values = new Set(Array.isArray(state[field]) ? state[field] : []);
  const before = values.size;
  values.add(normalized);
  state[field] = [...values];
  return values.size !== before;
}

function addExploredPath(state, filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    return false;
  }
  let changed = false;
  changed = addToArrayField(state, 'exploredFiles', filePath, { lower: true }) || changed;
  changed = addToArrayField(state, 'exploredFiles', path.basename(filePath), { lower: true }) || changed;
  return changed;
}

function pendingRecallMap(state) {
  return new Map(Array.isArray(state.pendingRecallFeedback) ? state.pendingRecallFeedback : []);
}

function setPendingRecallMap(state, feedback) {
  state.pendingRecallFeedback = [...feedback.entries()];
}

function removePendingRecallIds(state, ids) {
  const feedback = pendingRecallMap(state);
  let changed = false;
  for (const id of ids) {
    if (feedback.delete(id)) {
      changed = true;
    }
  }
  if (changed) {
    setPendingRecallMap(state, feedback);
  }
  return changed;
}

function parseInputId(input) {
  const raw = input?.id || input?.memory_id || input?.memoryId;
  const id = Number.parseInt(String(raw), 10);
  return Number.isInteger(id) ? id : null;
}

function harvestExploredFiles(state, toolResponse) {
  const responseText = normalizeToolResponseText(toolResponse);
  const matches = responseText.match(CODE_PATH_RE) || [];
  let changed = false;
  for (const match of matches) {
    changed = addExploredPath(state, match) || changed;
  }
  return changed;
}

function mirrorMemorySave(state, toolResponse) {
  if (!wasSaveSuccessful(toolResponse)) {
    return false;
  }
  state.memoriesSavedThisSession = (Number(state.memoriesSavedThisSession) || 0) + 1;
  return true;
}

function mirrorMemorySearch(state, input, toolResponse) {
  const ids = parseSearchResultIds(toolResponse);
  if (ids.length === 0) {
    return false;
  }
  const query = typeof input?.query === 'string' ? input.query : '';
  const feedback = pendingRecallMap(state);
  for (const id of ids) {
    feedback.set(id, { sessionId: state.sessionId || 0, query });
  }
  setPendingRecallMap(state, feedback);
  return true;
}

function mirrorMemoryGetOrDelete(state, input, toolResponse) {
  const ids = parseMemoryIds(toolResponse);
  const inputId = parseInputId(input);
  if (inputId !== null) {
    ids.push(inputId);
  }
  return removePendingRecallIds(state, [...new Set(ids)]);
}

function safeKnownRepos(getKnownRepos) {
  try {
    return getKnownRepos() || [];
  } catch {
    return [];
  }
}

async function syncGitTrust({ dispatch, getKnownRepos, state, cwd }) {
  const repos = safeKnownRepos(getKnownRepos);
  const repo =
    (state.currentProject &&
      repos.find((r) => typeof r.name === 'string' && r.name.toLowerCase() === state.currentProject.toLowerCase())) ||
    findMatchingRepo(cwd, repos);
  if (!repo) {
    return;
  }
  try {
    await dispatch('sync-code-trust', { repo: repo.name });
  } catch {
    // Trust sync is best-effort; PostToolUse must not fail the host tool.
  }
}

async function handlePostToolUse({ payload, dispatch, getKnownRepos, stateStore }) {
  const toolName = payload?.tool_name || payload?.toolName;
  const input = payload?.tool_input || payload?.input || {};
  const toolResponse = payload?.tool_response ?? payload?.result ?? '';
  const cwd = path.resolve(resolveCwd(payload?.cwd));
  const claudeSessionId = payload?.session_id;
  const state = loadState(stateStore, claudeSessionId);
  let changed = false;

  if (isEditTool(toolName)) {
    changed = addToArrayField(state, 'editedFiles', input.file_path || input.path) || changed;
  }

  if (isGitTrustBash(toolName, input)) {
    await syncGitTrust({ dispatch, getKnownRepos, state, cwd });
  }

  if (isLapisMemoryTool(toolName)) {
    const memoryToolName = normalizeMemoryToolName(toolName);
    state.lastMemoryToolCall = Date.now();
    state.callsSinceLastMemory = 0;
    changed = true;

    if (isLapisMemoryCodeTool(toolName)) {
      changed = harvestExploredFiles(state, toolResponse) || changed;
    } else if (memoryToolName === 'memory-save') {
      changed = mirrorMemorySave(state, toolResponse) || changed;
    } else if (memoryToolName === 'memory-search') {
      changed = mirrorMemorySearch(state, input, toolResponse) || changed;
    } else if (memoryToolName === 'memory-get' || memoryToolName === 'memory-delete') {
      changed = mirrorMemoryGetOrDelete(state, input, toolResponse) || changed;
    }
  }

  if (changed) {
    saveState(stateStore, claudeSessionId, state);
  }
  return null;
}

module.exports = {
  handlePostToolUse,
  harvestExploredFiles,
  mirrorMemorySave,
  mirrorMemorySearch,
  mirrorMemoryGetOrDelete,
};
