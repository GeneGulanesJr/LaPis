import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MemResult, state } from "../state";
import { ensureNativeModules } from "../host/native-health";
import { mem, memCmd } from "../host/memory-client";
import { detectProject } from "../host/project-detector";
import path from "node:path";

interface SessionDeps {
  state: typeof state;
  ensureNativeModules: typeof ensureNativeModules;
  mem: typeof mem;
  memCmd: typeof memCmd;
  detectProject: typeof detectProject;
}

function extractMessageText(msg: any): string {
  if (!msg) {return "";}
  if (typeof msg.content === "string") {return msg.content;}
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text || "")
      .join(" ");
  }
  return "";
}

export function registerSessionStart(pi: ExtensionAPI, deps: SessionDeps) {
  pi.on("session_start", async (event, ctx) => {
    await deps.ensureNativeModules();
    deps.state.currentProject = await deps.detectProject(ctx.cwd);
    deps.state.nudgeCountThisSession = 0;
    deps.state.turnCount = 0;
    deps.state.llmCallCount = 0;
    deps.state.lastMemoryToolCall = 0;
    deps.state.lastAutoDecisionSave = 0;
    deps.state.hasInjectedContext = false;
    deps.state.editedFiles = new Set();
    deps.state.exploredFiles = new Set();
    deps.state.cachedRepos = null;
    deps.state.repoCacheTime = 0;

    const result = await deps.mem("session-start", { project: deps.state.currentProject });
    if (!result) {
      ctx.ui.notify("Memory: failed to start session", "error");
      return;
    }

    deps.state.sessionId = result.sessionId as number;

    if (result.recoveredSession) {
      ctx.ui.notify(
        `Memory: recovered orphaned session for ${deps.state.currentProject}`,
        "info",
      );
    }

    ctx.ui.setStatus("memory", `🧠 session ${deps.state.sessionId}`);

    if (deps.state.sessionId % 10 === 0) {
      try {
        const dreamResult = await deps.memCmd("dream");
        if (dreamResult && (dreamResult as any).totalCleaned > 0) {
          ctx.ui.notify(
            `💤 Dream Cycle: ${(dreamResult as any).totalCleaned} memories cleaned (session #${deps.state.sessionId})`,
            "info",
          );
        }
      } catch (e) {
        console.error("[memory-layer] auto-dream failed:", e);
      }
    }
  });
}

export function registerSessionCompact(pi: ExtensionAPI, deps: SessionDeps) {
  pi.on("session_compact", async (_event, ctx) => {
    if (!deps.state.currentProject) {return;}

    const contextResult = await deps.mem("context", {
      project: deps.state.currentProject,
      limit: "15",
      ...(deps.state.sessionId ? { "session-id": String(deps.state.sessionId) } : {}),
    });

    let crossProjectResult: MemResult | null = null;
    if (!contextResult || !((contextResult.observations as any[]) || []).length) {
      crossProjectResult = await deps.mem("context", {
        "all-projects": "true",
        limit: "10",
        ...(deps.state.sessionId ? { "session-id": String(deps.state.sessionId) } : {}),
      });
    }

    if (!contextResult && !crossProjectResult) {return;}

    const isNewProject = crossProjectResult !== null;
    const effectiveObservations = isNewProject
      ? ((crossProjectResult!.observations as any[]) || [])
      : ((contextResult!.observations as any[]) || []);
    const stats = contextResult?.stats as any;
    const personal = (contextResult?.personal as any[]) || [];

    const lines: string[] = [
      "## Memory Context (re-injected after compaction)",
      "",
    ];

    if (isNewProject) {
      lines.push(`Project: **${deps.state.currentProject}** | 🆕 new project`);
      if (effectiveObservations.length > 0) {
        lines.push("");
        lines.push("### 🔗 Related memories from other projects");
        for (const o of effectiveObservations.slice(0, 5)) {
          lines.push(`- [${o.type}] ${o.title}`);
        }
      }
    } else {
      lines.push(`Project: **${deps.state.currentProject}** | ${stats?.total_memories || 0} memories`);
      if (effectiveObservations.length > 0) {
        lines.push("");
        lines.push("### Recent Relevant Memory");
        for (const o of effectiveObservations) {
          const trust = o.trust_score < 0.5 ? "⚠️" : o.trust_score < 0.8 ? "🔎" : "";
          lines.push(`- [${o.type}] ${o.title} ${trust}`);
        }
      }
    }

    if (personal.length > 0) {
      lines.push("");
      lines.push("### Your Preferences (cross-project)");
      for (const p of personal.slice(0, 3)) {
        lines.push(`- ${p.title}`);
      }
    }

    lines.push("");
    lines.push("Use `memory-save`, `memory-search`, and `memory-get` tools to interact with memory.");

    return {
      message: {
        customType: "memory-context",
        content: lines.join("\n"),
        display: false,
      },
    };
  });
}

export function registerSessionShutdown(pi: ExtensionAPI, deps: SessionDeps) {
  pi.on("session_shutdown", async (_event, ctx) => {
    if (!deps.state.sessionId || !deps.state.currentProject) {return;}

    const entries = ctx.sessionManager.getEntries();
    const userMessages = entries.filter(
      (e: any) => e.type === "message" && e.message?.role === "user",
    );
    const assistantMessages = entries.filter(
      (e: any) => e.type === "message" && e.message?.role === "assistant",
    );

    const topics: string[] = [];
    for (const m of userMessages) {
      const text = extractMessageText((m as any).message);
      if (text) {
        const firstSentence = text.split(/[.!?\n]/)[0].slice(0, 100);
        if (firstSentence && !topics.includes(firstSentence)) {
          topics.push(firstSentence);
        }
      }
    }

    const summaryParts: string[] = [
      "## Goal",
      userMessages.length > 0
        ? (userMessages[0] as any).message?.content?.[0]?.text?.slice(0, 200) || "Session work"
        : "Session work",
      "",
      "## Topics Discussed",
      ...topics.slice(0, 10).map(t => `- ${t}`),
    ];

    if (deps.state.editedFiles.size > 0) {
      summaryParts.push("", "## Files Modified");
      for (const f of [...deps.state.editedFiles].slice(0, 20)) {
        summaryParts.push(`- ${path.relative(process.cwd(), f) || f}`);
      }
    }

    summaryParts.push(
      "",
      "## Accomplished",
      `${deps.state.memoriesSavedThisSession} memories saved, ${assistantMessages.length} assistant turns, ${deps.state.turnCount} total turns`,
    );

    await deps.mem("session-summary", {
      content: summaryParts.join("\n"),
      project: deps.state.currentProject,
    });

    await deps.mem("session-end", {
      id: String(deps.state.sessionId),
      memories: String(deps.state.memoriesSavedThisSession),
      auto: "true",
    });

    if (ctx.hasUI) {
      ctx.ui.notify(`Memory: session saved (${deps.state.memoriesSavedThisSession} memories, ${deps.state.turnCount} turns)`, "info");
    }
  });
}
