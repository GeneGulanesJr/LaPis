// oxlint-disable sort-imports
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { MemResult, state } from '../state';
import { mem, memCmd } from '../host/memory-client';
import { ensureNativeModules } from '../host/native-health';
import { detectProject } from '../host/project-detector';

// Engine delegation (pure transport-agnostic core).
import { buildSessionSummary } from '../../../src/hooks-engine/session-summary.js';

interface SessionDeps {
  state: typeof state;
  ensureNativeModules: typeof ensureNativeModules;
  mem: typeof mem;
  memCmd: typeof memCmd;
  detectProject: typeof detectProject;
}

export function registerSessionStart(pi: ExtensionAPI, deps: SessionDeps) {
  pi.on('session_start', async (event, ctx) => {
    await deps.ensureNativeModules();
    deps.state.currentProject = await deps.detectProject(ctx.cwd);
    deps.state.turnCount = 0;
    deps.state.lastMemoryToolCall = 0;
    deps.state.lastAutoDecisionSave = 0;
    deps.state.dreamTriggeredThisSession = false;
    deps.state.hasInjectedContext = false;
    deps.state.projectSessionCount = 0;
    deps.state.editedFiles = new Set();
    deps.state.exploredFiles = new Set();
    deps.state.cachedRepos = null;
    deps.state.repoCacheTime = 0;

    const result = await deps.mem('session-start', { project: deps.state.currentProject });
    if (!result) {
      ctx.ui.notify('Memory: failed to start session', 'error');
      return;
    }

    deps.state.sessionId = result.sessionId as number;

    if (result.recoveredSession) {
      ctx.ui.notify(`Memory: recovered orphaned session for ${deps.state.currentProject}`, 'info');
    }

    ctx.ui.setStatus('memory', `🧠 session ${deps.state.sessionId}`);

    deps.state.projectSessionCount = (result as any).sessionCount || 0;
  });
}

export function registerSessionCompact(pi: ExtensionAPI, deps: SessionDeps) {
  pi.on('session_compact', async (_event, _ctx) => {
    if (!deps.state.currentProject) {
      return;
    }

    const contextResult = await deps.mem('context', {
        project: deps.state.currentProject,
        limit: '15',
        ...(deps.state.sessionId ? { 'session-id': String(deps.state.sessionId) } : {}),
      }),
      contextObservations = (contextResult?.observations as any[]) || [],
      hasProjectContext = Boolean(contextResult) && contextObservations.length > 0;

    let crossProjectResult: MemResult | null = null;
    if (!hasProjectContext) {
      crossProjectResult = await deps.mem('context', {
        'all-projects': 'true',
        limit: '10',
        ...(deps.state.sessionId ? { 'session-id': String(deps.state.sessionId) } : {}),
      });
    }

    if (!contextResult && !crossProjectResult) {
      return {
        message: {
          customType: 'memory-context',
          content:
            '⚠️ **Memory context failed to re-load after compaction.** Memory state may be stale.\n' +
            'Use `memory-search` and `memory-save` manually if needed.',
          display: true,
        },
      };
    }

    {
      const effectiveContext = contextResult || crossProjectResult,
        isNewProject = !hasProjectContext && crossProjectResult !== null,
        effectiveObservations = isNewProject ? (crossProjectResult!.observations as any[]) || [] : contextObservations,
        stats = effectiveContext.stats as any,
        personal = (effectiveContext.personal as any[]) || [],
        lines: string[] = ['## Memory Context (re-injected after compaction)', ''];

      if (isNewProject) {
        lines.push(`Project: **${deps.state.currentProject}** | 🆕 new project`);
        if (effectiveObservations.length > 0) {
          lines.push('');
          lines.push('### 🔗 Related memories from other projects');
          for (const o of effectiveObservations.slice(0, 5)) {
            lines.push(`- [${o.type}] ${o.title}`);
          }
        }
      } else {
        lines.push(`Project: **${deps.state.currentProject}** | ${stats?.total_memories || 0} memories`);
        if (effectiveObservations.length > 0) {
          lines.push('');
          lines.push('### Recent Relevant Memory');
          for (const o of effectiveObservations) {
            let trust = '';
            if (o.trust_score < 0.5) {
              trust = '⚠️';
            } else if (o.trust_score < 0.8) {
              trust = '🔎';
            }
            lines.push(`- [${o.type}] ${o.title} ${trust}`);
          }
        }
      }

      if (personal.length > 0) {
        lines.push('');
        lines.push('### Your Preferences (cross-project)');
        for (const p of personal.slice(0, 3)) {
          lines.push(`- ${p.title}`);
        }
      }

      lines.push('');
      lines.push('Use `memory-save`, `memory-search`, and `memory-get` tools to interact with memory.');

      return {
        message: {
          customType: 'memory-context',
          content: lines.join('\n'),
          display: false,
        },
      };
    }
  });
}

export function registerSessionShutdown(pi: ExtensionAPI, deps: SessionDeps) {
  pi.on('session_shutdown', async (event, ctx) => {
    if (!deps.state.sessionId || !deps.state.currentProject) {
      return;
    }

    // `quit` = Ctrl+C / Ctrl+D / SIGHUP / SIGTERM. Pi awaits session_shutdown
    // Handlers before exiting, so awaiting DB bookkeeping here blocks the exit
    // For seconds on large DBs (VACUUM, FTS optimize). On quit we run the work
    // Fire-and-forget so the process can exit immediately.
    // `reload` / `new` / `resume` / `fork` keep the awaited path so the summary
    // And trust sync land before the next session starts.
    const reason = (event as any)?.reason as string | undefined,
      isQuit = reason === 'quit' || !reason,
      entries = ctx.sessionManager.getEntries(),
      userMessages = entries.filter((e: any) => e.type === 'message' && e.message?.role === 'user'),
      assistantMessages = entries.filter((e: any) => e.type === 'message' && e.message?.role === 'assistant'),
      summaryContent = buildSessionSummary({
        userMessages,
        assistantCount: assistantMessages.length,
        turnCount: deps.state.turnCount,
        memoriesSaved: deps.state.memoriesSavedThisSession,
        editedFiles: deps.state.editedFiles,
        cwd: process.cwd(),
      }),
      runShutdownWork = async () => {
        try {
          await deps.mem('session-summary', {
            content: summaryContent,
            project: deps.state.currentProject,
          });
          await deps.mem('session-end', {
            id: String(deps.state.sessionId),
            memories: String(deps.state.memoriesSavedThisSession),
            auto: 'true',
          });
        } catch (e) {
          // Best-effort on shutdown; never throw out of the handler.
          console.error('[memory-layer] shutdown work failed:', e instanceof Error ? e.message : String(e));
        }
      };

    if (isQuit) {
      await Promise.race([runShutdownWork(), new Promise((resolve) => setTimeout(resolve, 2000))]);
    } else {
      // Reload / new / resume / fork: the next session needs this data in place.
      await runShutdownWork();
    }

    if (ctx.hasUI && !isQuit) {
      ctx.ui.notify(
        `Memory: session saved (${deps.state.memoriesSavedThisSession} memories, ${deps.state.turnCount} turns)`,
        'info',
      );
    }
  });
}
