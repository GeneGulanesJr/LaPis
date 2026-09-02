'use strict';

/**
 * Hooks-engine: context-builder
 *
 * Pure rendering core extracted from
 * extensions/memory-layer/hooks/context-injection.ts. Builds the memory-context
 * `lines` array (UNCAPPED — the adapter caps the final joined string after
 * appending preflight/coding-context/extension-hint blocks).
 *
 * Owns `extractFilePaths`, shared with preflight-assembly.
 */

const path = require('node:path'),
  { resolveIndexedRepo } = require('./project'),
  fs = require('node:fs'),
  { CONTEXT } = require('../../constants'),
  { isNavigationPrompt } = require('./prompt-classifiers');

function truncateText(text, limit) {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

function capInjectedContext(content) {
  const limit = CONTEXT.MAX_INJECTED_CONTEXT_CHARS || 1800;
  if (content.length <= limit) {
    return content;
  }

  return `${content.slice(0, limit - 1).trimEnd()}…`;
}

function summarizeMemoryContent(content) {
  if (typeof content !== 'string') {
    return null;
  }

  const lines = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
    priority = lines.filter((line) => /^\*\*(What|Why|Where)\*\*:/i.test(line)),
    selected = (priority.length > 0 ? priority : lines).slice(0, 3),
    normalized = !(selected.length === 0)
      ? selected
          .join(' ')
          .replace(/\*\*(What|Why|Where)\*\*:\s*/gi, '$1: ')
          .replace(/\s+/g, ' ')
          .trim()
      : undefined,
    limit = !(selected.length === 0) && normalized ? CONTEXT.PROMPT_MEMORY_SNIPPET_LENGTH || 280 : undefined;
  if (selected.length === 0) {
    return null;
  }

  if (!normalized) {
    return null;
  }

  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function extractFilePaths(content) {
  if (!content || typeof content !== 'string') {
    return [];
  }

  const pathRe = /(?:^|\s|`)([\w/.-]+\.(?:js|ts|tsx|jsx|mjs|cjs|py|go|rs|sql))(?:`|\s|,|\.|$)/gm,
    matches = [];
  let match;
  while ((match = pathRe.exec(content)) !== null) {
    const p = match[1];
    if (p.includes('/') && p.length > 5) {
      matches.push(p);
    }
  }
  return [...new Set(matches)].slice(0, 3);
}

function getProjectSummary(cwd) {
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

function appendExtensionHint(lines, cwd) {
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

function buildSourceLookupGuidance(repos, cwd, currentProject) {
  const resolvedCwd = path.resolve(cwd),
    cwdRepo = resolveIndexedRepo(resolvedCwd, repos, currentProject);

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
 * Build the memory-context lines array from a fully resolved data bag.
 * Returns string[] (UNCAPPED). The adapter appends preflight/coding-context/
 * extension-hint and then applies capInjectedContext() to the joined string.
 *
 * @param {object} bag
 * @param {string|null} bag.promptQuery
 * @param {string|null} bag.currentProject
 * @param {string} bag.projectDir
 * @param {object|null} bag.cwdRepo         matched repo ({name,path,file_count,symbol_count,indexed_at}) or null
 * @param {boolean} bag.isStale
 * @param {boolean} bag.isNewProject
 * @param {Array}    bag.effectiveObservations prompt-matched observations to render
 * @param {Array}    bag.personal           personal preferences
 * @param {object}   bag.effectiveStats
 * @param {string|null} bag.topic
 * @param {Array}    bag.crossProjectSuggestions
 */
function buildContextBlock(bag) {
  const {
      promptQuery,
      currentProject,
      projectDir,
      cwdRepo,
      isStale,
      isNewProject,
      effectiveObservations,
      personal,
      effectiveStats,
      topic,
      crossProjectSuggestions = [],
    } = bag,
    topicNote = topic ? ` | topic: ${topic}` : '',
    lines = ['## Memory Context (auto-loaded)', ''],
    projectSummary = truncateText(getProjectSummary(projectDir), CONTEXT.PROJECT_SUMMARY_LENGTH || 180);

  if (isNewProject) {
    lines.push(
      `Project: **${currentProject}** | new project | ${effectiveStats?.total_memories || 0} total memories across all projects`,
    );
    lines.push('');
  } else {
    lines.push(
      `Project: **${currentProject}** | ${effectiveStats?.total_memories || 0} memories | ${effectiveStats?.total_personal || 0} personal preferences${topicNote}`,
    );
    lines.push('');
  }

  lines.push('### Project Context');
  lines.push(`- Directory: \`${projectDir}\``);
  lines.push(`- Summary: ${projectSummary}`);
  if (cwdRepo) {
    const suppressStale = isStale && effectiveObservations.length > 0,
      staleLabel = isStale && !suppressStale ? ' (stale)' : '';
    lines.push(
      `- Code index: \`${cwdRepo.name}\` with ${cwdRepo.file_count} files / ${cwdRepo.symbol_count} symbols${staleLabel}`,
    );
  } else {
    lines.push(`- Code index: not indexed for this project`);
  }
  lines.push('');

  if (effectiveObservations.length > 0) {
    const navigationPrompt = isNavigationPrompt(promptQuery),
      injectLimit = navigationPrompt ? CONTEXT.NAVIGATION_PROMPT_INJECT_LIMIT || 2 : CONTEXT.PROMPT_INJECT_LIMIT || 1;
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

  if (crossProjectSuggestions.length > 0) {
    lines.push('### Cross-Project Suggestions');
    for (const s of crossProjectSuggestions) {
      lines.push(`- [${s.type ?? '?'}] ${s.title ?? '?'} (${s.project ?? '?'})`);
    }
    lines.push('');
  }

  lines.push('Use `memory-search` for deeper recall and `memory-save` for durable decisions.');

  return lines;
}

module.exports = {
  buildContextBlock,
  buildSourceLookupGuidance,
  summarizeMemoryContent,
  extractFilePaths,
  capInjectedContext,
  truncateText,
  getProjectSummary,
  appendExtensionHint,
};
