import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { state, trustIcon } from "../state";
import { mem, memCmd } from "../host/memory-client";

interface MemoryDeps {
  state: typeof state;
  mem: typeof mem;
  memCmd: typeof memCmd;
  trustIcon: typeof trustIcon;
}

export function registerMemoryTools(pi: ExtensionAPI, deps: MemoryDeps) {
  pi.registerTool({
    name: "memory-save",
    label: "Save Memory",
    description:
      "Save an observation to persistent memory. Use for decisions, bugfixes, architecture constraints, patterns, and discoveries. " +
      "Automatically checks for duplicates. Content should use **What**/**Why**/**Where**/**Learned** format.",
    parameters: Type.Object({
      title: Type.String({ description: "Short, searchable title (e.g. 'JWT auth middleware', 'Fixed N+1 in user list')" }),
      content: Type.String({ description: "Structured content: **What**: ...\\n**Why**: ...\\n**Where**: ...\\n**Learned**: ..." }),
      type: Type.Optional(Type.String({ description: "Observation type: decision, bugfix, architecture, pattern, discovery, config, preference, learning", default: "manual" })),
      scope: Type.Optional(Type.String({ description: "Scope: 'project' (default) or 'personal' (cross-project preferences)", default: "project" })),
      topic_key: Type.Optional(Type.String({ description: "Optional topic key for grouping related observations (e.g. 'auth/jwt-middleware')" })),
      force: Type.Optional(Type.Boolean({ description: "Force save even if duplicate detected", default: false })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      deps.state.memoriesSavedThisSession++;
      const result = await deps.mem("save", {
        title: params.title,
        content: params.content,
        type: params.type || "manual",
        project: deps.state.currentProject || "unknown",
        scope: params.scope || "project",
        ...(params.topic_key ? { "topic-key": params.topic_key } : {}),
        ...(params.force ? { force: "true" } : {}),
      });

      if (!result) {
        return { content: [{ type: "text", text: "Failed to save memory." }], details: {}, isError: true };
      }

      if (result.auto_merged) {
        return {
          content: [{
            type: "text",
            text: `✅ Memory saved [#${result.id}] ${result.title}\n🔄 Auto-merged: superseded older [#${result.superseded_id}] "${result.superseded_title}" (${(result.similarity * 100).toFixed(0)}% similar)`,
          }],
          details: result,
        };
      }

      if (result.status === "potential_duplicate") {
        return {
          content: [{
            type: "text",
            text: `⚠️ Potential duplicate detected:\n${(result.matches as any[]).map((m: any) => `  - [#${m.id}] ${m.title} (${m.similarity}% similar)`).join("\n")}\n\nUse force=true to save anyway.`,
          }],
          details: result,
          isError: false,
        };
      }

      return {
        content: [{ type: "text", text: `✅ Memory saved: [#${result.id}] ${result.title}` }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "memory-search",
    label: "Search Memory",
    description:
      "Search persistent memory for past decisions, bugfixes, patterns, and discoveries. " +
      "Results are ranked by relevance, recency, trust, and usefulness. " +
      "Always search before saving to avoid duplicates.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query — matches titles and content" }),
      type: Type.Optional(Type.String({ description: "Filter by type: decision, bugfix, architecture, pattern, discovery, config, preference" })),
      scope: Type.Optional(Type.String({ description: "Filter by scope: project, personal" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default 10)", default: 10 })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      let result = deps.state.currentProject
        ? await deps.mem("search", {
            query: params.query,
            ...(params.type ? { type: params.type } : {}),
            ...(params.scope ? { scope: params.scope } : {}),
            ...(params.limit ? { limit: String(params.limit) } : {}),
            project: deps.state.currentProject,
            ...(deps.state.sessionId ? { "session-id": String(deps.state.sessionId) } : {}),
          })
        : null;

      if (!result || !((result.results as any[]) || []).length) {
        result = await deps.mem("search", {
          query: params.query,
          ...(params.type ? { type: params.type } : {}),
          ...(params.scope ? { scope: params.scope } : {}),
          ...(params.limit ? { limit: String(params.limit) } : {}),
          ...(deps.state.sessionId ? { "session-id": String(deps.state.sessionId) } : {}),
        });
      }

      if (!result) {
        return { content: [{ type: "text", text: "Search failed." }], details: {}, isError: true };
      }

      const results = (result.results as any[]) || [];
      if (results.length === 0) {
        return { content: [{ type: "text", text: "No memories found." }], details: result };
      }

      const lines = results.map((r: any) => {
        const score = r._score ? ` (${r._score.toFixed(2)})` : "";
        const trust = r.trust_score && r.trust_score < 0.5 ? " ⚠️" : "";
        return `- [#${r.id}] [${r.type}] ${r.title}${score}${trust}${r.snippet ? `\n  ${r.snippet}` : ""}`;
      });

      return {
        content: [{ type: "text", text: `Found ${results.length} memories:\n${lines.join("\n")}` }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "memory-get",
    label: "Get Memory",
    description:
      "Get full details of a specific memory by ID, including content, symbol links, and recall count.",
    parameters: Type.Object({
      id: Type.Number({ description: "Memory observation ID" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const result = await deps.mem("get", { id: String(params.id) });
      if (!result || result.error) {
        return { content: [{ type: "text", text: `Memory #${params.id} not found.` }], details: {}, isError: true };
      }
      return {
        content: [{ type: "text", text: `## #${result.id} — ${result.title}\nType: ${result.type} | Scope: ${result.scope} | Project: ${result.project}\n\n${result.content}` }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "memory-update",
    label: "Update Memory",
    description:
      "Update an existing memory in-place by ID. Use when you need to correct or refine a previously saved memory " +
      "instead of creating a duplicate or correction entry. Updates only the fields you provide.",
    parameters: Type.Object({
      id: Type.Number({ description: "Memory observation ID to update" }),
      title: Type.Optional(Type.String({ description: "New title (optional)" })),
      content: Type.Optional(Type.String({ description: "New content (optional). Use **What**/**Why**/**Where**/**Learned** format." })),
      type: Type.Optional(Type.String({ description: "New type: decision, bugfix, architecture, pattern, discovery, config, preference, learning" })),
      scope: Type.Optional(Type.String({ description: "New scope: project or personal" })),
      topic_key: Type.Optional(Type.String({ description: "New topic key (optional)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const args: Record<string, string> = { id: String(params.id) };
      if (params.title) {args.title = params.title;}
      if (params.content) {args.content = params.content;}
      if (params.type) {args.type = params.type;}
      if (params.scope) {args.scope = params.scope;}
      if (params.topic_key) {args["topic-key"] = params.topic_key;}

      const result = await deps.mem("update", args);
      if (!result || result.error) {
        return { content: [{ type: "text", text: `Failed to update memory #${params.id}: ${result?.error || "unknown error"}` }], details: {}, isError: true };
      }
      return {
        content: [{ type: "text", text: `✅ Memory updated: [#${result.id}] ${result.title}` }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "memory-delete",
    label: "Delete Memory",
    description:
      "Soft-delete a memory by ID. Use to remove stale, incorrect, or duplicate memories. " +
      "The memory is soft-deleted (can be recovered) rather than permanently destroyed.",
    parameters: Type.Object({
      id: Type.Number({ description: "Memory observation ID to delete" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const result = await deps.mem("delete", { id: String(params.id) });
      if (!result || result.error) {
        return { content: [{ type: "text", text: `Failed to delete memory #${params.id}: ${result?.error || "unknown error"}` }], details: {}, isError: true };
      }
      return {
        content: [{ type: "text", text: `🗑️ Memory #${params.id} deleted${result.hardDeleted ? " (hard)" : " (soft)"}` }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "memory-related",
    label: "Find Related Memories",
    description:
      "Find memories linked to the same code symbols as a given memory. " +
      "Use when you want to understand the full context around a topic.",
    parameters: Type.Object({
      id: Type.Number({ description: "Memory ID to find related memories for" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const result = await deps.mem("related", { id: String(params.id) });
      if (!result) {
        return { content: [{ type: "text", text: "Failed to find related memories." }], details: {}, isError: true };
      }
      const related = (result.related as any[]) || [];
      if (related.length === 0) {
        return { content: [{ type: "text", text: "No related memories found." }], details: result };
      }
      const lines = related.flatMap((r: any) => [
        `### ${r.symbol}`,
        ...r.memories.map((m: any) => `- [#${m.id}] [${m.type}] ${m.title}`),
      ]);
      return {
        content: [{ type: "text", text: `Related memories for #${params.id}:\n${lines.join("\n")}` }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "memory-load-context",
    label: "Load Topic Context",
    description:
      "Load deeper memory context for a specific topic or query. " +
      "Use this when you need everything the memory layer knows about a specific domain " +
      "(e.g., 'xRDP audio', 'benchmark pipeline', 'GPU setup'). " +
      "Returns more memories than the auto-loaded context, focused on the topic.",
    parameters: Type.Object({
      query: Type.String({ description: "Topic or keyword to load context for (e.g. 'xrdp', 'benchmark', 'auth')" }),
      deep: Type.Optional(Type.Boolean({ description: "Load deeper (up to 3x more memories). Default false.", default: false })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!deps.state.currentProject) {
        return { content: [{ type: "text", text: "No project detected — can't load context." }], details: {}, isError: true };
      }
      const result = await deps.mem("context", {
        project: deps.state.currentProject,
        query: params.query,
        limit: "30",
        deep: params.deep ? "true" : "false",
        ...(deps.state.sessionId ? { "session-id": String(deps.state.sessionId) } : {}),
      });

      if (!result) {
        return { content: [{ type: "text", text: "Failed to load context." }], details: {}, isError: true };
      }

      const observations = (result.observations as any[]) || [];
      if (observations.length === 0) {
        return { content: [{ type: "text", text: `No memories found for topic "${params.query}".` }], details: result };
      }

      const lines = observations.map((o: any) => {
        const trust = deps.trustIcon(o.trust_score);
        return `- [#${o.id}] [${o.type}] ${o.title}${trust}`;
      });

      return {
        content: [{
          type: "text",
          text: `## Topic Context: "${params.query}"\n**${result.stats.total_memories}** total memories in **${deps.state.currentProject}**, showing ${observations.length} matching "${params.query}":\n\n${lines.join("\n")}`,
        }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "memory-sync-code-trust",
    label: "Sync Trust w/ Code Changes",
    description:
      "Synchronize memory trust scores with code changes detected by jCodeMunch. " +
      "Pipe the output of jcodemunch_get_changed_symbols to auto-adjust trust: " +
      "memories linked to changed symbols lose trust (-0.3), unchanged ones gain (+0.05). " +
      "Run this after a git pull, branch switch, or major code change to keep memory accurate.",
    parameters: Type.Object({
      repo: Type.String({ description: "jCodeMunch repo identifier for symbol lookups" }),
      changed_symbols_json: Type.String({ description: "JSON output from jcodemunch_get_changed_symbols (the raw result object, stringified)" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const result = await deps.mem("sync-code-trust", {
        repo: params.repo,
        "changed-symbols-json": params.changed_symbols_json,
      });

      if (!result) {
        return { content: [{ type: "text", text: "Failed to sync trust scores." }], details: {}, isError: true };
      }

      const lines: string[] = [];
      if ((result.adjusted as any[])?.length) {
        lines.push(`### ⚠️ Trust reduced (symbols changed): ${result.adjusted.length}`);
        (result.adjusted as any[]).forEach((a: any) => {
          lines.push(`- memory #${a.memory_id} (symbol: ${a.symbol_id}): ${a.old_trust} → ${a.new_trust}`);
        });
      }
      if ((result.survived as any[])?.length) {
        lines.push(`\n### ✅ Trust increased (symbols survived): ${result.survived.length}`);
        (result.survived as any[]).slice(0, 10).forEach((s: any) => {
          lines.push(`- memory #${s.memory_id}: ${s.old_trust} → ${s.new_trust}`);
        });
      }
      if ((result.unchanged as any[])?.length) {
        lines.push(`\n### 🔒 Unchanged (already max trust): ${result.unchanged.length}`);
      }

      lines.push(`\n**Total links checked:** ${result.total}`);

      return {
        content: [{ type: "text", text: lines.join("\n") || "No changes detected." }],
        details: result,
      };
    },
  });

  pi.registerCommand("memory-stats", {
    description: "Show memory layer statistics",
    handler: async (_args, ctx) => {
      const result = await deps.memCmd("stats");
      if (result) {
        ctx.ui.notify(
          `🧠 ${result.total_observations} observations | ${result.total_sessions} sessions | ${result.total_symbol_links} symbol links`,
          "info",
        );
      }
    },
  });

  pi.registerCommand("memory-dream", {
    description: "Manually trigger the Dream Cycle — clean stale (not just old) memories",
    handler: async (_args, ctx) => {
      try {
        const result = await deps.memCmd("dream");
        if (result) {
          const phases = Object.entries((result as any).phases || {})
            .filter(([k, v]) => k !== "compact" && (v as any).count > 0)
            .map(([k, v]) => `${k}: ${(v as any).count}`)
            .join(", ");
          ctx.ui.notify(
            `💤 Dream Cycle complete: ${(result as any).totalCleaned} memories cleaned (${phases || 'nothing to clean'})`,
            "info",
          );
        }
      } catch (e) {
        ctx.ui.notify(`Dream Cycle failed: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });

  pi.registerCommand("memory-context", {
    description: "Reload memory context for current project",
    handler: async (_args, ctx) => {
      if (!deps.state.currentProject) {
        ctx.ui.notify("No project detected", "error");
        return;
      }
      const result = await deps.mem("context", { project: deps.state.currentProject, limit: "10" });
      if (result) {
        const obs = (result.observations as any[]) || [];
        ctx.ui.notify(
          `🧠 ${obs.length} observations loaded for ${deps.state.currentProject}`,
          "info",
        );
      }
    },
  });
}
