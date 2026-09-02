import { mem, memStreaming } from '../host/memory-client';
import { normalizeToolResult, stringifyToolError, toolProgressResult, toolTextResult } from './tool-result';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from './schema';
import { formatCodeResult } from './format-code-result';
import { getKnownRepos } from '../host/project-detector';
import path from 'node:path';
import { renderCompactToolResult } from './render';

interface CodeDeps {
  mem: typeof mem;
  memStreaming: typeof memStreaming;
  getKnownRepos: typeof getKnownRepos;
  formatCodeResult: typeof formatCodeResult;
  invalidateRepoCache: () => void;
}

export function registerCodeTools(pi: ExtensionAPI, deps: CodeDeps) {
  pi.registerTool({
    name: 'memory-code',
    label: 'Code Analysis',
    description:
      'Query indexed code and before-coding agent context. Use mode search, coding-context, preflight, agent-pack, outline, callers, callees, deps, health, index-repo, or reindex-repo. Include repo when known; if omitted, LaPis infers the current indexed repo when possible.',
    parameters: Type.Object({
      mode: Type.Optional(
        Type.String({
          description: 'Analysis mode',
          enum: [
            'search',
            'callers',
            'callees',
            'blast-radius',
            'dead-code',
            'complexity',
            'deps',
            'outline',
            'churn',
            'hotspots',
            'cycles',
            'importance',
            'coupling',
            'extractable',
            'hierarchy',
            'signal-chains',
            'layer-violations',
            'coding-context',
            'preflight',
            'agent-pack',
            'health',
            'index-repo',
            'reindex-repo',
            'dupes',
            'audit-diff',
            'enrich-symbols',
          ],
        }),
      ),
      repo: Type.Optional(Type.String({ description: 'Indexed repo name' })),
      symbol: Type.Optional(
        Type.String({
          description: 'Symbol name',
        }),
      ),
      query: Type.Optional(Type.String({ description: 'Search query' })),
      task: Type.Optional(Type.String({ description: 'Agent task for preflight or agent-pack' })),
      file: Type.Optional(Type.String({ description: 'File path' })),
      depth: Type.Optional(Type.Number({ description: 'Depth 1-5', default: 3 })),
      direction: Type.Optional(Type.String({ description: 'imports|importers|both', default: 'both' })),
      min_confidence: Type.Optional(Type.Number({ description: 'Min confidence', default: 0.5 })),
      days: Type.Optional(Type.Number({ description: 'Lookback days', default: 90 })),
      refresh: Type.Optional(Type.Boolean({ description: 'Refresh cache', default: false })),
      top: Type.Optional(Type.Number({ description: 'Max results', default: 5 })),
      scope: Type.Optional(Type.String({ description: 'Subdirectory scope' })),
      sort_by: Type.Optional(Type.String({ description: 'instability|afferent|efferent', default: 'instability' })),
      min_complexity: Type.Optional(Type.Number({ description: 'Min complexity', default: 5 })),
      min_callers: Type.Optional(Type.Number({ description: 'Min caller files', default: 2 })),
      direction_hier: Type.Optional(Type.String({ description: 'both|ancestors|descendants', default: 'both' })),
      kind: Type.Optional(Type.String({ description: 'Gateway kind' })),
      symbol_chain: Type.Optional(Type.String({ description: 'Signal-chain symbol' })),
      path: Type.Optional(Type.String({ description: 'Local repo path' })),
      name: Type.Optional(Type.String({ description: 'Repo name' })),
      rules: Type.Optional(Type.String({ description: 'Layer rules JSON' })),
      files: Type.Optional(Type.String({ description: 'Comma-separated list of files (audit-diff)' })),
    }),
    renderResult: renderCompactToolResult,
    async execute(_id, params, _signal, onUpdate, ctx) {
      params = params ?? {};
      try {
        const cmdMap: Record<string, string> = {
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
          mode = typeof params.mode === 'string' ? params.mode : '',
          cmd = mode ? cmdMap[mode] : undefined;
        if (!mode) {
          return toolTextResult(codeHelpText());
        }

        if (!cmd) {
          return toolTextResult(`Unknown memory-code mode: ${mode}\n\n${codeHelpText()}`, {}, true);
        }

        {
          const codeRepos =
              mode === 'index-repo' || mode === 'reindex-repo' || mode === 'health' ? [] : await deps.getKnownRepos(),
            inferredRepo = inferCurrentRepo(params, codeRepos, process.cwd()),
            validationError = (() => {
              if (inferredRepo) {
                params = { ...params, repo: inferredRepo };
              }

              return validateCodeParams(mode, params);
            })();
          if (validationError) {
            return toolTextResult(validationError, {}, true);
          }

          {
            const args: Record<string, string> = {},
              top = (() => {
                if (params.repo) {
                  args.repo = params.repo;
                }
                if (params.symbol) {
                  args.symbol = params.symbol;
                }
                if (params.query || (mode === 'search' && params.symbol)) {
                  args.query = String(params.query || params.symbol);
                }
                if (params.task || ((mode === 'preflight' || mode === 'agent-pack') && params.query)) {
                  args.task = String(params.task || params.query);
                }
                if (params.file) {
                  args.file = params.file;
                }
                if (params.depth) {
                  args.depth = String(params.depth);
                }
                if (params.direction) {
                  args.direction = params.direction;
                }
                if (cmd === 'call-hierarchy') {
                  args.direction = mode === 'callers' ? 'callers' : 'callees';
                }
                if (params.min_confidence) {
                  args['min-confidence'] = String(params.min_confidence);
                }
                if (params.days) {
                  args.days = String(params.days);
                }
                if (params.refresh) {
                  args.refresh = 'true';
                }

                return params.top || (cmd === 'search-code' ? 5 : null);
              })();
            if (top) {
              if (cmd === 'search-code') {
                args['max-results'] = String(top);
              } else {
                args.top = String(top);
              }
            }
            if (params.scope) {
              args.scope = params.scope;
            }
            if (params.sort_by) {
              args['sort-by'] = params.sort_by;
            }
            if (params.min_complexity) {
              args['min-complexity'] = String(params.min_complexity);
            }
            if (params.min_callers) {
              args['min-callers'] = String(params.min_callers);
            }
            if (params.direction_hier) {
              args.direction = params.direction_hier;
            }
            if (params.kind) {
              args.kind = params.kind;
            }
            if (params.symbol_chain) {
              args.symbol = String(params.symbol_chain);
            }
            if (params.path) {
              args.path = params.path;
            }
            if (params.name) {
              args.name = params.name;
            }
            if (params.rules) {
              args.rules = typeof params.rules === 'string' ? params.rules : JSON.stringify(params.rules);
            }
            if (params.files) {
              args.files = params.files;
            }

            if (mode === 'index-repo' || mode === 'reindex-repo') {
              const ui = (ctx as any)?.ui,
                result = await deps.memStreaming(cmd, args, (msg: string) => {
                  try {
                    onUpdate(toolProgressResult(msg, { progress: true }));
                  } catch {}
                  if (ui?.setStatus) {
                    try {
                      ui.setStatus('memory-index', `📦 ${msg}`);
                    } catch {}
                  }
                });
              if (ui?.setStatus) {
                try {
                  if (ui.clearStatus) {
                    ui.clearStatus('memory-index');
                  } else {
                    ui.setStatus('memory-index', '');
                  }
                } catch {}
              }
              if (!result) {
                return toolTextResult('Indexing failed or timed out.', {}, true);
              }
              if (result.error) {
                return toolTextResult(`Error: ${result.error}`, result ?? {}, true);
              }
              // Invalidate repo cache so guardrails immediately recognize the new/updated repo
              deps.invalidateRepoCache();
              const response = buildCodeToolResponse(mode, result ?? {});
              let fmt: string | undefined | null;
              try {
                fmt = deps.formatCodeResult(mode, response.formatPayload);
              } catch {
                fmt = '';
              }
              return toolTextResult(fmt || 'Indexing completed.', response.details);
            }

            if (mode === 'health') {
              const result = await deps.mem(cmd, args);
              if (!result) {
                return toolTextResult('Index health check failed.', {}, true);
              }
              if (result.error) {
                return toolTextResult(`Error: ${result.error}`, result ?? {}, true);
              }
              return toolTextResult(formatHealthResult(result), result ?? {});
            }

            const repoMatch = codeRepos.find((r) => r.name.toLowerCase() === params.repo?.toLowerCase());
            if (!repoMatch) {
              const available = codeRepos.map((r) => r.name).join(', ') || 'none',
                cwd = process.cwd();
              return normalizeToolResult({
                content: [
                  {
                    type: 'text',
                    text: `❌ Repo \"${params.repo}\" is not indexed. Available repos: ${available}\n\nTo index this repo, run:\n\`memory-code index-repo --path ${cwd} --name ${params.repo}\``,
                  },
                ],
                details: {},
                isError: true,
              });
            }

            const result = await deps.mem(cmd, args);
            if (!result) {
              if (
                cmd === 'dead-code' ||
                cmd === 'cycles' ||
                cmd === 'importance' ||
                cmd === 'coupling' ||
                cmd === 'signal-chains' ||
                cmd === 'import-graph'
              ) {
                return normalizeToolResult({
                  content: [
                    {
                      type: 'text',
                      text: `Analysis timed out or failed for \"${mode}\". Try reducing scope or depth, or re-index the repo.\nCommand: ${cmd} on repo \"${params.repo}\"`,
                    },
                  ],
                  details: {},
                  isError: true,
                });
              }
              return toolTextResult('Analysis failed.', {}, true);
            }
            if (result.error) {
              return toolTextResult(`Error: ${result.error}`, result ?? {}, true);
            }

            const response = buildCodeToolResponse(mode, result ?? {});
            let fmt: string | undefined | null;
            try {
              fmt = deps.formatCodeResult(mode, response.formatPayload);
            } catch {
              fmt = '';
            }
            return toolTextResult(fmt || `No ${mode} results found.`, response.details);
          }
        }
      } catch (err) {
        return toolTextResult(`Unexpected error: ${stringifyToolError(err)}`, {}, true);
      }
    },
  });
}

function inferCurrentRepo(params: Record<string, any>, repos: Array<{ name: string; path?: string }>, cwd: string) {
  if (params.repo || !Array.isArray(repos) || repos.length === 0) {
    return null;
  }

  const resolvedCwd = path.resolve(cwd).toLowerCase(),
    cwdMatch = repos.find((repo) => {
      if (!repo.path) {
        return false;
      }
      const repoPath = path.resolve(repo.path).toLowerCase();
      return resolvedCwd === repoPath || resolvedCwd.startsWith(`${repoPath}/`);
    });
  if (cwdMatch) {
    return cwdMatch.name;
  }

  return repos.length === 1 ? repos[0].name : null;
}

function buildCodeToolResponse(mode: string, result: any): { formatPayload: any; details: Record<string, unknown> } {
  const payload = unwrapCodeResultData(result),
    compactPayload = compactCodeToolPayload(mode, payload),
    meta =
      result && typeof result === 'object' && result._meta && typeof result._meta === 'object' ? result._meta : null;
  return {
    formatPayload: compactPayload,
    details: meta ? { _meta: meta, data: compactPayload } : compactPayload,
  };
}

function unwrapCodeResultData(result: any): any {
  if (result && typeof result === 'object' && result.data && typeof result.data === 'object') {
    return result.data;
  }
  return result;
}

function compactCodeToolPayload(mode: string, result: any): Record<string, unknown> {
  if (mode !== 'outline' || !result || typeof result !== 'object') {
    return result && typeof result === 'object' ? result : {};
  }

  return compactOutlinePayload(result);
}

function compactOutlinePayload(result: any): Record<string, unknown> {
  if (!result || typeof result !== 'object') {
    return result && typeof result === 'object' ? result : {};
  }

  if (result.directory) {
    const files = Array.isArray(result.files) ? result.files.slice(0, 25) : [];
    return {
      ...result,
      files,
      truncated: Boolean(result.truncated || (Array.isArray(result.files) && result.files.length > files.length)),
    };
  }

  const classes = Array.isArray(result.classes)
      ? result.classes.slice(0, 20).map((cls: any) => ({
          ...cls,
          methods: Array.isArray(cls.methods) ? cls.methods.slice(0, 25) : [],
        }))
      : [],
    standalone = Array.isArray(result.standalone) ? result.standalone.slice(0, 80) : [];

  return {
    ...result,
    classes,
    standalone,
    truncated:
      (Array.isArray(result.classes) && result.classes.length > classes.length) ||
      (Array.isArray(result.standalone) && result.standalone.length > standalone.length) ||
      classes.some((cls: any, index: number) => {
        const original = result.classes[index];
        return Array.isArray(original?.methods) && original.methods.length > cls.methods.length;
      }),
  };
}

function codeHelpText(): string {
  return [
    'memory-code requires a mode.',
    '',
    'Examples:',
    '- memory-code outline --repo <repo> --file src/foo.ts',
    '- memory-code search --repo <repo> --query "context command return fields"',
    '- memory-code callers --repo <repo> --symbol MyClass.method',
    '- memory-code coding-context --repo <repo> --symbol saveNotificationPreferences',
    '- memory-code preflight --repo <repo> --task "add notification preferences"',
    '- memory-code agent-pack --repo <repo> --task "add notification preferences"',
    '- memory-code reindex-repo --path . --name <repo>',
    '',
    'Modes: search, callers, callees, blast-radius, dead-code, complexity, deps, outline, churn, hotspots, cycles, importance, coupling, extractable, hierarchy, signal-chains, layer-violations, coding-context, preflight, agent-pack, health, index-repo, reindex-repo, dupes, audit-diff, enrich-symbols.',
  ].join('\n');
}

function formatHealthResult(result: any): string {
  const diagnostics = result.diagnostics || {},
    lines = [
      `# Index Health: ${result.repo}`,
      '',
      `Score: ${result.health_score}`,
      `Indexed: ${result.indexed_files} files, ${result.indexed_symbols} symbols`,
      `Fresh: ${result.stale ? 'no' : 'yes'}`,
    ];
  if (result.scan) {
    const delta = result.scan.indexed_file_delta;
    lines.push(
      `Discovered: ${result.scan.parseable_files_found} parseable files (${delta >= 0 ? '+' : ''}${delta} vs indexed)`,
    );
  }
  lines.push(
    `Diagnostics: ok=${diagnostics.ok || 0}, zero_symbols=${diagnostics.zero_symbols || 0}, error=${diagnostics.error || 0}`,
  );
  if ((result.recommendations || []).length) {
    lines.push('', 'Recommendations:', ...(result.recommendations || []).map((r: string) => `- ${r}`));
  }
  return lines.join('\n');
}

function validateCodeParams(mode: string, params: Record<string, any>): string | null {
  if (mode === 'index-repo' && !params.path) {
    return 'index-repo requires --path.\n\nExample:\nmemory-code index-repo --path . --name <repo>';
  }

  if (mode === 'reindex-repo' && !params.path && !params.repo) {
    return 'reindex-repo requires --path or --repo.\n\nExamples:\nmemory-code reindex-repo --path . --name <repo>\nmemory-code reindex-repo --repo <repo>';
  }

  if (mode !== 'index-repo' && mode !== 'reindex-repo' && !params.repo) {
    return `${mode} requires --repo.\n\nExample:\nmemory-code ${mode} --repo <repo>`;
  }

  if (mode === 'search' && !params.query && !params.symbol) {
    return 'search requires --query.\n\nExample:\nmemory-code search --repo <repo> --query "context command"';
  }

  if ((mode === 'preflight' || mode === 'agent-pack') && !params.task && !params.query) {
    return `${mode} requires --task.\n\nExample:\nmemory-code ${mode} --repo ${params.repo || '<repo>'} --task "add notification preferences"`;
  }

  if (['callers', 'callees', 'blast-radius', 'complexity'].includes(mode) && !params.symbol) {
    return `${mode} requires --symbol.\n\nExample:\nmemory-code ${mode} --repo ${params.repo || '<repo>'} --symbol <symbol>`;
  }

  if (mode === 'coding-context' && !params.symbol && !params.file) {
    return `coding-context requires --symbol or --file.\n\nExample:\nmemory-code coding-context --repo ${params.repo || '<repo>'} --symbol <symbol>`;
  }

  if (['outline', 'churn'].includes(mode) && !params.file) {
    return `${mode} requires --file.\n\nExample:\nmemory-code ${mode} --repo ${params.repo || '<repo>'} --file src/foo.ts`;
  }

  if (mode === 'audit-diff' && !params.files) {
    return `audit-diff requires --files.\n\nExample:\nmemory-code audit-diff --repo ${params.repo || '<repo>'} --files src/a.ts,src/b.ts`;
  }

  return null;
}
