import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mem } from "../host/memory-client";
import { getKnownRepos } from "../host/project-detector";
import { formatDocResult } from "./format-doc-result";

interface DocDeps {
  mem: typeof mem;
  getKnownRepos: typeof getKnownRepos;
  formatDocResult: typeof formatDocResult;
}

export function registerDocTools(pi: ExtensionAPI, deps: DocDeps) {
  pi.registerTool({
    name: "memory-doc",
    label: "Doc Index",
    description:
      "Search and query indexed documentation — full-text search, outlines, backlinks, broken links, glossary terms, tutorial paths, code examples, and stale page detection. " +
      "Requires docs to be indexed first (use mode `index-docs`). " +
      "Modes: search, outline, backlinks, broken-links, glossary, tutorial-path, code-examples, orphans, coverage, stale-pages, duplicates, index-docs, reindex-docs.",
    parameters: Type.Object({
      mode: Type.String({
        description: "Query mode: search|outline|backlinks|broken-links|glossary|tutorial-path|code-examples|orphans|coverage|stale-pages|duplicates|index-docs|reindex-docs",
        enum: ["search", "outline", "backlinks", "broken-links", "glossary", "tutorial-path", "code-examples", "orphans", "coverage", "stale-pages", "duplicates", "index-docs", "reindex-docs"],
      }),
      repo: Type.Optional(Type.String({ description: "Indexed doc repo name (required for query modes, optional for index-docs)" })),
      query: Type.Optional(Type.String({ description: "Search query (required for search, code-examples)" })),
      file: Type.Optional(Type.String({ description: "Doc file path (optional for outline)" })),
      doc_path: Type.Optional(Type.String({ description: "Doc file path (for backlinks, required)" })),
      term: Type.Optional(Type.String({ description: "Glossary term to look up (optional)" })),
      section: Type.Optional(Type.Number({ description: "Section ID for tutorial-path" })),
      level: Type.Optional(Type.Number({ description: "Heading level filter for search" })),
      role: Type.Optional(Type.String({ description: "Role filter for search: concept, tutorial, how_to, api, example, troubleshooting, faq" })),
      lang: Type.Optional(Type.String({ description: "Language filter for code-examples (e.g. 'js', 'python')" })),
      include_same_doc: Type.Optional(Type.Boolean({ description: "Include intra-document links when finding orphans (default: false)" })),
      doc_repo: Type.Optional(Type.String({ description: "Code repo name for coverage mode. Defaults to repo." })),
      path: Type.Optional(Type.String({ description: "Local path to docs directory (required for index-docs mode)" })),
      name: Type.Optional(Type.String({ description: "Doc repo name (required for index-docs mode)" })),
      ignore: Type.Optional(Type.String({ description: "Glob pattern to ignore during doc indexing" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const cmdMap: Record<string, string> = {
        search: "doc-search",
        outline: "doc-outline",
        backlinks: "backlinks",
        "broken-links": "broken-links",
        glossary: "glossary",
        "tutorial-path": "tutorial-path",
        "code-examples": "code-examples",
        orphans: "doc-orphans",
        coverage: "doc-coverage",
        "stale-pages": "stale-pages",
        duplicates: "doc-duplicates",
        "index-docs": "index-docs",
        "reindex-docs": "reindex-docs",
      };
      const cmd = cmdMap[params.mode];
      if (!cmd) {return { content: [{ type: "text", text: `Unknown mode: ${params.mode}` }], details: {}, isError: true };}

      const args: Record<string, string> = {};
      if (params.repo) {args.repo = params.repo;}
      if (params.query) {args.query = params.query;}
      if (params.file) {args.file = params.file;}
      if (params.doc_path) {args.path = params.doc_path;}
      if (params.term) {args.term = params.term;}
      if (params.section) {args.section = String(params.section);}
      if (params.level) {args.level = String(params.level);}
      if (params.role) {args.role = params.role;}
      if (params.lang) {args.lang = params.lang;}
      if (params.include_same_doc) {args["include-same-doc"] = "true";}
      if (params.doc_repo) {args["doc-repo"] = params.doc_repo;}
      if (params.path) {args.path = params.path;}
      if (params.name) {args.name = params.name;}
      if (params.ignore) {args.ignore = params.ignore;}

      if (params.mode === "index-docs" || params.mode === "reindex-docs") {
        const result = await deps.mem(cmd, args);
        if (!result) {return { content: [{ type: "text", text: "Doc indexing failed or timed out." }], details: {}, isError: true };}
        if (result.error) {return { content: [{ type: "text", text: `Error: ${result.error}` }], details: result, isError: true };}
        const fmt = deps.formatDocResult(params.mode, result);
        return { content: [{ type: "text", text: fmt }], details: result };
      }

      const docRepos = await deps.getKnownRepos();
      const docRepoMatch = docRepos.find(r => r.name.toLowerCase() === params.repo.toLowerCase());
      if (!docRepoMatch) {
        const available = docRepos.map(r => r.name).join(", ") || "none";
        const cwd = process.cwd();
        return {
          content: [{ type: "text", text: `❌ Doc repo \"${params.repo}\" is not indexed. Available repos: ${available}\n\nTo index these docs, run:\n\`memory-doc index-docs --path ${cwd} --name ${params.repo}\`` }],
          details: {},
          isError: true,
        };
      }

      const result = await deps.mem(cmd, args);
      if (!result) {return { content: [{ type: "text", text: "Doc query failed." }], details: {}, isError: true };}
      if (result.error) {return { content: [{ type: "text", text: `Error: ${result.error}` }], details: result, isError: true };}

      const fmt = deps.formatDocResult(params.mode, result);
      return { content: [{ type: "text", text: fmt }], details: result };
    },
  });
}
