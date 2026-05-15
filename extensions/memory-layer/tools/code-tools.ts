import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mem, memStreaming } from "../host/memory-client";
import { getKnownRepos } from "../host/project-detector";
import { formatCodeResult } from "./format-code-result";

interface CodeDeps {
  mem: typeof mem;
  memStreaming: typeof memStreaming;
  getKnownRepos: typeof getKnownRepos;
  formatCodeResult: typeof formatCodeResult;
}

export function registerCodeTools(pi: ExtensionAPI, deps: CodeDeps) {
  pi.registerTool({
    name: "memory-code",
    label: "Code Analysis",
    description:
      "Analyze code in indexed repos — import graphs, call hierarchies, blast radius, dead code, complexity, hotspots, cycles, " +
      "importance, coupling, extraction candidates, class hierarchy, file outlines, churn, and signal chains. " +
      "Requires the repo to be indexed first (use mode `index-repo`). " +
      "Modes: callers, callees, blast-radius, dead-code, complexity, deps, outline, churn, hotspots, cycles, importance, coupling, extractable, hierarchy, signal-chains, layer-violations, index-repo, reindex-repo.",
    parameters: Type.Object({
      mode: Type.String({
        description: "Analysis mode: callers|callees|blast-radius|dead-code|complexity|deps|outline|churn|hotspots|cycles|importance|coupling|extractable|hierarchy|signal-chains|layer-violations|index-repo|reindex-repo",
        enum: ["callers", "callees", "blast-radius", "dead-code", "complexity", "deps", "outline", "churn", "hotspots", "cycles", "importance", "coupling", "extractable", "hierarchy", "signal-chains", "layer-violations", "index-repo", "reindex-repo"],
      }),
      repo: Type.Optional(Type.String({ description: "Indexed repo name (required for analysis modes, optional for index-repo)" })),
      symbol: Type.Optional(Type.String({ description: "Symbol name (required for callers, callees, blast-radius, complexity)" })),
      file: Type.Optional(Type.String({ description: "File path (required for outline, churn; optional for deps)" })),
      depth: Type.Optional(Type.Number({ description: "Graph traversal depth 1-5 (default 3)", default: 3 })),
      direction: Type.Optional(Type.String({ description: "Import direction for deps: imports|importers|both", default: "both" })),
      min_confidence: Type.Optional(Type.Number({ description: "Min confidence for dead-code (0-1, default 0.5)", default: 0.5 })),
      days: Type.Optional(Type.Number({ description: "Churn/hotspot lookback window in days (default 90)", default: 90 })),
      refresh: Type.Optional(Type.Boolean({ description: "Force refresh churn cache", default: false })),
      top: Type.Optional(Type.Number({ description: "Max results (default 20)", default: 20 })),
      scope: Type.Optional(Type.String({ description: "Scope importance to subdirectory (e.g. 'src/core')" })),
      sort_by: Type.Optional(Type.String({ description: "Sort coupling by: instability|afferent|efferent", default: "instability" })),
      min_complexity: Type.Optional(Type.Number({ description: "Min cyclomatic complexity for extractable (default 5)", default: 5 })),
      min_callers: Type.Optional(Type.Number({ description: "Min caller files for extractable (default 2)", default: 2 })),
      direction_hier: Type.Optional(Type.String({ description: "Hierarchy direction: both|ancestors|descendants", default: "both" })),
      kind: Type.Optional(Type.String({ description: "Gateway kind: http, cli, or omit for all" })),
      symbol_chain: Type.Optional(Type.String({ description: "Trace which signal chain a symbol participates in" })),
      path: Type.Optional(Type.String({ description: "Local path to repo directory (required for index-repo mode)" })),
      name: Type.Optional(Type.String({ description: "Repo name for indexing (defaults to directory basename)" })),
      rules: Type.Optional(Type.String({ description: "JSON layer rules config (or use .pimemory-layers.jsonc file)" })),
    }),
    async execute(_id, params, _signal, onUpdate, _ctx) {
      const cmdMap: Record<string, string> = {
        callers: "call-hierarchy",
        callees: "call-hierarchy",
        "blast-radius": "blast-radius",
        "dead-code": "dead-code",
        complexity: "complexity",
        deps: "import-graph",
        outline: "outline",
        churn: "churn",
        hotspots: "hotspots",
        cycles: "cycles",
        importance: "importance",
        coupling: "coupling",
        extractable: "extractable",
        hierarchy: "hierarchy",
        "signal-chains": "signal-chains",
        "layer-violations": "layer-violations",
        "index-repo": "index-repo",
        "reindex-repo": "reindex-repo",
      };
      const cmd = cmdMap[params.mode];
      if (!cmd) {return { content: [{ type: "text", text: `Unknown mode: ${params.mode}` }], details: {}, isError: true };}

      const args: Record<string, string> = {};
      if (params.repo) {args.repo = params.repo;}
      if (params.symbol) {args.symbol = params.symbol;}
      if (params.file) {args.file = params.file;}
      if (params.depth) {args.depth = String(params.depth);}
      if (params.direction) {args.direction = params.direction;}
      if (cmd === "call-hierarchy") {args.direction = params.mode === "callers" ? "callers" : "callees";}
      if (params.min_confidence) {args["min-confidence"] = String(params.min_confidence);}
      if (params.days) {args.days = String(params.days);}
      if (params.refresh) {args.refresh = "true";}
      if (params.top) {args.top = String(params.top);}
      if (params.scope) {args.scope = params.scope;}
      if (params.sort_by) {args["sort-by"] = params.sort_by;}
      if (params.min_complexity) {args["min-complexity"] = String(params.min_complexity);}
      if (params.min_callers) {args["min-callers"] = String(params.min_callers);}
      if (params.direction_hier) {args.direction = params.direction_hier;}
      if (params.kind) {args.kind = params.kind;}
      if (params.symbol_chain) {args.symbol = String(params.symbol_chain);}
      if (params.path) {args.path = params.path;}
      if (params.name) {args.name = params.name;}
      if (params.rules) {args.rules = typeof params.rules === "string" ? params.rules : JSON.stringify(params.rules);}

      if (params.mode === "index-repo" || params.mode === "reindex-repo") {
        const result = await deps.memStreaming(cmd, args, (msg: string) => {
          try { onUpdate({ type: "progress", message: msg }); } catch { /* ignore if onUpdate not supported */ }
        });
        if (!result) {return { content: [{ type: "text", text: "Indexing failed or timed out." }], details: {}, isError: true };}
        if (result.error) {return { content: [{ type: "text", text: `Error: ${result.error}` }], details: result, isError: true };}
        const fmt = deps.formatCodeResult(params.mode, result);
        return { content: [{ type: "text", text: fmt }], details: result };
      }

      const codeRepos = await deps.getKnownRepos();
      const repoMatch = codeRepos.find(r => r.name.toLowerCase() === params.repo.toLowerCase());
      if (!repoMatch) {
        const available = codeRepos.map(r => r.name).join(", ") || "none";
        const cwd = process.cwd();
        return {
          content: [{ type: "text", text: `❌ Repo \"${params.repo}\" is not indexed. Available repos: ${available}\n\nTo index this repo, run:\n\`memory-code index-repo --path ${cwd} --name ${params.repo}\`` }],
          details: {},
          isError: true,
        };
      }

      const result = await deps.mem(cmd, args);
      if (!result) {
        if (cmd === "dead-code" || cmd === "cycles" || cmd === "importance" || cmd === "coupling" || cmd === "signal-chains" || cmd === "import-graph") {
          return { content: [{ type: "text", text: `Analysis timed out or failed for \"${params.mode}\". Try reducing scope or depth, or re-index the repo.\nCommand: ${cmd} on repo \"${params.repo}\"` }], details: {}, isError: true };
        }
        return { content: [{ type: "text", text: "Analysis failed." }], details: {}, isError: true };
      }
      if (result.error) {return { content: [{ type: "text", text: `Error: ${result.error}` }], details: result, isError: true };}

      const fmt = deps.formatCodeResult(params.mode, result);
      return { content: [{ type: "text", text: fmt }], details: result };
    },
  });
}
