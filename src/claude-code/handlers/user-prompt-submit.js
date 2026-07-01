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
const { resolveCwd, projectFromCwd, findMatchingRepo } = require('../../hooks-engine/project');
const { isPreflightWorthyPrompt } = require('../../hooks-engine/prompt-classifiers');
const {
  appendPreflightBlock,
  chooseCodingContextTarget,
  appendCodingContextBlock,
  unwrapAnalysisData,
} = require('../../hooks-engine/preflight-assembly');
const { capInjectedContext } = require('../../hooks-engine/context-builder');
const { assembleContextLines } = require('../context-inject');

const BUDGET_MS = 30000;
const REMINDER_INTERVAL = 5; // MEMORY_REMINDER_INTERVAL (state.ts:107)
const REMINDER_RECENT_MS = 180000; // 3min (context-injection.ts:235)
const REMINDER_TEXT =
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
    });
    if (preflightResult && !preflightResult.error) {
      appendPreflightBlock(lines, preflightResult);
    }

    const target = chooseCodingContextTarget(prompt, preflightResult);
    if (target) {
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

async function run({ payload, dispatch, getKnownRepos, stateStore }) {
  const prompt = payload.prompt || '';
  const cwd = resolveCwd(payload.cwd);
  const project = projectFromCwd(cwd);
  const claudeSessionId = payload.session_id;

  const state = stateStore.loadState(claudeSessionId);
  const sessionId = state.sessionId;

  const assembled = await assembleContextLines({
    dispatch,
    getKnownRepos,
    project,
    cwd,
    query: prompt,
    sessionId,
  }).catch(() => null);

  const lines = assembled ? assembled.lines : [];
  const cwdRepo = assembled ? assembled.cwdRepo : findMatchingRepo(path.resolve(cwd), getKnownRepos());

  // Preflight / coding context (best-effort, timeout-safe).
  await appendPreflight({ lines, dispatch, cwdRepo, prompt });

  // Cadence-gated reminder (parity of Pi's context-event reminder).
  state.callsSinceLastMemory += 1;
  const recentMemory = Date.now() - state.lastMemoryToolCall < REMINDER_RECENT_MS;
  if (state.callsSinceLastMemory >= REMINDER_INTERVAL && !recentMemory) {
    state.callsSinceLastMemory = 0;
    lines.push('');
    lines.push(REMINDER_TEXT);
  }

  state.hasInjectedContext = true;
  stateStore.saveState(claudeSessionId, state);

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
  // the prompt is never blocked. The timer is cleared when run() settles so the
  // hook process exits immediately on the fast path — otherwise the dangling
  // timer keeps Node's event loop (and thus Claude Code) alive for the full budget.
  let timer;
  try {
    return await Promise.race([
      run(ctx).catch(() => null),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), BUDGET_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { handleUserPromptSubmit, REMINDER_INTERVAL, REMINDER_RECENT_MS, BUDGET_MS };
