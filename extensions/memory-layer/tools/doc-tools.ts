import { normalizeToolResult, stringifyToolError, toolTextResult } from './tool-result';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from './schema';
import { formatDocResult } from './format-doc-result';
import { getKnownDocRepos } from '../host/project-detector';
import { mem } from '../host/memory-client';
import { renderCompactToolResult } from './render';

interface DocDeps {
  mem: typeof mem;
  getKnownDocRepos: typeof getKnownDocRepos;
  formatDocResult: typeof formatDocResult;
}

export function registerDocTools(pi: ExtensionAPI, deps: DocDeps) {
  pi.registerTool({
    name: 'memory-doc',
    label: 'Doc Index',
    description: 'Query indexed docs. Use mode search, outline, backlinks, coverage, index-docs, or reindex-docs.',
    parameters: Type.Object({
      mode: Type.Optional(
        Type.String({
          description: 'Query mode',
          enum: [
            'search',
            'outline',
            'backlinks',
            'broken-links',
            'glossary',
            'tutorial-path',
            'code-examples',
            'orphans',
            'coverage',
            'stale-pages',
            'duplicates',
            'index-docs',
            'reindex-docs',
          ],
        }),
      ),
      repo: Type.Optional(Type.String({ description: 'Indexed doc repo name' })),
      query: Type.Optional(Type.String({ description: 'Search query' })),
      file: Type.Optional(Type.String({ description: 'Doc file path' })),
      doc_path: Type.Optional(Type.String({ description: 'Doc path for backlinks' })),
      term: Type.Optional(Type.String({ description: 'Glossary term' })),
      section: Type.Optional(Type.Number({ description: 'Section ID' })),
      level: Type.Optional(Type.Number({ description: 'Heading level' })),
      role: Type.Optional(
        Type.String({
          description: 'Doc role',
        }),
      ),
      lang: Type.Optional(Type.String({ description: 'Code language' })),
      include_same_doc: Type.Optional(Type.Boolean({ description: 'Include intra-doc links' })),
      doc_repo: Type.Optional(Type.String({ description: 'Code repo for coverage' })),
      path: Type.Optional(Type.String({ description: 'Local docs path' })),
      name: Type.Optional(Type.String({ description: 'Doc repo name' })),
      ignore: Type.Optional(Type.String({ description: 'Ignore glob' })),
    }),
    renderResult: renderCompactToolResult,
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      params = params ?? {};
      try {
        const cmdMap: Record<string, string> = {
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
        };
        const mode = typeof params.mode === 'string' ? params.mode : '';
        const cmd = mode ? cmdMap[mode] : undefined;
        if (!mode) {
          return toolTextResult(docHelpText());
        }

        if (!cmd) {
          return toolTextResult(`Unknown memory-doc mode: ${mode}\n\n${docHelpText()}`, {}, true);
        }

        {
          const validationError = validateDocParams(mode, params),
            args = !validationError ? {} : undefined;
          if (validationError) {
            return toolTextResult(validationError, {}, true);
          }

          if (params.repo) {
            args.repo = params.repo;
          }
          if (params.query) {
            args.query = params.query;
          }
          if (params.file) {
            args.file = params.file;
          }
          if (params.doc_path) {
            args.path = params.doc_path;
          }
          if (params.term) {
            args.term = params.term;
          }
          if (params.section) {
            args.section = String(params.section);
          }
          if (params.level) {
            args.level = String(params.level);
          }
          if (params.role) {
            args.role = params.role;
          }
          if (params.lang) {
            args.lang = params.lang;
          }
          if (params.include_same_doc) {
            args['include-same-doc'] = 'true';
          }
          if (params.doc_repo) {
            args['doc-repo'] = params.doc_repo;
          }
          if (params.path) {
            args.path = params.path;
          }
          if (params.name) {
            args.name = params.name;
          }
          if (params.ignore) {
            args.ignore = params.ignore;
          }

          if (mode === 'index-docs' || mode === 'reindex-docs') {
            const result = await deps.mem(cmd, args);
            if (!result) {
              return toolTextResult('Doc indexing failed or timed out.', {}, true);
            }
            if (result.error) {
              return toolTextResult(`Error: ${result.error}`, result ?? {}, true);
            }
            let fmt: string | undefined | null;
            try {
              fmt = deps.formatDocResult(mode, result);
            } catch {
              fmt = '';
            }
            return toolTextResult(fmt || 'Doc indexing completed.', result ?? {});
          }

          const docRepos = await deps.getKnownDocRepos(),
            docRepoMatch = docRepos.find((r) => r.name.toLowerCase() === params.repo?.toLowerCase());
          if (!docRepoMatch) {
            const available = docRepos.map((r) => r.name).join(', ') || 'none',
              cwd = process.cwd();
            return normalizeToolResult({
              content: [
                {
                  type: 'text',
                  text: `❌ Doc repo \"${params.repo}\" is not indexed. Available repos: ${available}\n\nTo index these docs, run:\n\`memory-doc index-docs --path ${cwd} --name ${params.repo}\``,
                },
              ],
              details: {},
              isError: true,
            });
          }

          const result = await deps.mem(cmd, args);
          if (!result) {
            return toolTextResult('Doc query failed.', {}, true);
          }
          if (result.error) {
            return toolTextResult(`Error: ${result.error}`, result ?? {}, true);
          }

          let fmt: string | undefined | null;
          try {
            fmt = deps.formatDocResult(mode, result);
          } catch {
            fmt = '';
          }
          return toolTextResult(fmt || `No ${mode} results found.`, result ?? {});
        }
      } catch (err) {
        return toolTextResult(`Unexpected error: ${stringifyToolError(err)}`, {}, true);
      }
    },
  });
}

function docHelpText(): string {
  return [
    'memory-doc requires a mode.',
    '',
    'Examples:',
    '- memory-doc search --repo <repo> --query "getting started"',
    '- memory-doc outline --repo <repo> --file docs/guide.md',
    '- memory-doc reindex-docs --path docs --name <repo>',
    '',
    'Modes: search, outline, backlinks, broken-links, glossary, tutorial-path, code-examples, orphans, coverage, stale-pages, duplicates, index-docs, reindex-docs.',
  ].join('\n');
}

function validateDocParams(mode: string, params: Record<string, any>): string | null {
  if (mode === 'index-docs' && !params.path) {
    return 'index-docs requires --path.\n\nExample:\nmemory-doc index-docs --path docs --name <repo>';
  }

  if (mode === 'reindex-docs' && !params.path && !params.repo) {
    return 'reindex-docs requires --path or --repo.\n\nExamples:\nmemory-doc reindex-docs --path docs --name <repo>\nmemory-doc reindex-docs --repo <repo>';
  }

  if (mode !== 'index-docs' && mode !== 'reindex-docs' && !params.repo) {
    return `${mode} requires --repo.\n\nExample:\nmemory-doc ${mode} --repo <repo>`;
  }

  if (['search', 'code-examples'].includes(mode) && !params.query) {
    return `${mode} requires --query.\n\nExample:\nmemory-doc ${mode} --repo ${params.repo || '<repo>'} --query "getting started"`;
  }

  if (mode === 'backlinks' && !params.doc_path) {
    return 'backlinks requires --doc-path.\n\nExample:\nmemory-doc backlinks --repo <repo> --doc-path docs/guide.md';
  }

  return null;
}
