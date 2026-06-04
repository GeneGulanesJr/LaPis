import { MEMORY_REMINDER_INTERVAL, MemResult, state } from '../state';
import { getKnownRepos, isRepoStale } from '../host/project-detector';
import { CONTEXT } from '../../../constants';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import fs from 'node:fs';
import { mem } from '../host/memory-client';
import path from 'node:path';

interface ContextDeps {
  state: typeof state;
  mem: typeof mem;
  getKnownRepos: typeof getKnownRepos;
  isRepoStale: typeof isRepoStale;
  getSettings?: () => { contextLimit?: number };
}

export function registerBeforeAgentStart(pi: ExtensionAPI, deps: ContextDeps) {
  pi.on('before_agent_start', async (event, ctx) => {
    if (!deps.state.currentProject) {
      return;
    }

    const promptQuery = extractUserPrompt(event);
    if (isSourceAuthoritativePrompt(promptQuery)) {
      const repos = await deps.getKnownRepos();
      const guidance = buildSourceLookupGuidance(repos, ctx.cwd, deps.state.currentProject);
      if (guidance) {
        return {
          message: {
            customType: 'memory-code-guidance',
            content: guidance,
            display: false,
          },
        };
      }
      return;
    }

    const defaultContextLimit = promptQuery ? CONTEXT.PROMPT_RELEVANT_LIMIT : CONTEXT.PROJECT_SUMMARY_LIMIT;
    const configuredContextLimit = Number(deps.getSettings?.()?.contextLimit);
    const contextLimit =
      Number.isFinite(configuredContextLimit) && configuredContextLimit > 0
        ? Math.floor(configuredContextLimit)
        : defaultContextLimit;
    const contextResult = await deps.mem('context', {
      project: deps.state.currentProject,
      limit: String(contextLimit),
      'token-budget': String(CONTEXT.TOKEN_BUDGET_DEFAULT || 2000),
      ...(promptQuery ? { query: promptQuery } : {}),
      ...(deps.state.sessionId ? { 'session-id': String(deps.state.sessionId) } : {}),
    });

    let crossProjectResult: MemResult | null = null;
    const projectContext = contextResult;
    if (!projectContext) {
      crossProjectResult = await deps.mem('context', {
        'all-projects': 'true',
        limit: String(CONTEXT.PROJECT_SUMMARY_LIMIT),
        'token-budget': String(CONTEXT.TOKEN_BUDGET_DEFAULT || 2000),
        ...(deps.state.sessionId ? { 'session-id': String(deps.state.sessionId) } : {}),
      });
    }

    if (!projectContext && !crossProjectResult) {
      return {
        message: {
          customType: 'memory-context',
          content: '⚠️ Memory context failed to load. Use `memory-search` and `memory-save` manually.',
          display: true,
        },
      };
    }

    const effectiveContext = projectContext || crossProjectResult;

    const observations =
      (effectiveContext.observations as Array<{
        id: number;
        title: string;
        type: string;
        scope: string;
        topic_key: string;
        trust_score: number;
        type_priority: number;
        content?: string;
      }>) || [];

    const personal =
      (effectiveContext.personal as Array<{
        id: number;
        title: string;
        type: string;
      }>) || [];

    const stats = effectiveContext.stats as { total_memories: number; total_personal: number };

    // Resolve repo staleness
    const repos = await deps.getKnownRepos();
    const resolvedCwd = path.resolve(ctx.cwd);
    const cwdRepo =
      repos.find((r) => resolvedCwd.startsWith(path.resolve(r.path))) ||
      repos.find((r) => r.name.toLowerCase() === deps.state.currentProject?.toLowerCase());
    const isStale = cwdRepo ? deps.isRepoStale(cwdRepo) : false;

    const isNewProject = crossProjectResult !== null && !projectContext;
    let effectiveObservations: any[] = [];
    if (promptQuery) {
      effectiveObservations = isNewProject ? (crossProjectResult!.observations as any[]) || [] : observations;
    }
    const effectiveStats = isNewProject ? (crossProjectResult!.stats as any) : stats;

    deps.state.hasInjectedContext = true;

    const topic = effectiveContext.topic as string | null;

    const topicNote = topic ? ` | topic: ${topic}` : '';
    const lines: string[] = ['## Memory Context (auto-loaded)', ''];
    const projectDir = cwdRepo?.path || ctx.cwd;
    const projectSummary = truncateText(getProjectSummary(projectDir), CONTEXT.PROJECT_SUMMARY_LENGTH || 180);

    if (isNewProject) {
      lines.push(
        `Project: **${deps.state.currentProject}** | new project | ${effectiveStats?.total_memories || 0} total memories across all projects`,
      );
      lines.push('');
    } else {
      lines.push(
        `Project: **${deps.state.currentProject}** | ${effectiveStats?.total_memories || 0} memories | ${effectiveStats?.total_personal || 0} personal preferences${topicNote}`,
      );
      lines.push('');
    }

    lines.push('### Project Context');
    lines.push(`- Directory: \`${projectDir}\``);
    lines.push(`- Summary: ${projectSummary}`);
    if (cwdRepo) {
      // Suppress stale label when the agent got its answer from prompt-matched memory.
      // Staleness is irrelevant for recall — the answer is already injected.
      const suppressStale = isStale && effectiveObservations.length > 0;
      const staleLabel = isStale && !suppressStale ? ' (stale)' : '';
      lines.push(
        `- Code index: \`${cwdRepo.name}\` with ${cwdRepo.file_count} files / ${cwdRepo.symbol_count} symbols${staleLabel}`,
      );
    } else {
      lines.push(`- Code index: not indexed for this project`);
    }
    lines.push('');

    if (effectiveObservations.length > 0) {
      const navigationPrompt = isNavigationPrompt(promptQuery);
      const injectLimit = navigationPrompt
        ? CONTEXT.NAVIGATION_PROMPT_INJECT_LIMIT || 2
        : CONTEXT.PROMPT_INJECT_LIMIT || 1;
      lines.push('### Prompt-Matched Memory');
      for (const o of effectiveObservations.slice(0, injectLimit)) {
        let trust = '';
        if (o.trust_score < 0.5) {
          trust = ' ⚠️';
        } else if (o.trust_score < 0.8) {
          trust = ' 🔎';
        }
        lines.push(`- [${o.type}] ${o.title}${trust}`);
        const snippet = summarizeMemoryContent(o.content);
        if (snippet) {
          lines.push(`  ${snippet}`);
        }
        if (navigationPrompt) {
          const filePaths = extractFilePaths(o.content);
          if (filePaths.length > 0) {
            lines.push(`  Related: ${filePaths.map((p) => `\`${p}\``).join(', ')}`);
          }
        }
      }
      lines.push('');
    }

    if (promptQuery && personal.length > 0 && CONTEXT.PERSONAL_INJECT_LIMIT > 0) {
      lines.push('### Personal Preferences');
      for (const p of personal.slice(0, CONTEXT.PERSONAL_INJECT_LIMIT)) {
        lines.push(`- ${p.title}`);
      }
      lines.push('');
    }

    // Cross-project suggestions: related memories from other projects
    const crossProjectSuggestions = (effectiveContext.cross_project_suggestions || []) as any[];
    if (crossProjectSuggestions.length > 0) {
      lines.push('### Cross-Project Suggestions');
      for (const s of crossProjectSuggestions) {
        lines.push(`- [${s.type ?? '?'}] ${s.title ?? '?'} (${s.project ?? '?'})`);
      }
      lines.push('');
    }

    lines.push('Use `memory-search` for deeper recall and `memory-save` for durable decisions.');

    if (!cwdRepo) {
      lines.push('');
      lines.push(
        `⚠️ **Code not indexed:** Project "${deps.state.currentProject}" has no code index yet. Index it first: \`memory-code index-repo --path ${ctx.cwd} --name ${deps.state.currentProject}\``,
      );
    } else if (isStale && !isHistoricalMemoryPrompt(promptQuery) && effectiveObservations.length === 0) {
      lines.push('');
      lines.push(CONTEXT.STALE_GUIDANCE.replace('{repo}', cwdRepo.name));
    }

    // Auto-inject preflight intelligence for coding tasks when an indexed repo exists
    if (cwdRepo && isPreflightWorthyPrompt(promptQuery)) {
      try {
        const preflightResult = await deps.mem('preflight', {
          repo: cwdRepo.name,
          task: promptQuery,
          'code-limit': String(CONTEXT.PREFLIGHT_CODE_LIMIT || 3),
          'memory-limit': String(CONTEXT.PREFLIGHT_MEMORY_LIMIT || 2),
          'doc-limit': String(CONTEXT.PREFLIGHT_DOC_LIMIT || 1),
        });
        if (preflightResult && !preflightResult.error) {
          appendPreflightBlock(lines, preflightResult);
        }
      } catch {
        // Preflight is best-effort; never block context injection on failure
      }
    }

    appendExtensionHint(lines, ctx.cwd);

    return {
      message: {
        customType: 'memory-context',
        content: lines.join('\n'),
        display: false,
      },
    };
  });
}

function buildSourceLookupGuidance(
  repos: Awaited<ReturnType<typeof getKnownRepos>>,
  cwd: string,
  currentProject: string | null,
): string | null {
  const resolvedCwd = path.resolve(cwd);
  const cwdRepo =
    repos.find((r) => resolvedCwd.startsWith(path.resolve(r.path))) ||
    repos.find((r) => r.name.toLowerCase() === currentProject?.toLowerCase());

  if (!cwdRepo) {
    return null;
  }

  return [
    '## Code Lookup Guidance',
    '',
    `Current-source prompt: skip memory facts and verify against code in indexed repo \`${cwdRepo.name}\`.`,
    'For exact symbol questions, prefer a targeted current-source lookup such as `rg -n "<symbol>" <narrow-path>` or a small `read` when the file is known.',
    'For return-shape questions where the module name is evident, read that module directly before searching; for example, `memory-domain context` usually means `src/memory-domain/context.js`.',
    `Use \`memory-code search --repo ${cwdRepo.name} --query <query>\` only when the file or symbol is not already known, then do at most one small targeted \`read\` around the reported file/line.`,
    'Avoid broad shell code search and skip `memory-code outline` unless the task needs file structure.',
  ].join('\n');
}

/**
 * Pull the current user prompt out of Pi hook events when available. The
 * before-agent hook runs after Pi has assembled messages, but exact event shape
 * differs across Pi versions, so this accepts the known string and content-part
 * forms and falls back quietly.
 */
export function extractUserPrompt(event: unknown): string | null {
  const eventAny = event as any;
  const candidates: unknown[] = [eventAny?.prompt, eventAny?.input, eventAny?.query];
  const messages = Array.isArray(eventAny?.messages) ? eventAny.messages : [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === 'user') {
      candidates.push(message.content);
      break;
    }
  }

  for (const candidate of candidates) {
    const text = contentToText(candidate);
    if (text) {
      return text.length > 500 ? `${text.slice(0, 500)}...` : text;
    }
  }

  return null;
}

export function isSourceAuthoritativePrompt(prompt: string | null): boolean {
  if (!prompt) {
    return false;
  }

  const normalized = prompt.toLowerCase();
  return (
    /\bcurrent source\b/.test(normalized) ||
    /\bcurrent code\b/.test(normalized) ||
    /\bfrom the code\b/.test(normalized) ||
    /\banswer from (?:the )?code\b/.test(normalized)
  );
}

export function isHistoricalMemoryPrompt(prompt: string | null): boolean {
  if (!prompt) {
    return false;
  }

  const normalized = prompt.toLowerCase();
  return (
    /\bwhy did\b/.test(normalized) ||
    /\bwhat bug led to\b/.test(normalized) ||
    /\brationale\b/.test(normalized) ||
    /\bdecision\b/.test(normalized) ||
    /\bchoose\b/.test(normalized) ||
    /\bchose\b/.test(normalized)
  );
}

export function isNavigationPrompt(prompt: string | null): boolean {
  if (!prompt) {
    return false;
  }

  const normalized = prompt.toLowerCase();
  return (
    /\b(where|module|file|hook|wired|location|path|lives|implemented|implementation|identify)\b/.test(normalized) ||
    /\bcurrent\s+\w*\s*module\b/.test(normalized)
  );
}

function truncateText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

function summarizeMemoryContent(content: unknown): string | null {
  if (typeof content !== 'string') {
    return null;
  }

  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const priority = lines.filter((line) => /^\*\*(What|Why|Where)\*\*:/i.test(line));
  const selected = (priority.length > 0 ? priority : lines).slice(0, 3);
  if (selected.length === 0) {
    return null;
  }

  const normalized = selected
    .join(' ')
    .replace(/\*\*(What|Why|Where)\*\*:\s*/gi, '$1: ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) {
    return null;
  }

  const limit = CONTEXT.PROMPT_MEMORY_SNIPPET_LENGTH || 280;
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function contentToText(content: unknown): string | null {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed || null;
  }

  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (part && typeof part === 'object' && 'text' in part && typeof (part as any).text === 'string') {
          return (part as any).text;
        }
        return '';
      })
      .join('\n')
      .trim();
    return text || null;
  }

  return null;
}

function getProjectSummary(cwd: string): string {
  const packagePath = path.join(cwd, 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    if (typeof pkg.description === 'string' && pkg.description.trim()) {
      return pkg.description.trim();
    }
    if (typeof pkg.name === 'string' && pkg.name.trim()) {
      return `Local project ${pkg.name.trim()}.`;
    }
  } catch {
    // Non-Node projects or unreadable package files fall back to directory name.
  }
  return `Local project directory ${path.basename(cwd) || cwd}.`;
}

function appendExtensionHint(lines: string[], cwd: string) {
  const extensionDir = path.join(cwd, 'extensions', 'memory-layer');
  try {
    const extStat = fs.statSync(extensionDir);
    if (extStat.isDirectory()) {
      lines.push('');
      lines.push('📂 Extension source: `extensions/memory-layer/` in this project repo.');
    }
  } catch {
    // No local extension dir — skip hint
  }
}

export function extractFilePaths(content: string): string[] {
  if (!content || typeof content !== 'string') {
    return [];
  }

  const pathRe = /(?:^|\s|`)([\w/.-]+\.(?:js|ts|tsx|jsx|mjs|cjs|py|go|rs|sql))(?:`|\s|,|\.|$)/gm;
  const matches: string[] = [];
  let match;
  while ((match = pathRe.exec(content)) !== null) {
    const p = match[1];
    // Filter out short strings without directory separators
    if (p.includes('/') && p.length > 5) {
      matches.push(p);
    }
  }
  // Deduplicate, max 3
  return [...new Set(matches)].slice(0, 3);
}

export function isPreflightWorthyPrompt(prompt: string | null): boolean {
  if (!prompt) {
    return false;
  }
  // Skip prompts that are purely questions/navigation/history
  if (isSourceAuthoritativePrompt(prompt) || isHistoricalMemoryPrompt(prompt) || isNavigationPrompt(prompt)) {
    return false;
  }
  const normalized = prompt.toLowerCase();
  // Heavily question-shaped prompts (starts with question words and no action verbs)
  if (/^(what|where|when|who|how many|does|is there|can you explain|tell me about)\b/.test(normalized)) {
    return false;
  }
  // Must contain at least one action/coding signal
  const codingSignals = [
    /\b(add|create|build|implement|fix|refactor|modify|update|change|remove|delete)\b/,
    /\b(write|extend|extract|move|rename|migrate|wire up|integrate)\b/,
    /\b(feature|bug|issue|test|function|module|component|endpoint|route)\b/,
    /\b(make it|ensure|so that|need to|should|let's|let me)\b/,
  ];
  return codingSignals.some((re) => re.test(normalized));
}

function appendPreflightBlock(lines: string[], result: any): void {
  const maxChars = CONTEXT.PREFLIGHT_MAX_CHARS || 400;
  const code = (result.likely_existing_code || []) as Array<{
    symbol: string;
    file: string;
    line?: number;
    kind?: string;
  }>;
  const warnings = (result.duplicate_warnings || []) as Array<{
    symbol: string;
    file: string;
  }>;
  const risk = result.risk as string;
  const action = result.recommended_action as string;
  const relatedFiles = (result.related_files || []) as string[];
  const maxFiles = CONTEXT.PREFLIGHT_RELATED_FILES || 3;

  if (code.length === 0 && warnings.length === 0 && risk === 'low') {
    return; // Nothing to surface
  }

  lines.push('');
  lines.push('### Preflight — Before Coding');

  if (warnings.length > 0) {
    const riskIcon = risk === 'high' ? '🔴' : risk === 'medium' ? '🟡' : '🟢';
    lines.push(`${riskIcon} **Duplicate risk: ${risk}** — existing code may already handle this task.`);
    for (const w of warnings.slice(0, 2)) {
      lines.push(`- ⚠️ \`${w.symbol}\` in \`${w.file}\``);
    }
  } else if (code.length > 0) {
    const riskIcon = risk === 'high' ? '🔴' : risk === 'medium' ? '🟡' : '🟢';
    lines.push(`${riskIcon} Risk: **${risk}** — related code exists.`);
    for (const c of code.slice(0, 2)) {
      const loc = c.line ? `:${c.line}` : '';
      lines.push(`- \`${c.symbol}\` (${c.kind || 'symbol'}) — \`${c.file}${loc}\``);
    }
  }

  if (relatedFiles.length > 0) {
    lines.push(`Related files: ${relatedFiles.slice(0, maxFiles).map((f: string) => `\`${f}\``).join(', ')}`);
  }

  if (action) {
    lines.push(`→ ${action}`);
  }
}

export function registerContextReminder(pi: ExtensionAPI, deps: ContextDeps) {
  pi.on('context', async (event, _ctx) => {
    if (deps.state.hasInjectedContext) {
      deps.state.hasInjectedContext = false;
      return;
    }

    deps.state.callsSinceLastMemory++;

    if (deps.state.callsSinceLastMemory < MEMORY_REMINDER_INTERVAL) {
      return;
    }

    if (Date.now() - deps.state.lastMemoryToolCall < 180000) {
      return;
    }

    // Reset counter after firing
    deps.state.callsSinceLastMemory = 0;

    return {
      messages: [
        ...event.messages,
        {
          role: 'user' as const,
          content:
            '💡 Memory reminder: Use `memory-search` before decisions to avoid repeating past mistakes. Use `memory-save` for decisions, bugfixes, and discoveries.',
        },
      ],
    };
  });
}
