'use strict';

/**
 * Claude Code bridge: shared context-injection routine.
 *
 * Renders the memory-context block, mirroring the pure core of
 * extensions/memory-layer/hooks/context-injection.ts:48-219 but adapted to the
 * Claude Code transport (injected dispatch + getKnownRepos, no Pi ExtensionAPI).
 *
 * Used by session-start (no prompt) and user-prompt-submit (prompt-qualified).
 * assembleContextLines returns the UNCAPPED lines array + the resolved cwdRepo
 * so user-prompt-submit can append preflight/coding-context before capping;
 * buildInjectedContext is the capped convenience wrapper for session-start.
 */

const path = require('node:path'),
  { CONTEXT } = require('../../constants'),
  { buildContextBlock, capInjectedContext, appendExtensionHint } = require('../hooks-engine/context-builder'),
  { findMatchingRepo, resolveCwd } = require('../hooks-engine/project');

/**
 * Fetch project context, falling back to cross-project if empty.
 * Returns { contextResult, crossProjectResult } (each may be null on failure).
 */
async function fetchContext({ dispatch, project, limit, query, sessionId, extraArgs }) {
  const baseArgs = {
      ...extraArgs,
      project,
      limit: String(limit),
      'token-budget': String(CONTEXT.TOKEN_BUDGET_DEFAULT || 2000),
      ...(sessionId ? { 'session-id': String(sessionId) } : {}),
      ...(query ? { query } : {}),
    },
    contextResult = await dispatch('context', baseArgs);
  if (contextResult && !contextResult.error) {
    return { contextResult, crossProjectResult: null };
  }

  const crossProjectResult = await dispatch('context', {
    'all-projects': 'true',
    limit: String(CONTEXT.PROJECT_SUMMARY_LIMIT),
    'token-budget': String(CONTEXT.TOKEN_BUDGET_DEFAULT || 2000),
    ...(sessionId ? { 'session-id': String(sessionId) } : {}),
  });
  return { contextResult: null, crossProjectResult };
}

/**
 * Fetch + resolve the data bag buildContextBlock renders, without rendering.
 * Returns null when both context fetches failed. `contextArgs` are extra
 * dispatch args for the project-scoped fetch (e.g. 'decision-select').
 * @returns {Promise<object|null>}
 */
async function collectContext({ dispatch, getKnownRepos, project, cwd, query = null, sessionId = null, contextArgs }) {
  const limit = query ? CONTEXT.PROMPT_RELEVANT_LIMIT : CONTEXT.PROJECT_SUMMARY_LIMIT,
    { contextResult, crossProjectResult } = await fetchContext({
      dispatch,
      project,
      limit,
      query,
      sessionId,
      extraArgs: contextArgs,
    });

  if (!contextResult && !crossProjectResult) {
    return null;
  }

  const effectiveContext = contextResult || crossProjectResult,
    isNewProject = crossProjectResult !== null && !contextResult,
    observations = (effectiveContext.observations || []).filter(Boolean),
    personal = (effectiveContext.personal || []).filter(Boolean),
    stats = effectiveContext.stats || {},
    topic = effectiveContext.topic || null,
    repos = getKnownRepos(),
    resolvedCwd = path.resolve(resolveCwd(cwd)),
    cwdRepo = findMatchingRepo(resolvedCwd, repos);

  let effectiveObservations = [];
  if (query) {
    effectiveObservations = isNewProject ? crossProjectResult.observations || [] : observations;
  }
  return {
    promptQuery: query,
    currentProject: project,
    projectDir: cwdRepo?.path || resolvedCwd,
    resolvedCwd,
    cwdRepo,
    isStale: false,
    isNewProject,
    observations,
    effectiveObservations,
    personal,
    stats,
    effectiveStats: isNewProject ? crossProjectResult.stats || {} : stats,
    topic,
    crossProjectSuggestions: effectiveContext.cross_project_suggestions || [],
  };
}

/** Render a collectContext() bag into the UNCAPPED lines array. */
function renderContextLines(bag) {
  const lines = buildContextBlock(bag);

  if (!bag.cwdRepo) {
    lines.push('');
    lines.push(
      `⚠️ **Code not indexed:** Project "${bag.currentProject}" has no code index yet. Index it first: \`memory-code index-repo --path ${bag.resolvedCwd} --name ${bag.currentProject}\``,
    );
  }

  appendExtensionHint(lines, bag.resolvedCwd);
  return lines;
}

/**
 * Assemble the memory-context lines (UNCAPPED) + the matched cwd repo.
 * @returns {Promise<{lines: string[], cwdRepo: object|null} | null>}
 */
async function assembleContextLines(opts) {
  const bag = await collectContext(opts);
  if (!bag) {
    return null;
  }
  return { lines: renderContextLines(bag), cwdRepo: bag.cwdRepo };
}

/** Capped convenience wrapper returning the final markdown string (or null). */
async function buildInjectedContext(opts) {
  const assembled = await assembleContextLines(opts).catch((err) => {
    // Log instead of silently swallowing — a null return value is
    // Indistinguishable from "no relevant memories" without a log line.
    console.error(`[claude-code] assembleContextLines failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  });
  if (!assembled) {
    return null;
  }
  return capInjectedContext(assembled.lines.join('\n'));
}

module.exports = { assembleContextLines, buildInjectedContext, fetchContext, collectContext, renderContextLines };
