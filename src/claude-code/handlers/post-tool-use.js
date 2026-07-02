'use strict';

/**
 * Claude Code PostToolUse handler.
 *
 * SYNC state-store writes for edit tracking, git-trust sync (async dispatch),
 * and MCP tool-state mirroring (process-boundary fix for recall feedback).
 */

const { createGitTrustSyncAdapter } = require('../../trust-sync/change-detector');
const { resolveCwd, projectFromCwd } = require('../../hooks-engine/project');
const {
  extractResponseText,
  parseSearchResultIds,
  wasSaveSuccessful,
} = require('../../hooks-engine/tool-response-parse');
const { mcpShortName } = require('../tool-map');
const {
  addEditedFile,
  addExploredFile,
  harvestExploredFilesFromText,
  resetMemoryReminder,
  upsertRecallFeedback,
  removeRecallFeedback,
} = require('../state-mutations');
const { GIT_TRUST_RE } = require('./pre-tool-use');

const EDIT_TOOLS = new Set(['Write', 'MultiEdit', 'Edit']);

/**
 * Run PostToolUse tracking + mirroring. Always silent (returns null).
 */
async function handlePostToolUse({ payload, dispatch, getKnownRepos, stateStore }) {
  const toolName = payload.tool_name;
  const toolInput = payload.tool_input || {};
  const toolResponse = payload.tool_response;
  const claudeSessionId = payload.session_id;

  const state = stateStore.loadState(claudeSessionId);
  let changed = false;

  if (EDIT_TOOLS.has(toolName) && toolInput.file_path) {
    addEditedFile(state, toolInput.file_path);
    changed = true;
  }

  if (toolName === 'Bash' && GIT_TRUST_RE.test(toolInput.command || '')) {
    void runGitTrustSync({ dispatch, getKnownRepos, state, cwd: payload.cwd }).catch(() => {});
  }

  const short = mcpShortName(toolName);
  if (short && short.startsWith('memory-')) {
    resetMemoryReminder(state);
    changed = true;

    const responseText = extractResponseText(toolResponse);

    if (short === 'memory-save' && wasSaveSuccessful(responseText)) {
      state.memoriesSavedThisSession = (state.memoriesSavedThisSession || 0) + 1;
      changed = true;
    }

    if (short === 'memory-search') {
      const ids = parseSearchResultIds(responseText);
      const query = toolInput.query || '';
      for (const id of ids) {
        upsertRecallFeedback(state, id, { sessionId: state.sessionId || 0, query });
      }
      changed = true;
    }

    if (short === 'memory-get' || short === 'memory-delete') {
      if (toolInput.id != null) {
        removeRecallFeedback(state, Number(toolInput.id));
        changed = true;
      }
    }

    if (short === 'memory-code') {
      if (toolInput.file) {
        addExploredFile(state, toolInput.file);
      }
      harvestExploredFilesFromText(state, responseText);
      changed = true;
    }
  }

  if (changed) {
    stateStore.saveState(claudeSessionId, state);
  }

  return null;
}

async function runGitTrustSync({ dispatch, getKnownRepos, state, cwd }) {
  const project = state.currentProject || projectFromCwd(resolveCwd(cwd));
  if (!project) {
    return;
  }

  const repos = await getKnownRepos();
  const repo = repos.find((r) => r.name.toLowerCase() === project.toLowerCase());
  if (!repo) {
    return;
  }

  const sync = createGitTrustSyncAdapter((cmd, args) => dispatch(cmd, args));
  await sync(repo.name);
}

module.exports = { handlePostToolUse, runGitTrustSync };
