import { MEMORY_REMINDER_INTERVAL, MemResult, state } from '../state';
import { getKnownRepos, isRepoStale } from '../host/project-detector';
import { CONTEXT } from '../../../constants';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import path from 'node:path';
import { mem } from '../host/memory-client';

// Engine delegation (pure transport-agnostic core).
import {
  appendExtensionHint,
  buildContextBlock,
  buildSourceLookupGuidance,
  capInjectedContext,
} from '../../../src/hooks-engine/context-builder.js';
import {
  appendCodingContextBlock,
  appendPreflightBlock,
  chooseCodingContextTarget,
  unwrapAnalysisData,
} from '../../../src/hooks-engine/preflight-assembly.js';
import {
  extractUserPrompt,
  isHistoricalMemoryPrompt,
  isPreflightWorthyPrompt,
  isSourceAuthoritativePrompt,
} from '../../../src/hooks-engine/prompt-classifiers.js';
import { resolveIndexedRepo } from '../../../src/hooks-engine/project.js';

// Re-exported for existing tests that import from this file.
export { extractFilePaths } from '../../../src/hooks-engine/context-builder.js';
export {
  extractUserPrompt,
  isSourceAuthoritativePrompt,
  isHistoricalMemoryPrompt,
  isNavigationPrompt,
  isPreflightWorthyPrompt,
} from '../../../src/hooks-engine/prompt-classifiers.js';
// AppendPreflightBlock/appendCodingContextBlock/chooseCodingContextTarget/
// UnwrapAnalysisData are used internally only; not re-exported today.

interface ContextDeps {
  state: typeof state;
  mem: typeof mem;
  getKnownRepos: typeof getKnownRepos;
  isRepoStale: typeof isRepoStale;
  getSettings?: () => { contextLimit?: number };
}

export function registerBeforeAgentStart(pi: ExtensionAPI, deps: ContextDeps) {
  pi.on('before_agent_start', async (event, ctx) => {
    if (!deps.state.currentProject) {
      return;
    }

    const promptQuery = extractUserPrompt(event);
    if (isSourceAuthoritativePrompt(promptQuery)) {
      const repos = await deps.getKnownRepos(),
        guidance = buildSourceLookupGuidance(repos, ctx.cwd, deps.state.currentProject);
      if (guidance) {
        return {
          message: {
            customType: 'memory-code-guidance',
            content: guidance,
            display: false,
          },
        };
      }
      return;
    }

    const defaultContextLimit = promptQuery ? CONTEXT.PROMPT_RELEVANT_LIMIT : CONTEXT.PROJECT_SUMMARY_LIMIT,
      configuredContextLimit = Number(deps.getSettings?.()?.contextLimit),
      contextLimit =
        Number.isFinite(configuredContextLimit) && configuredContextLimit > 0
          ? Math.floor(configuredContextLimit)
          : defaultContextLimit,
      contextResult = await deps.mem('context', {
        project: deps.state.currentProject,
        limit: String(contextLimit),
        'token-budget': String(CONTEXT.TOKEN_BUDGET_DEFAULT || 2000),
        ...(promptQuery ? { query: promptQuery } : {}),
        ...(deps.state.sessionId ? { 'session-id': String(deps.state.sessionId) } : {}),
      });

    let crossProjectResult: MemResult | null = null;
    const projectContext = contextResult;
    if (!projectContext) {
      crossProjectResult = await deps.mem('context', {
        'all-projects': 'true',
        limit: String(CONTEXT.PROJECT_SUMMARY_LIMIT),
        'token-budget': String(CONTEXT.TOKEN_BUDGET_DEFAULT || 2000),
        ...(deps.state.sessionId ? { 'session-id': String(deps.state.sessionId) } : {}),
      });
    }

    if (!projectContext && !crossProjectResult) {
      return {
        message: {
          customType: 'memory-context',
          content: '⚠️ Memory context failed to load. Use `memory-search` and `memory-save` manually.',
          display: true,
        },
      };
    }

    const effectiveContext = projectContext || crossProjectResult,
      observations =
        (effectiveContext.observations as Array<{
          id: number;
          title: string;
          type: string;
          scope: string;
          topic_key: string;
          trust_score: number;
          type_priority: number;
          content?: string;
        }>) || [],
      personal =
        (effectiveContext.personal as Array<{
          id: number;
          title: string;
          type: string;
        }>) || [],
      stats = effectiveContext.stats as { total_memories: number; total_personal: number },
      // Resolve repo staleness (anchored, deepest path match — mirrors detectProject)
      repos = await deps.getKnownRepos(),
      resolvedCwd = path.resolve(ctx.cwd),
      cwdRepo = resolveIndexedRepo(resolvedCwd, repos, deps.state.currentProject),
      isStale = cwdRepo ? deps.isRepoStale(cwdRepo) : false;

    // Self-heal stale session-start project key when path-resolved repo name differs.
    // Context for this turn was fetched with the stale key; counts catch up next turn.
    if (cwdRepo && cwdRepo.name.toLowerCase() !== (deps.state.currentProject || '').toLowerCase()) {
      deps.state.currentProject = cwdRepo.name;
    }

    const isNewProject = crossProjectResult !== null && !projectContext;
    let effectiveObservations: any[] = [];
    if (promptQuery) {
      effectiveObservations = isNewProject ? (crossProjectResult!.observations as any[]) || [] : observations;
    }
    const effectiveStats = isNewProject ? (crossProjectResult!.stats as any) : stats;

    deps.state.hasInjectedContext = true;

    const topic = effectiveContext.topic as string | null,
      projectDir = cwdRepo?.path || ctx.cwd,
      lines = buildContextBlock({
        promptQuery,
        currentProject: deps.state.currentProject,
        projectDir,
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
        `⚠️ **Code not indexed:** Project "${deps.state.currentProject}" has no code index yet. Index it first: \`memory-code index-repo --path ${ctx.cwd} --name ${deps.state.currentProject}\``,
      );
    } else if (isStale && !isHistoricalMemoryPrompt(promptQuery) && effectiveObservations.length === 0) {
      lines.push('');
      lines.push(CONTEXT.STALE_GUIDANCE.replace('{repo}', cwdRepo.name));
    }

    // Auto-inject preflight intelligence for coding tasks when an indexed repo exists
    if (cwdRepo && isPreflightWorthyPrompt(promptQuery)) {
      let preflightResult: any = null;
      try {
        preflightResult = await deps.mem('preflight', {
          repo: cwdRepo.name,
          task: promptQuery,
          'code-limit': String(CONTEXT.PREFLIGHT_CODE_LIMIT || 3),
          'memory-limit': String(CONTEXT.PREFLIGHT_MEMORY_LIMIT || 2),
          'doc-limit': String(CONTEXT.PREFLIGHT_DOC_LIMIT || 1),
        });
        if (preflightResult && !preflightResult.error) {
          appendPreflightBlock(lines, preflightResult);
        }
      } catch {
        // Preflight is best-effort; never block context injection on failure
      }

      try {
        const target = chooseCodingContextTarget(promptQuery, preflightResult);
        if (target) {
          const codingContextResult = await deps.mem('coding-context', {
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
        // Coding context is best-effort; never block context injection on failure
      }
    }

    appendExtensionHint(lines, ctx.cwd);

    return {
      message: {
        customType: 'memory-context',
        content: capInjectedContext(lines.join('\n')),
        display: false,
      },
    };
  });
}

export function registerContextReminder(pi: ExtensionAPI, deps: ContextDeps) {
  pi.on('context', async (event, _ctx) => {
    if (deps.state.hasInjectedContext) {
      deps.state.hasInjectedContext = false;
      return;
    }

    deps.state.callsSinceLastMemory++;

    if (deps.state.callsSinceLastMemory < MEMORY_REMINDER_INTERVAL) {
      return;
    }

    if (Date.now() - deps.state.lastMemoryToolCall < 180000) {
      return;
    }

    // Reset counter after firing
    deps.state.callsSinceLastMemory = 0;

    return {
      messages: [
        ...event.messages,
        {
          role: 'user' as const,
          content:
            '💡 Memory reminder: Use `memory-search` before decisions to avoid repeating past mistakes. Use `memory-save` for decisions, bugfixes, and discoveries.',
        },
      ],
    };
  });
}
