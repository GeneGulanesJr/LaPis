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

const path = require('node:path');
const { CONTEXT } = require('../../constants');
const { buildContextBlock, capInjectedContext, appendExtensionHint } = require('../hooks-engine/context-builder');
const { findMatchingRepo } = require('../hooks-engine/project');

/**
 * Fetch project context, falling back to cross-project if empty.
 * Returns { contextResult, crossProjectResult } (each may be null on failure).
 */
async function fetchContext({ dispatch, project, limit, query, sessionId }) {
  const baseArgs = {
    project,
    limit: String(limit),
    'token-budget': String(CONTEXT.TOKEN_BUDGET_DEFAULT || 2000),
    ...(sessionId ? { 'session-id': String(sessionId) } : {}),
    ...(query ? { query } : {}),
  };

  const contextResult = await dispatch('context', baseArgs);
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
 * Assemble the memory-context lines (UNCAPPED) + the matched cwd repo.
 * @returns {Promise<{lines: string[], cwdRepo: object|null} | null>}
 */
async function assembleContextLines({ dispatch, getKnownRepos, project, cwd, query = null, sessionId = null }) {
  const limit = query ? CONTEXT.PROMPT_RELEVANT_LIMIT : CONTEXT.PROJECT_SUMMARY_LIMIT;
  const { contextResult, crossProjectResult } = await fetchContext({
    dispatch,
    project,
    limit,
    query,
    sessionId,
  });

  if (!contextResult && !crossProjectResult) {
    return null;
  }

  const effectiveContext = contextResult || crossProjectResult;
  const isNewProject = crossProjectResult !== null && !contextResult;

  const observations = (effectiveContext.observations || []).filter(Boolean);
  const personal = (effectiveContext.personal || []).filter(Boolean);
  const stats = effectiveContext.stats || {};
  const topic = effectiveContext.topic || null;

  // Staleness check is deferred to Phase 2's best-effort posture.
  const repos = getKnownRepos();
  const resolvedCwd = path.resolve(cwd);
  const cwdRepo = findMatchingRepo(resolvedCwd, repos);
  const isStale = false;

  let effectiveObservations = [];
  if (query) {
    effectiveObservations = isNewProject ? crossProjectResult.observations || [] : observations;
  }
  const effectiveStats = isNewProject ? crossProjectResult.stats || {} : stats;

  const lines = buildContextBlock({
    promptQuery: query,
    currentProject: project,
    projectDir: cwdRepo?.path || cwd,
    cwdRepo,
    isStale,
    isNewProject,
    observations,
    effectiveObservations,
    personal,
    stats,
    effectiveStats,
    topic,
    crossProjectSuggestions: effectiveContext.cross_project_suggestions || [],
  });

  if (!cwdRepo) {
    lines.push('');
    lines.push(
      `⚠️ **Code not indexed:** Project "${project}" has no code index yet. Index it first: \`memory-code index-repo --path ${cwd} --name ${project}\``,
    );
  }

  appendExtensionHint(lines, cwd);
  return { lines, cwdRepo };
}

/** Capped convenience wrapper returning the final markdown string (or null). */
async function buildInjectedContext(opts) {
  const assembled = await assembleContextLines(opts).catch(() => null);
  if (!assembled) {
    return null;
  }
  return capInjectedContext(assembled.lines.join('\n'));
}

module.exports = { assembleContextLines, buildInjectedContext, fetchContext };
