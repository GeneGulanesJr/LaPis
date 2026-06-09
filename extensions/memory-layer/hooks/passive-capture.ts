import { AUTO_DECISION_COOLDOWN, CHECKPOINT_INTERVAL, state } from '../state';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { mem, memCmd } from '../host/memory-client';
import { shouldAutoCapture } from './pattern-matcher';
import path from 'node:path';

interface PassiveCaptureDeps {
  state: typeof state;
  mem: typeof mem;
  memCmd: typeof memCmd;
}


function extractMessageText(msg: any): string {
  if (!msg) {
    return '';
  }
  if (typeof msg.content === 'string') {
    return msg.content;
  }
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text || '')
      .join(' ');
  }
  return '';
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

    if (Date.now() - deps.state.lastAutoDecisionSave < AUTO_DECISION_COOLDOWN) {
      return;
    }

    if (text.includes('memory-save') || text.includes('memory-search') || text.includes('memory-get')) {
      return;
    }

    const capture = shouldAutoCapture(text);
    if (capture.match && capture.confidence !== 'low' && capture.pattern) {
      deps.state.lastAutoDecisionSave = Date.now();

      const lastLine = text.split('\n').filter((l) => l.trim()).pop()?.slice(0, 120) || text.slice(0, 120);
      const title = `${capture.pattern.label}: ${lastLine.slice(0, 80)}`;

      await deps.mem('save', {
        title,
        type: capture.pattern.type,
        project: deps.state.currentProject || 'unknown',
        scope: 'project',
        content: [
          `**What**: Auto-detected ${capture.pattern.label.toLowerCase()} (confidence: ${capture.confidence})`,
          `**Where**: Session ${deps.state.sessionId || 'unknown'}`,
          `**Learned**: ${text.slice(0, 300)}`,
        ].join('\n'),
      });
    }
  });

  pi.on('turn_end', async (_event, _ctx) => {
    deps.state.turnCount++;

    // Trigger Dream Cycle once per session at turn 50
    if (deps.state.turnCount === 50 && !deps.state.dreamTriggeredThisSession) {
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

    if (deps.state.turnCount % CHECKPOINT_INTERVAL !== 0 || deps.state.turnCount === 0) {
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
          auditNote = `\n\n**Post-edit audit**: ${auditResult.risk} risk, ${auditResult.violations.length} violation(s): ${auditResult.violations.slice(0, 3).map((v: any) => v.message).join('; ')}`;
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
