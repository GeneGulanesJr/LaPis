'use strict';

/**
 * Claude Code bridge: locked read-modify-write helper for hook handlers.
 *
 * Wraps stateStore.mutateState when available; falls back to load/save for
 * injected test doubles that omit locking.
 */

function makeMutate(stateStore, claudeSessionId) {
  if (stateStore.mutateState) {
    return (mutator) => stateStore.mutateState(claudeSessionId, mutator);
  }
  return async (mutator) => {
    const state = stateStore.loadState(claudeSessionId);
    const result = await mutator(state);
    stateStore.saveState(claudeSessionId, state);
    return result;
  };
}

module.exports = { makeMutate };
