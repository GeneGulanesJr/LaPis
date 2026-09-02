import { AUTO_DECISION_COOLDOWN, CHECKPOINT_INTERVAL, state } from '../state';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { mem, memCmd } from '../host/memory-client';
import { shouldAutoCapture } from './pattern-matcher';
import path from 'node:path';

// Engine delegation (pure transport-agnostic core).
import { extractMessageText } from '../../../src/hooks-engine/prompt-classifiers.js';
import {
  buildAutoDecisionPayload,
  isAutoDecisionCoolingDown,
  shouldCheckpoint,
  shouldDream,
} from '../../../src/hooks-engine/passive-capture.js';

interface PassiveCaptureDeps {
  state: typeof state;
  mem: typeof mem;
  memCmd: typeof memCmd;
}

export function registerPassiveCapture(pi: ExtensionAPI, deps: PassiveCaptureDeps) {
  pi.on('tool_result', async (event, _ctx) => {
    if (event.toolName === 'edit' || event.toolName === 'write') {
      const input = event.input as { path?: string };
      if (!input?.path || !deps.state.currentProject) {
        return;
      }

      if (input.path.includes('memory-store.js') || input.path.includes('memory-layer')) {
        return;
      }

      deps.state.editedFiles.add(input.path);
    }
  });

  pi.on('message_end', async (event, _ctx) => {
    if (event.message?.role !== 'assistant') {
      return;
    }
    const text = extractMessageText(event.message);
    if (!text || text.length < 50) {
      return;
    }

    if (text.length < 100) {
      return;
    }

    if (isAutoDecisionCoolingDown(deps.state.lastAutoDecisionSave, Date.now(), AUTO_DECISION_COOLDOWN)) {
      return;
    }

    if (text.includes('memory-save') || text.includes('memory-search') || text.includes('memory-get')) {
      return;
    }

    {
const capture = shouldAutoCapture(text),
      payload = buildAutoDecisionPayload({
        text,
        capture,
        project: deps.state.currentProject,
        sessionId: deps.state.sessionId,
      });
    if (payload) {
      deps.state.lastAutoDecisionSave = Date.now();
      await deps.mem('save', payload);
    }
  }
});

  pi.on('turn_end', async (_event, _ctx) => {
    deps.state.turnCount++;

    // Trigger Dream Cycle once per session at turn 50
    if (shouldDream(deps.state.turnCount, deps.state.dreamTriggeredThisSession)) {
      deps.state.dreamTriggeredThisSession = true;
      try {
        const dreamResult = await deps.memCmd('dream');
        if (dreamResult && (dreamResult as any).totalCleaned > 0) {
          console.log(
            `[memory-layer] 💤 Dream Cycle at turn 50: ${(dreamResult as any).totalCleaned} memories cleaned`,
          );
        }
      } catch (e) {
        console.error('[memory-layer] auto-dream at turn 50 failed:', e);
      }
    }

    if (deps.state.pendingRecallFeedback.size > 0) {
      const entries = [...deps.state.pendingRecallFeedback.entries()].map(([memoryId, meta]) => ({
        memoryId,
        sessionId: meta.sessionId,
        query: meta.query,
        wasUseful: false,
      }));
      await deps.mem('log-negative-recall', {
        entries: JSON.stringify(entries),
      });
      deps.state.pendingRecallFeedback.clear();
    }

    if (!shouldCheckpoint(deps.state.turnCount, CHECKPOINT_INTERVAL)) {
      return;
    }
    if (!deps.state.currentProject) {
      return;
    }

    const summaryFiles = [...deps.state.editedFiles]
      .slice(0, 10)
      .map((f) => `- ${path.basename(f)}`)
      .join('\n');

    // Run post-edit audit on edited files
    let auditNote = '';
    try {
      const editedPaths = [...deps.state.editedFiles].slice(0, 20);
      if (editedPaths.length > 0 && editedPaths.length <= 20) {
        const auditResult = await deps.mem('audit-diff', {
          repo: deps.state.currentProject || '',
          files: editedPaths.join(','),
          task: `checkpoint turn ${deps.state.turnCount}`,
        });
        if (auditResult && !auditResult.error && auditResult.violations && auditResult.violations.length > 0) {
          auditNote = `\n\n**Post-edit audit**: ${auditResult.risk} risk, ${auditResult.violations.length} violation(s): ${auditResult.violations
            .slice(0, 3)
            .map((v: any) => v.message)
            .join('; ')}`;
        }
      }
    } catch {
      // Audit-diff is optional — do not block passive capture
    }

    await deps.mem('save', {
      title: `Progress checkpoint (turn ${deps.state.turnCount})`,
      type: 'progress',
      project: deps.state.currentProject,
      scope: 'project',
      force: 'true',
      content: [
        `**What**: Auto-checkpoint at turn ${deps.state.turnCount}`,
        `**Where**: Session ${deps.state.sessionId}`,
        `**Learned**: ${deps.state.memoriesSavedThisSession} explicit memories saved, ${deps.state.editedFiles.size} files edited`,
        summaryFiles ? `Files touched:\n${summaryFiles}` : '',
        auditNote,
      ].join('\n'),
    });
  });
}
