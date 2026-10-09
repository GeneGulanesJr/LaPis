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
import {
  detectProject,
  getKnownRepos,
  getKnownDocRepos,
  invalidateRepoCache,
  isRepoStale,
} from './host/project-detector';
import { registerPassiveCapture } from './hooks/passive-capture';
import { registerToolGuardrails } from './hooks/tool-guardrails';
import { registerOutputCompression } from './hooks/output-compression';
import { getConfig } from '../../config';
import { registerTrustSync } from './hooks/trust-sync';
import { ensureNativeModules } from './host/native-health';
import { registerCodeTools } from './tools/code-tools';
import { registerDocTools } from './tools/doc-tools';
import { registerDashboardCommand } from './commands/dashboard';
import { createJevCompactionPlanner } from './hooks/jev-compaction-planner';
import { ensureBuiltinJudgStrategies } from './host/strategies/builtin-judg-strategies';
import { formatCodeResult } from './tools/format-code-result';
import { formatDocResult } from './tools/format-doc-result';
import { registerMemoryTools } from './tools/memory-tools';

type RegFn = (pi: ExtensionAPI, deps: any) => void;

export default function memoryLayer(pi: ExtensionAPI) {
  // Per-invocation, not module scope: pi re-invokes this factory on
  // resume/fork with cached modules, and failure state must not leak across
  // runtimes (issue #363).
  const registrationFailures: string[] = [];

  function safeRegister(name: string, fn: RegFn) {
    try {
      fn(pi, deps);
    } catch (e) {
      console.error(`[memory-layer] Failed to register ${name}:`, e instanceof Error ? e.message : String(e));
      registrationFailures.push(name);
    }
  }

  const deps = {
    state,
    ensureNativeModules,
    mem,
    memCmd,
    memStreaming,
    detectProject,
    getKnownRepos,
    getKnownDocRepos,
    invalidateRepoCache,
    isRepoStale,
    isCodeFile,
    trustIcon,
    formatCodeResult,
    formatDocResult,
    getSettings: () => ({ contextLimit: getConfig().context_limit }),
    getConfig,
  };

  safeRegister('session-lifecycle hooks', registerSessionStart);
  // Jev-driven compaction (OFF by default — see docs/JEV_DRIVEN_COMPACTION.md).
  // Strategies are registered eagerly so they're discoverable, but the planner
  // is a no-op unless `compaction.judg` / `PI_COMPACTION_JUDG` opts in.
  try {
    ensureBuiltinJudgStrategies();
  } catch (e) {
    console.error(
      '[memory-layer] failed to register compaction strategies:',
      e instanceof Error ? e.message : String(e),
    );
    registrationFailures.push('compaction strategies');
  }
  try {
    createJevCompactionPlanner().register(pi);
  } catch (e) {
    console.error(
      '[memory-layer] failed to register compaction planner:',
      e instanceof Error ? e.message : String(e),
    );
    registrationFailures.push('compaction planner');
  }

  safeRegister('session-compact hook', registerSessionCompact);
  safeRegister('before-agent-start hook', registerBeforeAgentStart);
  safeRegister('context-reminder hook', registerContextReminder);
  safeRegister('tool-guardrails hook', registerToolGuardrails);
  safeRegister('output-compression hook', (api, ctx) => {
    registerOutputCompression(api, { state: ctx.state, getConfig });
  });
  safeRegister('trust-sync hook', registerTrustSync);
  safeRegister('passive-capture hooks', registerPassiveCapture);
  safeRegister('session-shutdown hook', registerSessionShutdown);
  safeRegister('memory tools', registerMemoryTools);
  safeRegister('code tools', registerCodeTools);
  safeRegister('doc tools', registerDocTools);
  safeRegister('dashboard command', registerDashboardCommand);

  // Surface partial load failures via UI notification
  if (registrationFailures.length > 0) {
    try {
      pi.on('session_start', async (_event, ctx) => {
        ctx.ui.notify(`⚠️ Memory layer partially loaded: ${registrationFailures.join(', ')}`, 'warn');
      });
    } catch {}
  }
}
