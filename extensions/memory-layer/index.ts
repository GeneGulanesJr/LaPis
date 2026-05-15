/**
 * Memory Layer Extension — Thin Composition Root
 *
 * Registers hooks, tools, and commands via separated adapter modules.
 * Each adapter is independently testable. A failure in one adapter
 * (e.g., doc tooling) does not prevent unrelated tools from registering.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { state, trustIcon, isCodeFile } from "./state";
import { ensureNativeModules } from "./host/native-health";
import { mem, memCmd, memStreaming } from "./host/memory-client";
import { detectProject, getKnownRepos, isRepoStale } from "./host/project-detector";
import { registerSessionStart, registerSessionCompact, registerSessionShutdown } from "./hooks/session-lifecycle";
import { registerBeforeAgentStart, registerContextReminder } from "./hooks/context-injection";
import { registerToolGuardrails } from "./hooks/tool-guardrails";
import { registerTrustSync } from "./hooks/trust-sync";
import { registerPassiveCapture } from "./hooks/passive-capture";
import { registerMemoryTools } from "./tools/memory-tools";
import { registerCodeTools } from "./tools/code-tools";
import { registerDocTools } from "./tools/doc-tools";
import { formatCodeResult } from "./tools/format-code-result";
import { formatDocResult } from "./tools/format-doc-result";

type RegFn = (pi: ExtensionAPI, deps: any) => void;

function safeRegister(pi: ExtensionAPI, deps: any, name: string, fn: RegFn) {
  try {
    fn(pi, deps);
  } catch (e) {
    console.error(`[memory-layer] Failed to register ${name}:`, e instanceof Error ? e.message : String(e));
  }
}

export default function (pi: ExtensionAPI) {
  const deps = {
    state,
    ensureNativeModules,
    mem,
    memCmd,
    memStreaming,
    detectProject,
    getKnownRepos,
    isRepoStale,
    isCodeFile,
    trustIcon,
    formatCodeResult,
    formatDocResult,
  };

  safeRegister(pi, deps, "session-lifecycle hooks", registerSessionStart);
  safeRegister(pi, deps, "session-compact hook", registerSessionCompact);
  safeRegister(pi, deps, "before-agent-start hook", registerBeforeAgentStart);
  safeRegister(pi, deps, "context-reminder hook", registerContextReminder);
  safeRegister(pi, deps, "tool-guardrails hook", registerToolGuardrails);
  safeRegister(pi, deps, "trust-sync hook", registerTrustSync);
  safeRegister(pi, deps, "passive-capture hooks", registerPassiveCapture);
  safeRegister(pi, deps, "session-shutdown hook", registerSessionShutdown);
  safeRegister(pi, deps, "memory tools", registerMemoryTools);
  safeRegister(pi, deps, "code tools", registerCodeTools);
  safeRegister(pi, deps, "doc tools", registerDocTools);
}
