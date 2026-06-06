/**
 * Memory Layer Extension — Thin Composition Root
 *
 * Registers hooks, tools, and commands via separated adapter modules.
 * Each adapter is independently testable. A failure in one adapter
 * (e.g., doc tooling) does not prevent unrelated tools from registering.
 */

// oxlint-disable sort-imports
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { isCodeFile, state, trustIcon } from './state';
import { registerBeforeAgentStart, registerContextReminder } from './hooks/context-injection';
import { registerSessionCompact, registerSessionShutdown, registerSessionStart } from './hooks/session-lifecycle';
import { mem, memCmd, memStreaming } from './host/memory-client';
import { detectProject, getKnownRepos, invalidateRepoCache, isRepoStale } from './host/project-detector';
import { registerPassiveCapture } from './hooks/passive-capture';
import { registerToolGuardrails } from './hooks/tool-guardrails';
import { registerOutputCompression } from './hooks/output-compression';
import { getConfig } from '../../config';
import { registerTrustSync } from './hooks/trust-sync';
import { ensureNativeModules } from './host/native-health';
import { registerCodeTools } from './tools/code-tools';
import { registerDocTools } from './tools/doc-tools';
import { registerDashboardCommand } from './commands/dashboard';
import { formatCodeResult } from './tools/format-code-result';
import { formatDocResult } from './tools/format-doc-result';
import { registerMemoryTools } from './tools/memory-tools';

type RegFn = (pi: ExtensionAPI, deps: any) => void;

const registrationFailures: string[] = [];

function safeRegister(pi: ExtensionAPI, deps: any, name: string, fn: RegFn) {
  try {
    fn(pi, deps);
  } catch (e) {
    console.error(`[memory-layer] Failed to register ${name}:`, e instanceof Error ? e.message : String(e));
    registrationFailures.push(name);
  }
}

export default function memoryLayer(pi: ExtensionAPI) {
  const deps = {
    state,
    ensureNativeModules,
    mem,
    memCmd,
    memStreaming,
    detectProject,
    getKnownRepos,
    invalidateRepoCache,
    isRepoStale,
    isCodeFile,
    trustIcon,
    formatCodeResult,
    formatDocResult,
  };

  safeRegister(pi, deps, 'session-lifecycle hooks', registerSessionStart);
  safeRegister(pi, deps, 'session-compact hook', registerSessionCompact);
  safeRegister(pi, deps, 'before-agent-start hook', registerBeforeAgentStart);
  safeRegister(pi, deps, 'context-reminder hook', registerContextReminder);
  safeRegister(pi, deps, 'tool-guardrails hook', registerToolGuardrails);
  safeRegister(pi, deps, 'output-compression hook', (pi, deps) => {
    registerOutputCompression(pi, { state: deps.state, getConfig });
  });
  safeRegister(pi, deps, 'trust-sync hook', registerTrustSync);
  safeRegister(pi, deps, 'passive-capture hooks', registerPassiveCapture);
  safeRegister(pi, deps, 'session-shutdown hook', registerSessionShutdown);
  safeRegister(pi, deps, 'memory tools', registerMemoryTools);
  safeRegister(pi, deps, 'code tools', registerCodeTools);
  safeRegister(pi, deps, 'doc tools', registerDocTools);
  safeRegister(pi, deps, 'dashboard command', registerDashboardCommand);

  // Surface partial load failures via UI notification
  if (registrationFailures.length > 0) {
    try {
      pi.on('session_start', async (_event, ctx) => {
        ctx.ui.notify(`⚠️ Memory layer partially loaded: ${registrationFailures.join(', ')}`, 'warn');
      });
    } catch {}
  }
}
