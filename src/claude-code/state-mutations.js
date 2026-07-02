'use strict';

/**
 * Claude Code bridge: helpers for mutating persisted session state fields.
 *
 * State-store uses JSON-serializable arrays (not Sets/Maps) for exploredFiles,
 * editedFiles, and pendingRecallFeedback.
 */

const path = require('node:path');

function normalizeExploredKey(value) {
  return String(value || '').toLowerCase();
}

function hasExploredFile(state, filePath, repoPath) {
  const explored = state.exploredFiles || [];
  const absPath = path.resolve(filePath);
  const fileBase = path.basename(filePath).toLowerCase();
  const relPath = repoPath ? path.relative(repoPath, absPath).toLowerCase() : '';
  const absLower = absPath.toLowerCase();

  return explored.some(
    (entry) =>
      entry === fileBase || entry === relPath || entry === absLower || entry === normalizeExploredKey(filePath),
  );
}

function addExploredFile(state, filePath) {
  if (!filePath) {
    return;
  }
  const explored = state.exploredFiles || [];
  const next = new Set(explored);
  next.add(normalizeExploredKey(filePath));
  next.add(path.basename(filePath).toLowerCase());
  state.exploredFiles = [...next];
}

function harvestExploredFilesFromText(state, text) {
  if (!text || typeof text !== 'string') {
    return;
  }
  const filePaths = text.match(/[\w/.-]+\.(ts|js|tsx|jsx|mjs|cjs|py|go|rs)/gi) || [];
  for (const fp of filePaths) {
    addExploredFile(state, fp);
  }
}

function addEditedFile(state, filePath) {
  if (!filePath) {
    return;
  }
  const edited = state.editedFiles || [];
  if (!edited.includes(filePath)) {
    state.editedFiles = [...edited, filePath];
  }
}

function resetMemoryReminder(state) {
  state.lastMemoryToolCall = Date.now();
  state.callsSinceLastMemory = 0;
}

function upsertRecallFeedback(state, memoryId, meta) {
  const entries = state.pendingRecallFeedback || [];
  const filtered = entries.filter(([id]) => id !== memoryId);
  filtered.push([memoryId, meta]);
  state.pendingRecallFeedback = filtered;
}

function removeRecallFeedback(state, memoryId) {
  const entries = state.pendingRecallFeedback || [];
  state.pendingRecallFeedback = entries.filter(([id]) => id !== memoryId);
}

module.exports = {
  hasExploredFile,
  addExploredFile,
  harvestExploredFilesFromText,
  addEditedFile,
  resetMemoryReminder,
  upsertRecallFeedback,
  removeRecallFeedback,
};
