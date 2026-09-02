// Module boundary:
// Owns the MCP tool catalog — the single source of truth for what the MCP
// Transport exposes. Mirrors the Pi extension tools
// (extensions/memory-layer/tools/*.ts) but emits plain JSON schemas and
// {cmd, args} pairs ready for gateway.dispatch. No business logic lives here;
// Every tool delegates to the transport-agnostic dispatch core.

// Reused verbatim from extensions/memory-layer/tools/code-tools.ts:89-116.
// Keeping these in sync is enforced by test/mcp-tools-catalog.test.js.
const CODE_MODE_TO_COMMAND = {
    search: 'search-code',
    callers: 'call-hierarchy',
    callees: 'call-hierarchy',
    'blast-radius': 'blast-radius',
    'dead-code': 'dead-code',
    complexity: 'complexity',
    deps: 'import-graph',
    outline: 'outline',
    churn: 'churn',
    hotspots: 'hotspots',
    cycles: 'cycles',
    importance: 'importance',
    coupling: 'coupling',
    extractable: 'extractable',
    hierarchy: 'hierarchy',
    'signal-chains': 'signal-chains',
    'layer-violations': 'layer-violations',
    'coding-context': 'coding-context',
    preflight: 'preflight',
    'agent-pack': 'agent-pack',
    health: 'health-code-repo',
    'index-repo': 'index-repo',
    'reindex-repo': 'reindex-repo',
    dupes: 'dupes',
    'audit-diff': 'audit-diff',
    'enrich-symbols': 'enrich-symbols',
  },
  // Reused verbatim from extensions/memory-layer/tools/doc-tools.ts:64-78.
  DOC_MODE_TO_COMMAND = {
    search: 'doc-search',
    outline: 'doc-outline',
    backlinks: 'backlinks',
    'broken-links': 'broken-links',
    glossary: 'glossary',
    'tutorial-path': 'tutorial-path',
    'code-examples': 'code-examples',
    orphans: 'doc-orphans',
    coverage: 'doc-coverage',
    'stale-pages': 'stale-pages',
    duplicates: 'doc-duplicates',
    'index-docs': 'index-docs',
    'reindex-docs': 'reindex-docs',
  },
  CODE_MODES = Object.keys(CODE_MODE_TO_COMMAND),
  DOC_MODES = Object.keys(DOC_MODE_TO_COMMAND);

// --- small JSON-schema helpers (plain objects — no Zod, per SDK low-level Server) ---

function opt(schema) {
  // Shallow-clone + mark optional by removing from any required list.
  // Required/optional is encoded at the Object() level, not the field level.
  return { ...schema };
}

function str(desc) {
  return { type: 'string', description: desc };
}

function strEnum(desc, values) {
  return { type: 'string', description: desc, enum: values };
}

function num(desc) {
  return { type: 'number', description: desc };
}

function bool(desc) {
  return { type: 'boolean', description: desc };
}

/**
 * Build a JSON schema object. `required` is derived from the optional flag.
 * @param {Record<string, {schema: object, optional?: boolean}>} fields
 */
function obj(fields) {
  const properties = {},
    required = [],
  schema = (() => {

    for (const [name, def] of Object.entries(fields)) {
      properties[name] = def.schema;
      if (!def.optional) {
        required.push(name);
      }
    }
    
  return ({ type: 'object', properties });
})();if (required.length > 0) {
    schema.required = required;
  }
  return schema;
}

// --- arg normalization helpers ---
// These mirror the param→dispatch-arg logic in code-tools.ts:139-213 and
// Doc-tools.ts:94-136. Centralizing here keeps the catalog self-contained.

function setIfPresent(args, key, value) {
  if (value === undefined || value === null || value === '') {
    return;
  }
  args[key] = String(value);
}

/**
 * Convert a snake_case param name to the kebab-case arg key used by dispatch.
 * e.g. "topic_key" → "topic-key", "min_confidence" → "min-confidence".
 */
function kebab(key) {
  return key.replace(/_/g, '-');
}

module.exports.CODE_MODE_TO_COMMAND = CODE_MODE_TO_COMMAND;
module.exports.DOC_MODE_TO_COMMAND = DOC_MODE_TO_COMMAND;

// --- the catalog ---
// Each entry: { name, description, inputSchema, toCommand(params, ctx) }
// ToCommand returns { cmd, args } ready for gateway.dispatch.
// `ctx` carries project (derived from cwd by the server) and is injected
// Into memory tools that need it, matching the Pi extension's use of
// State.currentProject.

const tools = [
  // ============ memory-save ============
  {
    name: 'memory-save',
    description:
      'Save persistent memory; checks duplicates. Use What/Why/Where/Learned content. ' +
      'Types: decision, bugfix, architecture, pattern, discovery, config, preference, learning, manual.',
    inputSchema: obj({
      title: { schema: str('Short searchable title') },
      content: { schema: str('What/Why/Where/Learned content') },
      type: {
        schema: opt(
          strEnum('Memory type', [
            'decision',
            'bugfix',
            'architecture',
            'pattern',
            'discovery',
            'config',
            'preference',
            'learning',
            'manual',
          ]),
        ),
        optional: true,
      },
      scope: { schema: opt(strEnum('project|personal', ['project', 'personal'])), optional: true },
      topic_key: { schema: opt(str('Optional topic key')), optional: true },
      force: { schema: opt(bool('Bypass duplicate warning')), optional: true },
      expires_in: {
        schema: opt(
          str('Optional TTL duration (e.g., "7d", "2w", "1m", "12h"). Memory auto-expires after this period.'),
        ),
        optional: true,
      },
    }),
    toCommand(p, ctx) {
      const args = {
        title: p.title,
        content: p.content,
        type: p.type || 'manual',
        project: ctx.project || 'unknown',
        scope: p.scope || 'project',
      };
      if (p.topic_key) {
        args[kebab('topic_key')] = p.topic_key;
      }
      if (p.force) {
        args.force = 'true';
      }
      if (p.expires_in) {
        args[kebab('expires_in')] = p.expires_in;
      }
      return { cmd: 'save', args };
    },
  },

  // ============ memory-search ============
  {
    name: 'memory-search',
    description: 'Search persistent memory for decisions, bugfixes, patterns, and discoveries.',
    inputSchema: obj({
      query: { schema: str('Search query') },
      type: { schema: opt(str('Optional type filter')), optional: true },
      scope: { schema: opt(strEnum('project|personal', ['project', 'personal'])), optional: true },
      limit: { schema: opt(num('Max results')), optional: true },
    }),
    toCommand(p, ctx) {
      const args = { query: p.query, project: ctx.project || 'unknown' };
      setIfPresent(args, 'type', p.type);
      setIfPresent(args, 'scope', p.scope);
      setIfPresent(args, 'limit', p.limit);
      return { cmd: 'search', args };
    },
  },

  // ============ memory-get ============
  {
    name: 'memory-get',
    description: 'Get full memory details by ID.',
    inputSchema: obj({
      id: { schema: num('Memory ID') },
      allow_cross_project: {
        schema: opt(bool('Return full content even when the memory belongs to a different project.')),
        optional: true,
      },
    }),
    toCommand(p) {
      const args = { id: String(p.id) };
      if (p.allow_cross_project) {
        args[kebab('allow_cross_project')] = 'true';
      }
      return { cmd: 'get', args };
    },
  },

  // ============ memory-update ============
  {
    name: 'memory-update',
    description: 'Update an existing memory in place by ID.',
    inputSchema: obj({
      id: { schema: num('Memory ID') },
      title: { schema: opt(str('New title')), optional: true },
      content: { schema: opt(str('New content')), optional: true },
      type: { schema: opt(str('New type')), optional: true },
      scope: { schema: opt(str('New scope')), optional: true },
      topic_key: { schema: opt(str('New topic key')), optional: true },
      expires_in: {
        schema: opt(str('Set or change TTL duration (e.g., "7d", "2w", "1m", "12h"). Replaces any existing expiry.')),
        optional: true,
      },
      clear_expiry: { schema: opt(bool('Remove any existing expiry (make memory permanent).')), optional: true },
    }),
    toCommand(p) {
      const args = { id: String(p.id) };
      setIfPresent(args, 'title', p.title);
      setIfPresent(args, 'content', p.content);
      setIfPresent(args, 'type', p.type);
      setIfPresent(args, 'scope', p.scope);
      if (p.topic_key) {
        args[kebab('topic_key')] = p.topic_key;
      }
      if (p.expires_in) {
        args[kebab('expires_in')] = p.expires_in;
      }
      if (p.clear_expiry) {
        args[kebab('clear_expiry')] = 'true';
      }
      return { cmd: 'update', args };
    },
  },

  // ============ memory-delete ============
  {
    name: 'memory-delete',
    description: 'Soft-delete a stale, incorrect, or duplicate memory.',
    inputSchema: obj({
      id: { schema: num('Memory ID') },
    }),
    toCommand(p) {
      return { cmd: 'delete', args: { id: String(p.id) } };
    },
  },

  // ============ memory-related ============
  {
    name: 'memory-related',
    description: 'Find memories linked to the same code symbols.',
    inputSchema: obj({
      id: { schema: num('Memory ID') },
    }),
    toCommand(p) {
      return { cmd: 'related', args: { id: String(p.id) } };
    },
  },

  // ============ memory-load-context ============
  {
    name: 'memory-load-context',
    description: 'Load deeper memory context for a topic.',
    inputSchema: obj({
      query: { schema: str('Topic or keyword') },
      deep: { schema: opt(bool('More results')), optional: true },
      token_budget: { schema: opt(num('Max tokens to use (default: 2000)')), optional: true },
    }),
    toCommand(p, ctx) {
      const tokenBudget = p.token_budget || 2000,
        args = {
          project: ctx.project || 'unknown',
          query: p.query,
          limit: '50',
          [kebab('token_budget')]: String(tokenBudget),
          deep: p.deep ? 'true' : 'false',
        };
      return { cmd: 'context', args };
    },
  },

  // ============ memory-code ============
  {
    name: 'memory-code',
    description:
      'Query indexed code and before-coding agent context. Use mode search, coding-context, ' +
      'preflight, agent-pack, outline, callers, callees, deps, health, index-repo, or reindex-repo. ' +
      'Include repo when known; if omitted, LaPis infers the current indexed repo when possible.',
    inputSchema: obj({
      mode: { schema: opt(strEnum('Analysis mode', CODE_MODES)), optional: true },
      repo: { schema: opt(str('Indexed repo name')), optional: true },
      symbol: { schema: opt(str('Symbol name')), optional: true },
      query: { schema: opt(str('Search query')), optional: true },
      task: { schema: opt(str('Agent task for preflight or agent-pack')), optional: true },
      file: { schema: opt(str('File path')), optional: true },
      depth: { schema: opt(num('Depth 1-5')), optional: true },
      direction: { schema: opt(str('imports|importers|both')), optional: true },
      min_confidence: { schema: opt(num('Min confidence')), optional: true },
      days: { schema: opt(num('Lookback days')), optional: true },
      refresh: { schema: opt(bool('Refresh cache')), optional: true },
      top: { schema: opt(num('Max results')), optional: true },
      scope: { schema: opt(str('Subdirectory scope')), optional: true },
      sort_by: { schema: opt(str('instability|afferent|efferent')), optional: true },
      min_complexity: { schema: opt(num('Min complexity')), optional: true },
      min_callers: { schema: opt(num('Min caller files')), optional: true },
      direction_hier: { schema: opt(str('both|ancestors|descendants')), optional: true },
      kind: { schema: opt(str('Gateway kind')), optional: true },
      symbol_chain: { schema: opt(str('Signal-chain symbol')), optional: true },
      path: { schema: opt(str('Local repo path (index-repo/reindex-repo)')), optional: true },
      name: { schema: opt(str('Repo name (index-repo/reindex-repo)')), optional: true },
      rules: { schema: opt(str('Layer rules JSON')), optional: true },
      files: { schema: opt(str('Comma-separated list of files (audit-diff)')), optional: true },
    }),
    toCommand(p) {
      const mode = p.mode,
      cmd = !(!mode || !CODE_MODE_TO_COMMAND[mode]) ? (CODE_MODE_TO_COMMAND[mode]) : undefined,
      args = !(!mode || !CODE_MODE_TO_COMMAND[mode]) ? ({}) : undefined;
      if (!mode || !CODE_MODE_TO_COMMAND[mode]) {
        return { cmd: null, error: !mode ? 'memory-code requires a mode.' : `Unknown memory-code mode: ${mode}` };
      }
      setIfPresent(args, 'repo', p.repo);
      setIfPresent(args, 'symbol', p.symbol);
      if (p.query || (mode === 'search' && p.symbol)) {
        args.query = String(p.query || p.symbol);
      }
      if (p.task || ((mode === 'preflight' || mode === 'agent-pack') && p.query)) {
        args.task = String(p.task || p.query);
      }
      setIfPresent(args, 'file', p.file);
      if (p.depth) {
        args.depth = String(p.depth);
      }
      // Callers/callees map to call-hierarchy with explicit direction
      if (cmd === 'call-hierarchy') {
        args.direction = mode === 'callers' ? 'callers' : 'callees';
      } else if (p.direction) {
        args.direction = p.direction;
      }
      if (p.min_confidence) {
        args[kebab('min_confidence')] = String(p.min_confidence);
      }
      setIfPresent(args, 'days', p.days);
      if (p.refresh) {
        args.refresh = 'true';
      }
      const top = p.top || (cmd === 'search-code' ? 5 : null);
      if (top) {
        if (cmd === 'search-code') {
          args[kebab('max_results')] = String(top);
        } else {
          args.top = String(top);
        }
      }
      setIfPresent(args, 'scope', p.scope);
      if (p.sort_by) {
        args[kebab('sort_by')] = p.sort_by;
      }
      if (p.min_complexity) {
        args[kebab('min_complexity')] = String(p.min_complexity);
      }
      if (p.min_callers) {
        args[kebab('min_callers')] = String(p.min_callers);
      }
      if (p.direction_hier) {
        args.direction = p.direction_hier;
      }
      setIfPresent(args, 'kind', p.kind);
      if (p.symbol_chain) {
        args.symbol = String(p.symbol_chain);
      }
      setIfPresent(args, 'path', p.path);
      setIfPresent(args, 'name', p.name);
      if (p.rules) {
        args.rules = typeof p.rules === 'string' ? p.rules : JSON.stringify(p.rules);
      }
      setIfPresent(args, 'files', p.files);
      return { cmd, args };
    },
  },

  // ============ memory-doc ============
  {
    name: 'memory-doc',
    description: 'Query indexed docs. Use mode search, outline, backlinks, coverage, index-docs, or reindex-docs.',
    inputSchema: obj({
      mode: { schema: opt(strEnum('Query mode', DOC_MODES)), optional: true },
      repo: { schema: opt(str('Indexed doc repo name')), optional: true },
      query: { schema: opt(str('Search query')), optional: true },
      file: { schema: opt(str('Doc file path')), optional: true },
      doc_path: { schema: opt(str('Doc path for backlinks')), optional: true },
      term: { schema: opt(str('Glossary term')), optional: true },
      section: { schema: opt(num('Section ID')), optional: true },
      level: { schema: opt(num('Heading level')), optional: true },
      role: { schema: opt(str('Doc role')), optional: true },
      lang: { schema: opt(str('Code language')), optional: true },
      include_same_doc: { schema: opt(bool('Include intra-doc links')), optional: true },
      doc_repo: { schema: opt(str('Code repo for coverage')), optional: true },
      path: { schema: opt(str('Local docs path (index-docs/reindex-docs)')), optional: true },
      name: { schema: opt(str('Doc repo name (index-docs/reindex-docs)')), optional: true },
      ignore: { schema: opt(str('Ignore glob')), optional: true },
    }),
    toCommand(p) {
      const mode = p.mode,
      cmd = !(!mode || !DOC_MODE_TO_COMMAND[mode]) ? (DOC_MODE_TO_COMMAND[mode]) : undefined,
      args = !(!mode || !DOC_MODE_TO_COMMAND[mode]) ? ({}) : undefined;
      if (!mode || !DOC_MODE_TO_COMMAND[mode]) {
        return { cmd: null, error: !mode ? 'memory-doc requires a mode.' : `Unknown memory-doc mode: ${mode}` };
      }
      setIfPresent(args, 'repo', p.repo);
      setIfPresent(args, 'query', p.query);
      setIfPresent(args, 'file', p.file);
      if (p.doc_path) {
        args.path = p.doc_path;
      }
      setIfPresent(args, 'term', p.term);
      if (p.section) {
        args.section = String(p.section);
      }
      if (p.level) {
        args.level = String(p.level);
      }
      setIfPresent(args, 'role', p.role);
      setIfPresent(args, 'lang', p.lang);
      if (p.include_same_doc) {
        args[kebab('include_same_doc')] = 'true';
      }
      if (p.doc_repo) {
        args[kebab('doc_repo')] = p.doc_repo;
      }
      setIfPresent(args, 'path', p.path);
      setIfPresent(args, 'name', p.name);
      setIfPresent(args, 'ignore', p.ignore);
      return { cmd, args };
    },
  },

  // ============ memory-sync-code-trust ============
  {
    name: 'memory-sync-code-trust',
    description: 'Sync memory trust scores with changed code after pull, checkout, merge, or rebase.',
    inputSchema: obj({
      repo: { schema: str('Indexed repo name') },
    }),
    toCommand(p) {
      return { cmd: 'sync-code-trust', args: { repo: p.repo } };
    },
  },

  // ============ index-status ============
  {
    name: 'index-status',
    description:
      'Check the progress of an async code-indexing job. Returns job state, file progress, ' +
      'current file, and language breakdown.',
    inputSchema: obj({
      job: { schema: str('Job ID returned by index-repo-async') },
    }),
    toCommand(p) {
      return { cmd: 'index-status', args: { job: String(p.job) } };
    },
  },
];

module.exports.tools = tools;
module.exports.toolByName = Object.fromEntries(tools.map((t) => [t.name, t]));
