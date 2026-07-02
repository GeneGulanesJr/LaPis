'use strict';

const path = require('node:path');

/**
 * hooks-engine: guardrail-utils
 *
 * Consolidated guardrail primitives. Promotes
 * extensions/memory-layer/hooks/guardrail-utils.js (already pure JS) and pulls in
 * the constants inlined in extensions/memory-layer/hooks/tool-guardrails.ts.
 */

// --- from hooks/guardrail-utils.js ---

const MIN_SYMBOL_LENGTH = 4;
const QUOTED_PATTERN_RE = /(?:['"])([^'"]+)(?:['"])/g;
const SEARCH_COMMAND_RE = /\b(grep|rg|ag|ack|find)\b/;
const FILTER_COMMAND_RE = /^\s*(grep|rg|ag|ack)\b/;
const SIMPLE_LIMIT_PIPE_RE = /^\s*(?:head|tail)\b/;
const CODE_FILE_PATH_RE = /(?:^|\s)(?:\.{0,2}\/|\/)?[^\s'"]+\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)(?:\s|$)/;

function splitPipeline(cmd) {
  const stages = [];
  let current = '';
  let quote = null;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    const prev = i > 0 ? cmd[i - 1] : '';

    if ((ch === '"' || ch === "'") && prev !== '\\') {
      quote = quote === ch ? null : quote || ch;
    }

    if (ch === '|' && !quote) {
      stages.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }

  stages.push(current.trim());
  return stages.filter(Boolean);
}

function isPipedOutputFilter(cmd) {
  const stages = splitPipeline(cmd);
  if (stages.length < 2) {
    return false;
  }

  const [sourceStage, ...filterStages] = stages;
  if (SEARCH_COMMAND_RE.test(sourceStage)) {
    return false;
  }

  return filterStages.some((stage) => FILTER_COMMAND_RE.test(stage));
}

function isTargetedSymbolLookup(cmd) {
  if (/\bfind\b/.test(cmd)) {
    return false;
  }

  if (!/\b(grep|rg|ag|ack)\b/.test(cmd)) {
    return false;
  }

  const stages = splitPipeline(cmd);
  if (stages.length > 1 && stages.slice(1).some((stage) => !SIMPLE_LIMIT_PIPE_RE.test(stage))) {
    return false;
  }

  let pattern = null;
  let hasQuotedPattern = false;
  let m;
  // Reset the module-level /g flag's lastIndex. The original (hooks/guardrail-utils.js)
  // reused QUOTED_PATTERN_RE across calls without resetting; because the loop below
  // `break`s on the first non-glob candidate, lastIndex was left stale and a later
  // call could start scanning mid-string. Resetting here makes the function
  // deterministic across calls (intentional deviation from the original, which had
  // this latent stateful-regex bug; covered by test/tool-guardrails.test.js parity).
  QUOTED_PATTERN_RE.lastIndex = 0;
  while ((m = QUOTED_PATTERN_RE.exec(cmd)) !== null) {
    const candidate = m[1];
    if (!/^[*?]/.test(candidate)) {
      hasQuotedPattern = true;
    }
    if (!/[*?]/.test(candidate)) {
      pattern = candidate;
      break;
    }
  }

  if (hasQuotedPattern && CODE_FILE_PATH_RE.test(cmd)) {
    return true;
  }

  if (!pattern) {
    return false;
  }

  if (pattern.length < MIN_SYMBOL_LENGTH) {
    return false;
  }

  if (/[.*+?|^$()\[\]{}\\]/.test(pattern)) {
    return false;
  }

  if (pattern.includes('|')) {
    return false;
  }

  return true;
}

// --- from tool-guardrails.ts:9-53 ---

const CONFIG_FILENAMES = new Set([
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.build.json',
  'tsconfig.node.json',
  'vitest.config.ts',
  'vitest.config.mjs',
  'vitest.config.js',
  'jest.config.ts',
  'jest.config.js',
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.ts',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.json',
  '.eslintrc.yml',
  '.prettierrc',
  '.prettierrc.js',
  '.prettierrc.json',
  'tailwind.config.ts',
  'tailwind.config.js',
  'next.config.js',
  'next.config.ts',
  'next.config.mjs',
  'vite.config.ts',
  'vite.config.js',
  'webpack.config.js',
  'rollup.config.js',
  'babel.config.js',
  'babel.config.json',
  '.babelrc',
  'composer.json',
  'Cargo.toml',
  'go.mod',
  'go.sum',
  'pyproject.toml',
  'setup.py',
  'requirements.txt',
]);

const RAW_CODE_DISCOVERY_RE = /\b(rg|grep|ag|ack|find)\b/i;
const CODE_PATH_HINT_RE =
  /\.(ts|js|tsx|jsx|mjs|cjs|py|go|rs|java)\b|(^|\s)(src|lib|app|test|tests|extensions|commands|data-access|services)\b/i;
const REGEX_META_RE = /[.*+?|^$()[\]{}\\]/;
const BROAD_GLOB_RE = /^(?:\*\*\/\*|\*\*\/\*\.\*|\*|\*\.\*|\.|\.\/*)$/;

const CODE_EXTENSIONS = new Set([
  '.js',
  '.ts',
  '.tsx',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.pyi',
  '.pyx',
  '.go',
  '.rs',
  '.sh',
  '.bash',
  '.json',
  '.jsonc',
  '.yaml',
  '.yml',
  '.rb',
  '.java',
  '.kt',
  '.swift',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.cs',
  '.scala',
  '.clj',
  '.ex',
  '.exs',
  '.erl',
  '.hs',
  '.ml',
  '.zig',
]);

function isCodeFile(filePath) {
  if (typeof filePath !== 'string' || !filePath) {
    return false;
  }
  return CODE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isTargetedGrepPattern(pattern, searchPath) {
  if (typeof pattern !== 'string') {
    return false;
  }
  const trimmed = pattern.trim();
  if (trimmed.length < MIN_SYMBOL_LENGTH) {
    return false;
  }
  if (REGEX_META_RE.test(trimmed) || trimmed.includes('|')) {
    return false;
  }
  if (typeof searchPath !== 'string' || !searchPath.trim()) {
    return false;
  }
  return isCodeFile(searchPath.trim());
}

function isBroadGlobPattern(pattern) {
  if (typeof pattern !== 'string') {
    return false;
  }
  const trimmed = pattern.trim();
  if (BROAD_GLOB_RE.test(trimmed)) {
    return true;
  }
  return /\*\*\/\*/.test(trimmed) && !/\.(?:md|txt|json|jsonc|yaml|yml)$/.test(trimmed);
}

module.exports = {
  splitPipeline,
  isPipedOutputFilter,
  isTargetedSymbolLookup,
  isTargetedGrepPattern,
  isBroadGlobPattern,
  isCodeFile,
  CONFIG_FILENAMES,
  RAW_CODE_DISCOVERY_RE,
  CODE_PATH_HINT_RE,
};
