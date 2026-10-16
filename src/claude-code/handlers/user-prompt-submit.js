'use strict';

/**
 * Claude Code UserPromptSubmit handler.
 *
 * Builds prompt-matched context + (when preflight-worthy) preflight/coding
 * context (best-effort, timeout-safe), then appends the cadence-gated memory
 * reminder (parity with Pi's context-event reminder, moved here per #207).
 * Passes the stored numeric sessionId as `session-id` to context.
 *
 * When the judgment layer is on for surface 'context' (provider 'decision' +
 * LIQUID_API_KEY), the candidates of the three sections are filtered for
 * relevance to the prompt before rendering (src/claude-code/prompt-filter.js);
 * any failure renders exactly the unfiltered output.
 *
 * 30s overall budget: the whole dispatch sequence is raced against a timeout
 * that resolves with whatever context was gathered so far rather than
 * rejecting — best-effort, never blocks the prompt.
 */

const { CONTEXT } = require('../../../constants'),
  { findMatchingRepo } = require('../../hooks-engine/project'),
  { resolveProjectForCwd } = require('../project-resolve'),
  { isPreflightWorthyPrompt } = require('../../hooks-engine/prompt-classifiers'),
  {
    appendPreflightBlock,
    chooseCodingContextTarget,
    appendCodingContextBlock,
    unwrapAnalysisData,
  } = require('../../hooks-engine/preflight-assembly'),
  { capInjectedContext } = require('../../hooks-engine/context-builder'),
  { collectContext, renderContextLines } = require('../context-inject'),
  { contextDecisionEnabled } = require('../../memory-domain/context-decision'),
  { makeMutate } = require('../state-mutate'),
  BUDGET_MS = 30000,
  REMINDER_INTERVAL = 5, // MEMORY_REMINDER_INTERVAL (state.ts:107)
  REMINDER_RECENT_MS = 180000, // 3min (context-injection.ts:235)
  REMINDER_TEXT =
    '💡 Memory reminder: Use `memory-search` before decisions to avoid repeating past mistakes. Use `memory-save` for decisions, bugfixes, and discoveries.';

/** Preflight dispatch for a preflight-worthy prompt (best-effort; null when skipped/failed). */
async function fetchPreflight({ dispatch, cwdRepo, prompt }) {
  if (!cwdRepo || !isPreflightWorthyPrompt(prompt)) {
    return { ran: false, result: null };
  }
  try {
    const result = await dispatch('preflight', {
      repo: cwdRepo.name,
      task: prompt,
      'code-limit': String(CONTEXT.PREFLIGHT_CODE_LIMIT || 3),
      'memory-limit': String(CONTEXT.PREFLIGHT_MEMORY_LIMIT || 2),
      'doc-limit': String(CONTEXT.PREFLIGHT_DOC_LIMIT || 1),
    });
    return { ran: true, result };
  } catch {
    // Preflight is best-effort; never block context injection.
    return { ran: false, result: null };
  }
}

/**
 * Append preflight + coding-context blocks (best-effort). Mutates lines.
 * `mapCodingContext` post-processes the coding-context result (the prompt
 * filter drops paths that are not on disk).
 */
async function appendPreflight({ lines, dispatch, cwdRepo, prompt, preflight, mapCodingContext }) {
  if (!preflight.ran) {
    return;
  }

  try {
    const preflightResult = preflight.result,
      target = (() => {
        if (preflightResult && !preflightResult.error) {
          appendPreflightBlock(lines, preflightResult);
        }

        return chooseCodingContextTarget(prompt, preflightResult);
      })();
    if (target) {
      const codingContextResult = await dispatch('coding-context', {
        repo: cwdRepo.name,
        ...target,
        depth: '2',
        top: '5',
      });
      if (codingContextResult && !codingContextResult.error) {
        const data = unwrapAnalysisData(codingContextResult);
        appendCodingContextBlock(lines, mapCodingContext ? mapCodingContext(data) : data);
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
    // Off path = today's path: no extra dispatch arg, no filter module loaded.
    filterOn = Boolean(prompt) && contextDecisionEnabled(),
    collected = await collectContext({
      dispatch,
      getKnownRepos,
      project,
      cwd: payload.cwd,
      query: prompt,
      sessionId,
      // The prompt filter judges every section in one request; skip the
      // Gateway's own per-memory selection so a prompt makes one call.
      contextArgs: filterOn ? { 'decision-select': 'off' } : undefined,
    }).catch((err) => {
      // Log but do not throw — prompt must still go through with whatever
      // Non-memory context we can compute locally. Without logging, dispatch
      // Failures (engine unreachable, schema mismatch) are invisible to the
      // User and indistinguishable from "no relevant memories found".
      console.error(
        `[claude-code] collectContext failed for session ${claudeSessionId || 'unknown'}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    });

  if (isCancelled?.()) {
    return null;
  }

  {
    const cwdRepo = collected ? collected.cwdRepo : findMatchingRepo(resolvedCwd, repos),
      preflight = await fetchPreflight({ dispatch, cwdRepo, prompt });

    if (isCancelled?.()) {
      return null;
    }

    let bag = collected,
      mapCodingContext;
    if (filterOn) {
      const { filterPromptContext, prefilterCodingContext } = require('../prompt-filter'),
        baseDirs = [cwdRepo?.path, resolvedCwd],
        filtered = await filterPromptContext({ prompt, bag, preflight: preflight.result, baseDirs });
      if (filtered) {
        bag = filtered.bag;
        preflight.result = filtered.preflight;
        mapCodingContext = (data) => prefilterCodingContext(data, baseDirs);
      }
    }

    const lines = bag ? renderContextLines(bag) : [];

    // Preflight / coding context (best-effort, timeout-safe).
    await appendPreflight({ lines, dispatch, cwdRepo, prompt, preflight, mapCodingContext });

    if (isCancelled?.()) {
      return null;
    }

    // Cadence-gated reminder (parity of Pi's context-event reminder).
    // Routed through mutateState so parallel memory-tool hooks cannot be
    // Clobbered by an unlocked load/save (#228).
    let shouldRemind = false;
    {
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

      {
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
    }
  }
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
