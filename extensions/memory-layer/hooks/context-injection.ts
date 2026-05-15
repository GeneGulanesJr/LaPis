import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MemResult, state, MEMORY_REMINDER_INTERVAL } from "../state";
import { mem } from "../host/memory-client";
import { getKnownRepos, isRepoStale } from "../host/project-detector";
import path from "node:path";

interface ContextDeps {
  state: typeof state;
  mem: typeof mem;
  getKnownRepos: typeof getKnownRepos;
  isRepoStale: typeof isRepoStale;
}

export function registerBeforeAgentStart(pi: ExtensionAPI, deps: ContextDeps) {
  pi.on("before_agent_start", async (event, ctx) => {
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

    if (!contextResult) {return;}

    const observations = (contextResult.observations as Array<{
      id: number; title: string; type: string; scope: string;
      topic_key: string; trust_score: number; type_priority: number;
    }>) || [];

    const personal = (contextResult.personal as Array<{
      id: number; title: string; type: string;
    }>) || [];

    const stats = contextResult.stats as { total_memories: number; total_personal: number };
    const topic = contextResult.topic as string | null;

    if (observations.length === 0 && personal.length === 0 && !crossProjectResult) {return;}

    const isNewProject = crossProjectResult !== null;
    const effectiveObservations = isNewProject
      ? ((crossProjectResult!.observations as any[]) || [])
      : observations;
    const effectiveStats = isNewProject ? crossProjectResult!.stats as any : stats;

    deps.state.hasInjectedContext = true;

    const topicNote = topic ? ` | topic: ${topic}` : "";
    const lines: string[] = [
      "## Memory Context (auto-loaded)",
      "",
    ];

    if (isNewProject) {
      lines.push(`Project: **${deps.state.currentProject}** | 🆕 new project | ${effectiveStats?.total_memories || 0} total memories across all projects | ${stats?.total_personal || 0} personal preferences`);
      lines.push("");

      const byProject = new Map<string, any[]>();
      for (const o of effectiveObservations) {
        const proj = o.project || "unknown";
        if (!byProject.has(proj)) {byProject.set(proj, []);}
        byProject.get(proj)!.push(o);
      }

      if (byProject.size > 0) {
        lines.push("### 🔗 Related memories from other projects");
        for (const [proj, mems] of byProject) {
          lines.push(`**${proj}** (${mems.length} memories)`);
          for (const m of mems.slice(0, 5)) {
            const trust = m.trust_score < 0.5 ? " ⚠️" : m.trust_score < 0.7 ? " 🔎" : "";
            lines.push(`- [${m.type}] ${m.title}${trust}`);
          }
        }
        lines.push("");
      }
    } else {
      lines.push(`Project: **${deps.state.currentProject}** | ${stats?.total_memories || 0} memories | ${stats?.total_personal || 0} personal preferences${topicNote}`);
      lines.push("");

      if (effectiveObservations.length > 0) {
        lines.push("### Recent Relevant Memory");
        for (const o of effectiveObservations) {
          const trust =
            o.trust_score < 0.5 ? "⚠️" :
            o.trust_score < 0.8 ? "🔎" : "";
          lines.push(`- [${o.type}] ${o.title} ${trust}`);
        }
        lines.push("");
      }
    }

    if (personal.length > 0) {
      lines.push("### Your Preferences (cross-project)");
      for (const p of personal.slice(0, 5)) {
        lines.push(`- ${p.title}`);
      }
      lines.push("");
    }

    lines.push("Use `memory-save`, `memory-search`, and `memory-get` tools to interact with memory.");

    const repos = await deps.getKnownRepos();
    const resolvedCwd = path.resolve(ctx.cwd);
    const cwdRepo =
      repos.find(r => resolvedCwd.startsWith(path.resolve(r.path))) ||
      repos.find(r => r.name.toLowerCase() === deps.state.currentProject?.toLowerCase());
    if (!cwdRepo) {
      lines.push("");
      lines.push(`⚠️ **Code not indexed:** Project \"${deps.state.currentProject}\" has no code index yet. Run \`memory-code index-repo --path ${ctx.cwd} --name ${deps.state.currentProject}\` to enable memory-code analysis.`);
    } else if (deps.isRepoStale(cwdRepo)) {
      lines.push("");
      lines.push(`📝 **Code index may be stale:** \"${cwdRepo.name}\" was indexed at ${cwdRepo.indexed_at}. Source files have been modified since. Run \`memory-code reindex-repo --repo ${cwdRepo.name}\` to update.`);
    }

    return {
      message: {
        customType: "memory-context",
        content: lines.join("\n"),
        display: false,
      },
    };
  });
}

export function registerContextReminder(pi: ExtensionAPI, deps: ContextDeps) {
  pi.on("context", async (event, _ctx) => {
    deps.state.llmCallCount++;

    if (deps.state.hasInjectedContext) {
      deps.state.hasInjectedContext = false;
      return;
    }

    if (deps.state.llmCallCount % MEMORY_REMINDER_INTERVAL !== 0) {return;}

    if (Date.now() - deps.state.lastMemoryToolCall < 180000) {return;}

    return {
      messages: [
        ...event.messages,
        {
          role: "user" as const,
          content: "💡 Memory reminder: Use `memory-search` before decisions to avoid repeating past mistakes. Use `memory-save` for decisions, bugfixes, and discoveries.",
        },
      ],
    };
  });
}
