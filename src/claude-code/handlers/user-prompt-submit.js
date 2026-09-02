'use strict';

/**
 * Claude Code UserPromptSubmit handler.
 *
 * Builds prompt-matched context + (when preflight-worthy) preflight/coding
 * context (best-effort, timeout-safe), then appends the cadence-gated memory
 * reminder (parity with Pi's context-event reminder, moved here per #207).
 * Passes the stored numeric sessionId as `session-id` to context.
 *
 * 30s overall budget: the whole dispatch sequence is raced against a timeout
 * that resolves with whatever context was gathered so far rather than
 * rejecting — best-effort, never blocks the prompt.
 */

const path = require('node:path');
const { CONTEXT } = require('../../../constants');
const { findMatchingRepo } = require('../../hooks-engine/project');
const { resolveProjectForCwd } = require('../project-resolve');
const { isPreflightWorthyPrompt } = require('../../hooks-engine/prompt-classifiers');
const {
  appendPreflightBlock,
  chooseCodingContextTarget,
  appendCodingContextBlock,
  unwrapAnalysisData,
} = require('../../hooks-engine/preflight-assembly');
const { capInjectedContext } = require('../../hooks-engine/context-builder');
const { assembleContextLines } = require('../context-inject');
const { makeMutate } = require('../state-mutate'),
  BUDGET_MS = 30000,
  REMINDER_INTERVAL = 5, // MEMORY_REMINDER_INTERVAL (state.ts:107)
  REMINDER_RECENT_MS = 180000, // 3min (context-injection.ts:235)
  REMINDER_TEXT =
    '💡 Memory reminder: Use `memory-search` before decisions to avoid repeating past mistakes. Use `memory-save` for decisions, bugfixes, and discoveries.';

/**
 * Append preflight + coding-context blocks (best-effort). Mutates lines.
 */
async function appendPreflight({ lines, dispatch, cwdRepo, prompt }) {
  if (!cwdRepo || !isPreflightWorthyPrompt(prompt)) {
    return;
  }

  try {
    const preflightResult = await dispatch('preflight', {
      repo: cwdRepo.name,
      task: prompt,
      'code-limit': String(CONTEXT.PREFLIGHT_CODE_LIMIT || 3),
      'memory-limit': String(CONTEXT.PREFLIGHT_MEMORY_LIMIT || 2),
      'doc-limit': String(CONTEXT.PREFLIGHT_DOC_LIMIT || 1),
    }),
    target = (() => {

      if (preflightResult && !preflightResult.error) {
        appendPreflightBlock(lines, preflightResult);
      }
  
      
  return (chooseCodingContextTarget(prompt, preflightResult));
})();if (target) {
      const codingContextResult = await dispatch('coding-context', {
        repo: cwdRepo.name,
        ...target,
        depth: '2',
        top: '5',
      });
      if (codingContextResult && !codingContextResult.error) {
        appendCodingContextBlock(lines, unwrapAnalysisData(codingContextResult));
      }
    }
  } catch {
    // Preflight/coding-context is best-effort; never block context injection.
  }
}

async function run({ payload, dispatch, getKnownRepos, getKnownProjects, stateStore, isCancelled }) {
  const prompt = payload.prompt || '',
    { resolvedCwd, repos, project } = resolveProjectForCwd(payload.cwd, getKnownRepos, getKnownProjects),
    claudeSessionId = payload.session_id,
    state = stateStore.loadState(claudeSessionId),
    sessionId = state.sessionId,
    assembled = await assembleContextLines({
      dispatch,
      getKnownRepos,
      project,
      cwd: payload.cwd,
      query: prompt,
      sessionId,
    }).catch((err) => {
      // Log but do not throw — prompt must still go through with whatever
      // Non-memory context we can compute locally. Without logging, dispatch
      // Failures (engine unreachable, schema mismatch) are invisible to the
      // User and indistinguishable from "no relevant memories found".
      console.error(
        `[claude-code] assembleContextLines failed for session ${claudeSessionId || 'unknown'}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    });

  if (isCancelled?.()) {
    return null;
  }

  const lines = assembled ? assembled.lines : [],
    cwdRepo = assembled ? assembled.cwdRepo : findMatchingRepo(resolvedCwd, repos);

  // Preflight / coding context (best-effort, timeout-safe).
  await appendPreflight({ lines, dispatch, cwdRepo, prompt });

  if (isCancelled?.()) {
    return null;
  }

  // Cadence-gated reminder (parity of Pi's context-event reminder).
  // Routed through mutateState so parallel memory-tool hooks cannot be
  // Clobbered by an unlocked load/save (#228).
  let shouldRemind = false;
  const mutate = makeMutate(stateStore, claudeSessionId);
  await mutate((s) => {
    if (isCancelled?.()) {
      return;
    }
    s.callsSinceLastMemory += 1;
    const recentMemory = Date.now() - s.lastMemoryToolCall < REMINDER_RECENT_MS;
    if (s.callsSinceLastMemory >= REMINDER_INTERVAL && !recentMemory) {
      s.callsSinceLastMemory = 0;
      shouldRemind = true;
    }
    s.hasInjectedContext = true;
  });

  if (isCancelled?.()) {
    return null;
  }

  if (shouldRemind) {
    lines.push('');
    lines.push(REMINDER_TEXT);
  }

  const additionalContext = capInjectedContext(lines.join('\n'));
  if (!additionalContext) {
    return null;
  }

  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  };
}

async function handleUserPromptSubmit(ctx) {
  // Race against the 30s budget; on timeout return whatever was produced so
  // The prompt is never blocked. The timer is cleared when run() settles so the
  // Hook process exits immediately on the fast path — otherwise the dangling
  // Timer keeps Node's event loop (and thus Claude Code) alive for the full budget.
  // A cancelled flag prevents run() from persisting state after the budget fires.
  let timer,
    cancelled = false;
  try {
    return await Promise.race([
      run({ ...ctx, isCancelled: () => cancelled }).catch(() => null),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          cancelled = true;
          resolve(null);
        }, BUDGET_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { handleUserPromptSubmit, REMINDER_INTERVAL, REMINDER_RECENT_MS, BUDGET_MS };
