import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { state, AUTO_DECISION_COOLDOWN, CHECKPOINT_INTERVAL } from "../state";
import { mem } from "../host/memory-client";
import path from "node:path";

interface PassiveCaptureDeps {
  state: typeof state;
  mem: typeof mem;
}

const DECISION_PATTERNS: Array<{ regex: RegExp; type: string; label: string }> = [
  { regex: /\b(I['']ll use|let's use|we should use|going with|switching to|using .* instead of)\b/i, type: "decision", label: "Design decision" },
  { regex: /\b(approach|strategy|architecture|pattern|design):\s/i, type: "decision", label: "Architecture choice" },
  { regex: /\b(root cause|the bug was|issue is|problem is|fix is|fixed by|workaround is)\b/i, type: "bugfix", label: "Bug fix" },
  { regex: /\b(I discovered|turns out|found that|interesting:|note that)\b/i, type: "discovery", label: "Discovery" },
  { regex: /\b(we need to|cannot|constraint|requirement|limitation is)\b/i, type: "architecture", label: "Constraint identified" },
];

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

export function registerPassiveCapture(pi: ExtensionAPI, deps: PassiveCaptureDeps) {
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName === "edit" || event.toolName === "write") {
      const input = event.input as { path?: string };
      if (!input?.path || !deps.state.currentProject) {return;}

      if (input.path.includes("memory-store.js") || input.path.includes("memory-layer")) {return;}

      deps.state.editedFiles.add(input.path);

      deps.state.memoriesSavedThisSession++;
      if (deps.state.memoriesSavedThisSession % 5 !== 0) {return;}

      await deps.mem("save", {
        title: `Edited ${path.basename(input.path)}`,
        type: "accomplished",
        project: deps.state.currentProject,
        scope: "project",
        force: "true",
        content: `**What**: File edited during session\n**Where**: ${input.path}`,
      });
    }
  });

  pi.on("message_end", async (event, _ctx) => {
    if (event.message?.role !== "assistant") {return;}
    const text = extractMessageText(event.message);
    if (!text || text.length < 50) {return;}

    if (Date.now() - deps.state.lastAutoDecisionSave < AUTO_DECISION_COOLDOWN) {return;}

    if (text.includes("memory-save") || text.includes("memory-search") || text.includes("memory-get")) {return;}

    for (const pattern of DECISION_PATTERNS) {
      if (pattern.regex.test(text)) {
        deps.state.lastAutoDecisionSave = Date.now();

        const firstLine = text.split("\n")[0].slice(0, 120);
        const title = `${pattern.label}: ${firstLine.slice(0, 80)}`;

        await deps.mem("save", {
          title,
          type: pattern.type,
          project: deps.state.currentProject || "unknown",
          scope: "project",
          force: "true",
          content: [
            `**What**: Auto-detected ${pattern.label.toLowerCase()}`,
            `**Where**: Session ${deps.state.sessionId || "unknown"}`,
            `**Learned**: ${text.slice(0, 300)}`,
          ].join("\n"),
        });
        break;
      }
    }
  });

  pi.on("turn_end", async (_event, _ctx) => {
    deps.state.turnCount++;
    if (deps.state.turnCount % CHECKPOINT_INTERVAL !== 0 || deps.state.turnCount === 0) {return;}
    if (!deps.state.currentProject) {return;}

    const summaryFiles = [...deps.state.editedFiles].slice(0, 10).map(f =>
      `- ${path.basename(f)}`).join("\n");

    await deps.mem("save", {
      title: `Progress checkpoint (turn ${deps.state.turnCount})`,
      type: "progress",
      project: deps.state.currentProject,
      scope: "project",
      force: "true",
      content: [
        `**What**: Auto-checkpoint at turn ${deps.state.turnCount}`,
        `**Where**: Session ${deps.state.sessionId}`,
        `**Learned**: ${deps.state.memoriesSavedThisSession} explicit memories saved, ${deps.state.editedFiles.size} files edited`,
        summaryFiles ? `Files touched:\n${summaryFiles}` : "",
      ].join("\n"),
    });
  });
}
