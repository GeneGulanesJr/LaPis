// oxlint-disable sort-imports
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { isCodeFile, state } from '../state';
import {
  isPipedOutputFilter,
  isTargetedSymbolLookup,
  isTargetedTextFileLookup,
  CONFIG_FILENAMES,
  RAW_CODE_DISCOVERY_RE,
  CODE_PATH_HINT_RE,
} from './guardrail-utils';
import { getKnownRepos, invalidateRepoCache } from '../host/project-detector';
import { memStreaming } from '../host/memory-client';
import path from 'node:path';

interface GuardrailsDeps {
  state: typeof state;
  getKnownRepos: typeof getKnownRepos;
  isCodeFile: typeof isCodeFile;
  memStreaming: typeof memStreaming;
  invalidateRepoCache: typeof invalidateRepoCache;
  getConfig: () => { tool_guardrails?: { enabled?: boolean } };
}

interface IndexResult {
  ok: boolean;
  summary: string;
}

const activeIndexing = new Map<string, Promise<IndexResult | null>>();

function ensureIndexed(deps: GuardrailsDeps, resolvedCwd: string, projectName: string): Promise<IndexResult | null> {
  const key = resolvedCwd;
  const pending = activeIndexing.get(key);
  if (pending) {
    return pending;
  }
  const promise = (async (): Promise<IndexResult | null> => {
    try {
      const result = await deps.memStreaming('index-repo', { path: resolvedCwd, name: projectName });
      if (!result) {
        return null;
      }
      if (result.error) {
        return { ok: false, summary: `Indexing error: ${result.error}` };
      }
      deps.invalidateRepoCache();
      const summary = (result as any).summary || '';
      return { ok: true, summary };
    } catch (e) {
      return { ok: false, summary: `Indexing failed: ${e instanceof Error ? e.message : String(e)}` };
    } finally {
      activeIndexing.delete(key);
    }
  })();
  activeIndexing.set(key, promise);
  return promise;
}

export function registerToolGuardrails(pi: ExtensionAPI, deps: GuardrailsDeps) {
  pi.on('tool_call', async (event, _ctx) => {
    // Honor the `tool_guardrails.enabled: false` config toggle
    // (see ~/.pi/memory/config.jsonc). When disabled, the raw grep/find
    // and unread-file guardrails are skipped entirely so raw repository
    // search and direct file reads work without the memory-code redirect.
    // Tests and other callers that don't inject getConfig default to enabled.
    if (deps.getConfig?.().tool_guardrails?.enabled === false) {
      return;
    }

    const toolName = event.toolName;
    const input = event.input as Record<string, unknown>;

    if (toolName === 'memory-code') {
      deps.state.lastMemoryToolCall = Date.now();
      deps.state.callsSinceLastMemory = 0;
      const file = String(input?.file || '');
      if (file) {
        deps.state.exploredFiles.add(file.toLowerCase());
        deps.state.exploredFiles.add(path.basename(file).toLowerCase());
      }
      return;
    }
    if (toolName.startsWith('memory-')) {
      deps.state.lastMemoryToolCall = Date.now();
      deps.state.callsSinceLastMemory = 0;
      return;
    }

    if (toolName === 'bash' && typeof input?.command === 'string') {
      const cmd = input.command as string;
      if (RAW_CODE_DISCOVERY_RE.test(cmd)) {
        const repos = await deps.getKnownRepos();
        const resolvedCwd = path.resolve(process.cwd());
        const matchedRepo = repos.find((r) => resolvedCwd.startsWith(path.resolve(r.path)));
        if (matchedRepo) {
          // Allow grep/rg/etc. When they are only filtering another command's stdout,
          // Such as `npx oxlint 2>&1 | grep -i unused`.
          if (isPipedOutputFilter(cmd)) {
            return;
          }

          // Documentation/config lookups scoped to one concrete text file are
          // targeted reads, not broad source discovery (e.g. AGENTS.md).
          if (isTargetedTextFileLookup(cmd)) {
            return;
          }

          // Allow targeted single-symbol lookups through (e.g., grep -rn "rankObservations" src/)
          if (isTargetedSymbolLookup(cmd)) {
            return;
          }

          const searchHint = CODE_PATH_HINT_RE.test(cmd) ? 'Code search' : 'Raw repository search';
          return {
            block: true,
            reason:
              `${searchHint} detected in indexed repo "${matchedRepo.name}". Use \`memory-code\` instead:\n` +
              `• \`memory-code search --repo ${matchedRepo.name} --query <query>\` — find code symbols\n` +
              `• \`memory-code outline --repo ${matchedRepo.name} --file <path>\` — file structure\n` +
              `• \`memory-code callers --repo ${matchedRepo.name} --symbol <name>\` — call hierarchy\n` +
              `• \`memory-code deps --repo ${matchedRepo.name}\` — dependency graph\n` +
              `• \`memory-code importance --repo ${matchedRepo.name}\` — hotspots & churn`,
          };
        }
        const projectName = deps.state.currentProject || path.basename(resolvedCwd);
        const searchHint = CODE_PATH_HINT_RE.test(cmd) ? 'Code search' : 'Raw repository search';
        const indexResult = await ensureIndexed(deps, resolvedCwd, projectName);
        if (indexResult?.ok) {
          return {
            block: true,
            reason:
              `${searchHint} in an unindexed project. The repo has been auto-indexed (${indexResult.summary}).\n` +
              `Use \`memory-code\` instead of raw grep/find:\n` +
              `• \`memory-code search --repo ${projectName} --query <query>\`\n` +
              `• \`memory-code outline --repo ${projectName} --file <path>\`\n` +
              `• \`memory-code callers --repo ${projectName} --symbol <name>\`\n` +
              `• \`memory-code deps --repo ${projectName}\``,
          };
        }
        return {
          block: true,
          reason:
            `${searchHint} in an unindexed project. Auto-indexing failed: ${indexResult?.summary || 'unknown error'}.\n` +
            `Try indexing manually: \`memory-code index-repo --path ${resolvedCwd} --name ${projectName}\``,
        };
      }
    }

    if (toolName === 'read' && typeof input?.path === 'string') {
      const filePath = input.path as string;

      if (!deps.isCodeFile(filePath)) {
        return;
      }

      if (typeof input.offset === 'number' || typeof input.limit === 'number') {
        return;
      }

      const basename = path.basename(filePath);
      if (CONFIG_FILENAMES.has(basename)) {
        return;
      }

      if (filePath.includes('node_modules')) {
        return;
      }

      const absPath = path.resolve(filePath);

      // ponytail: cross-project reads (files outside cwd) bypass the outline guard
      const cwd = process.cwd();
      if (absPath !== cwd && !absPath.startsWith(cwd + path.sep)) {
        return;
      }

      const repos = await deps.getKnownRepos();
      const matchedRepo = repos.find(
        (r) =>
          absPath.toLowerCase().startsWith(`${r.path.toLowerCase()}/`) ||
          absPath.toLowerCase() === r.path.toLowerCase(),
      );

      if (!matchedRepo) {
        // Prefer cwd (project root) to match the bash guardrail behavior.
        // Fall back to the file's directory only when the file lives outside cwd.
        const projectDir = absPath.startsWith(cwd) ? cwd : path.dirname(absPath);
        const projectName = deps.state.currentProject || path.basename(projectDir);
        const indexResult = await ensureIndexed(deps, projectDir, projectName);
        if (indexResult?.ok) {
          return {
            block: true,
            reason:
              `Cannot read "${path.basename(filePath)}" — project was not indexed. It has been auto-indexed (${indexResult.summary}).\n` +
              `Use \`memory-code\` to understand the file first:\n` +
              `• \`memory-code outline --repo ${projectName} --file ${path.relative(projectDir, absPath)}\`\n` +
              `After reviewing the outline, use \`read\` with \`offset\`/\`limit\` for targeted editing.`,
          };
        }
        return {
          block: true,
          reason:
            `Cannot read "${path.basename(filePath)}" — project auto-indexing failed: ${indexResult?.summary || 'unknown error'}.\n` +
            `Try indexing manually: \`memory-code index-repo --path ${projectDir} --name ${projectName}\``,
        };
      }

      const fileBase = path.basename(filePath).toLowerCase();
      const relPath = path.relative(matchedRepo.path, absPath).toLowerCase();
      if (
        deps.state.exploredFiles.has(fileBase) ||
        deps.state.exploredFiles.has(relPath) ||
        deps.state.exploredFiles.has(absPath.toLowerCase())
      ) {
        return;
      }

      return {
        block: true,
        reason:
          `Use \`memory-code\` first to understand "${path.basename(filePath)}" before reading it:\n` +
          `• \`memory-code outline --repo ${matchedRepo.name} --file ${relPath || path.basename(filePath)}\` — file structure & symbols\n` +
          `• \`memory-code callers --repo ${matchedRepo.name} --symbol <name>\` — who calls what\n` +
          `• \`memory-code deps --repo ${matchedRepo.name}\` — dependency graph\n` +
          `After reviewing the outline, use \`read\` with \`offset\`/\`limit\` for targeted editing.`,
      };
    }
  });

  // Track explored files from memory-code results (callers, deps, importance, etc.)
  pi.on('tool_result', async (event, _ctx) => {
    if (event.toolName !== 'memory-code') {
      return;
    }
    if (!event.result) {
      return;
    }

    const resultText = typeof event.result === 'string' ? event.result : JSON.stringify(event.result);

    // Match relative file paths like "src/foo.ts" or "extensions/memory-layer/hooks/tool-guardrails.ts"
    const filePaths = resultText.match(/[\w/.-]+\.(ts|js|tsx|jsx|mjs|cjs|py|go|rs)/g) || [];
    for (const fp of filePaths) {
      deps.state.exploredFiles.add(fp.toLowerCase());
      const basename = fp.split('/').pop();
      if (basename) {
        deps.state.exploredFiles.add(basename.toLowerCase());
      }
    }
  });
}
