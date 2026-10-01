'use strict';

/**
 * Hooks-engine: guardrail-utils
 *
 * Consolidated guardrail primitives. Promotes
 * extensions/memory-layer/hooks/guardrail-utils.js (already pure JS) and pulls in
 * the constants inlined in extensions/memory-layer/hooks/tool-guardrails.ts.
 */

// --- from hooks/guardrail-utils.js ---

const MIN_SYMBOL_LENGTH = 4,
  QUOTED_PATTERN_RE = /(?:['"])([^'"]+)(?:['"])/g,
  SEARCH_COMMAND_RE = /\b(grep|rg|ag|ack|find)\b/,
  FILTER_COMMAND_RE = /^\s*(grep|rg|ag|ack)\b/,
  SIMPLE_LIMIT_PIPE_RE = /^\s*(?:head|tail)\b/,
  EXCLUSION_FILTER_RE = /^\s*(?:grep|rg|ag|ack)\b[\s\S]*?(?:^|\s)(?:-v|--invert-match)\b/,
  TEXT_FILE_PATH_RE =
    /(?:^|\s)(?:\.{0,2}\/|\/)?[^\s'*?\"']+\.(?:md|mdx|txt|json|jsonl|yaml|yml|toml|ini|cfg|conf|csv|log)(?:\s|$)/i,
  CODE_FILE_PATH_RE = /(?:^|\s)(?:\.{0,2}\/|\/)?[^\s'"]+\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)(?:\s|$)/;

// --- from tool-guardrails.ts:9-53 ---

{
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
    ]),
    RAW_CODE_DISCOVERY_RE = /\b(rg|grep|ag|ack|find)\b/i,
    // Raw-search binaries, matched in COMMAND position only — the bare word
    // Is not enough: `npm run find:deadcode` contains the word "find" but is
    // A package script, not a raw search (#292). Detection is token-based
    // (leadingCommandBinary) rather than regex: the quantified-prefix regex
    // Form is polynomial on uncontrolled input (CodeQL).
    SEARCH_BINARIES = new Set(['rg', 'grep', 'ag', 'ack', 'find']),
    // A search binary in COMMAND position of any command the shell would run.
    // Here-document bodies (file contents written with `cat > f <<'EOF'`) and
    // Quoted arguments (`node -e '…x.find(…)…'`, `echo "grep this"`) are data,
    // Not commands, so they never count — the bare-word regex blocked those.
    // Newlines separate commands; `bash -c "…"` / `sh -c` bodies are scanned;
    // `$(…)` inside double quotes is a command and is scanned.
    isRawCodeDiscoveryCommand = (cmd, depth = 0) =>
      typeof cmd === 'string' &&
      splitRawCommandSegments(stripHeredocBodies(cmd)).some((segment) => {
        const inner = shellDashCBody(segment);
        if (inner !== null && depth < 3) {
          return isRawCodeDiscoveryCommand(inner, depth + 1);
        }
        return leadingCommandBinary(segment) !== null;
      }),
    isSearchCommandStage = (stage) => typeof stage === 'string' && leadingCommandBinary(stage) !== null,
    isFindCommandStage = (stage) => leadingCommandBinary(stage) === 'find',
    CODE_PATH_HINT_RE =
      /\.(ts|js|tsx|jsx|mjs|cjs|py|go|rs|java)\b|(^|\s)(src|lib|app|test|tests|extensions|commands|data-access|services)\b/i,
    // --- native-tool search guardrails (Claude Code Grep / Glob) ---
    //
    // Claude Code's agent is *instructed* to prefer the Grep (ripgrep) and Glob
    // Tools over bash grep/find, so the PRIMARY code-search guardrail lives on
    // Those native tools rather than Bash. These helpers classify a Grep/Glob
    // Tool_input as "targeted" (allow) vs "broad" (deny + memory-code guidance),
    // Keeping parity with the Bash isTargetedSymbolLookup logic above.

    // Regex metacharacters that mark a Grep pattern as a broad/structural search
    // Rather than a single-symbol lookup. Mirrors the check in
    // IsTargetedSymbolLookup so Grep and Bash gate identically.
    GREP_METACHAR_RE = /[.*+?|^$()[\]{}\\]/,
    // Single source of truth for the set of code file extensions. Both the
    // "specific code file" classifier (below) and the bridge's harvest regex
    // (src/claude-code/handlers/post-tool-use.js CODE_PATH_RE) build from this so
    // They never drift (#230).
    CODE_EXTENSIONS = [
      'cjs',
      'cts',
      'js',
      'jsx',
      'mjs',
      'mts',
      'ts',
      'tsx',
      'py',
      'pyi',
      'go',
      'rs',
      'java',
      'kt',
      'rb',
      'c',
      'h',
      'cpp',
      'hpp',
      'cs',
      'scala',
      'swift',
      'php',
    ],
    SPECIFIC_CODE_FILE_RE = new RegExp(`\\.(${CODE_EXTENSIONS.join('|')})$`, 'i');

  /**
   * True when a path points at a single concrete code file (not a directory,
   * not a glob). A Grep scoped to one file is always allowed — it is the
   * ripgrep equivalent of reading a targeted slice.
   */
  function isSpecificCodeFilePath(p) {
    if (typeof p !== 'string' || !p) {
      return false;
    }
    if (p.includes('*') || p.includes('?')) {
      return false;
    }
    return SPECIFIC_CODE_FILE_RE.test(p.trim());
  }

  /**
   * Adapt isTargetedSymbolLookup to the Grep tool's structured input. A Grep is
   * "targeted" (allowed) when it is scoped to a single code file OR its pattern
   * is a plain single symbol (length >= MIN_SYMBOL_LENGTH, no regex metachars,
   * no whitespace, no alternation). Everything else is a broad scan best served
   * by `memory-code search`.
   *
   * @param {{pattern?: string, path?: string}} toolInput
   * @returns {boolean}
   */
  function isTargetedGrepLookup(toolInput = {}) {
    const { pattern } = toolInput,
      p = toolInput.path;

    if (isSpecificCodeFilePath(p)) {
      return true;
    }

    if (typeof pattern !== 'string' || !pattern) {
      return false;
    }
    {
      const trimmed = pattern.trim();
      if (trimmed.length < MIN_SYMBOL_LENGTH) {
        return false;
      }
      if (/\s/.test(trimmed)) {
        return false;
      }
      if (GREP_METACHAR_RE.test(trimmed)) {
        return false;
      }
      return true;
    }
  }

  /**
   * True for a Glob pattern that discovers code broadly across the whole repo
   * (bare `**`, `**` + `/*`, or a top-level recursive code glob like
   * `**` followed by `/*.ts`, with no intermediate directory scoping).
   * Scoped globs with an intermediate directory (e.g. `src` prefix, or
   * a `handlers` subdirectory segment) are NOT broad — they are allowed.
   *
   * @param {string} pattern
   * @returns {boolean}
   */
  function isBroadGlob(pattern) {
    if (typeof pattern !== 'string') {
      return false;
    }
    const p = pattern.trim();
    if (!p) {
      return false;
    }
    if (p === '**' || p === '**/*' || p === '*' || p === '**/**') {
      return true;
    }
    if (p.startsWith('**/') && SPECIFIC_CODE_FILE_RE.test(p) && p.indexOf('/', 3) === -1) {
      // E.g. **/*.ts — recursive, unscoped code discovery.
      return true;
    }
    return false;
  }

  module.exports = {
    splitPipeline,
    isPipedOutputFilter,
    isTargetedSymbolLookup,
    isTargetedTextFileLookup,
    isRawCodeDiscoveryCommand,
    isSearchCommandStage,
    extractPathArgs,
    isSpecificCodeFilePath,
    isTargetedGrepLookup,
    isBroadGlob,
    CONFIG_FILENAMES,
    CODE_EXTENSIONS,
    RAW_CODE_DISCOVERY_RE,
    CODE_PATH_HINT_RE,
    MIN_SYMBOL_LENGTH,
  };
  // Tokenize a command segment respecting quotes. Linear: the alternatives
  // Are disjoint on their first character, so there is no backtracking.
  function tokenizeCommandSegment(segment) {
    return String(segment).match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  }

  function isEnvAssignmentToken(token) {
    return token.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
  }

  // Prefix commands that run the NEXT token as the command (`xargs grep`,
  // `time rg`, `nohup find`). Option flags after them are skipped, plus the
  // Value of the few flags that take one.
  const RUNNER_PREFIXES = new Set([
      'sudo',
      'git',
      'env',
      'xargs',
      'time',
      'nohup',
      'nice',
      'command',
      'exec',
      'timeout',
    ]),
    PREFIX_FLAGS_WITH_VALUE = new Set(['-n', '-P', '-I', '-L', '-d', '-E', '-s', '-u', '-g', '-C']);

  // Walk the leading tokens (runner prefixes, their flags, VAR=value) and return
  // The command binary, or null. Purely iterative — no regex backtracking on
  // Uncontrolled input (CodeQL polynomial-regex alert).
  function leadingCommandBinary(segment) {
    const tokens = tokenizeCommandSegment(segment);
    let index = 0;
    while (index < tokens.length) {
      const token = tokens[index];
      if (RUNNER_PREFIXES.has(token) && index + 1 < tokens.length) {
        index++;
        // `timeout 10 grep …` — skip the duration
        if (token === 'timeout' && /^\d/.test(tokens[index] ?? '')) {
          index++;
        }
        while (index < tokens.length && tokens[index].startsWith('-') && token !== 'git') {
          index += PREFIX_FLAGS_WITH_VALUE.has(tokens[index]) ? 2 : 1;
        }
        continue;
      }
      if (isEnvAssignmentToken(token)) {
        index++;
        continue;
      }
      break;
    }
    return SEARCH_BINARIES.has(tokens[index]) ? tokens[index] : null;
  }

  // `bash -c "cmd"` / `sh -c 'cmd'` / `zsh -lc …` → the inner command string, else null.
  function shellDashCBody(segment) {
    const tokens = tokenizeCommandSegment(segment);
    if (!/^(?:bash|sh|zsh|dash)$/.test(tokens[0] ?? '')) {
      return null;
    }
    for (let i = 1; i < tokens.length - 1; i++) {
      if (/^-[a-z]*c[a-z]*$/.test(tokens[i])) {
        const body = tokens[i + 1];
        return body.length >= 2 && (body[0] === '"' || body[0] === "'") ? body.slice(1, -1) : body;
      }
    }
    return null;
  }

  // Drop here-document BODIES — `cat > f <<'EOF' … EOF` writes data, it does not
  // Run it. A body fed to a shell (`bash <<EOF`) IS commands and is kept.
  // Line scan with a queue of pending terminators: linear.
  function stripHeredocBodies(cmd) {
    if (!cmd.includes('<<')) {
      return cmd;
    }
    const out = [],
      pending = [];
    for (const line of cmd.split('\n')) {
      if (pending.length) {
        const term = pending[0],
          candidate = term.dash ? line.replace(/^\t+/, '') : line;
        if (candidate.trim() === term.word) {
          pending.shift();
        } else if (term.keep) {
          out.push(line);
        }
        continue;
      }
      out.push(line);
      const feedsShell = /^\s*(?:bash|sh|zsh|dash)\b/.test(line);
      for (const m of line.matchAll(/(?<!<)<<(?!<)(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/g)) {
        pending.push({ dash: m[1] === '-', word: m[3], keep: feedsShell });
      }
    }
    return out.join('\n');
  }

  // Split into the separate commands the shell would run: on | ; & newline,
  // Backticks, subshell/group parens and braces, and `$(` — but never inside
  // Quotes. `$(…)` inside DOUBLE quotes is still a command and is returned as
  // Its own segment. Single pass, linear.
  function splitRawCommandSegments(cmd) {
    const segments = [];
    let current = '',
      quote = null;
    for (let i = 0; i < cmd.length; i++) {
      const ch = cmd[i];
      if (quote) {
        if (quote === '"' && ch === '$' && cmd[i + 1] === '(') {
          // command substitution inside double quotes: scan to the matching paren
          let depth = 1,
            j = i + 2;
          for (; j < cmd.length && depth > 0; j++) {
            if (cmd[j] === '(') depth++;
            else if (cmd[j] === ')') depth--;
          }
          segments.push(...splitRawCommandSegments(cmd.slice(i + 2, j - 1)));
          current += cmd.slice(i, j);
          i = j - 1;
          continue;
        }
        current += ch;
        if (ch === quote && !(quote === '"' && cmd[i - 1] === '\\')) {
          quote = null;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        current += ch;
        continue;
      }
      if (ch === '\\' && cmd[i + 1] === '\n') {
        current += ' ';
        i++;
        continue;
      }
      if (ch === '$' && cmd[i + 1] === '(') {
        segments.push(current);
        current = '';
        i++;
        continue;
      }
      if ('|;&\n`(){}'.includes(ch)) {
        segments.push(current);
        current = '';
        continue;
      }
      current += ch;
    }
    segments.push(current);
    return segments.map((s) => s.trim()).filter(Boolean);
  }

  function splitPipeline(cmd) {
    const stages = [];
    let current = '',
      quote = null;

    for (let i = 0; i < cmd.length; i++) {
      const ch = cmd[i],
        prev = i > 0 ? cmd[i - 1] : '';

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
    const stages = splitPipeline(cmd),
      [sourceStage, ...filterStages] = stages;
    if (stages.length < 2) {
      return false;
    }

    // The SOURCE must not itself be a search (`grep -rn x src | grep y`); the
    // Word "find"/"grep" as an argument (`node run.mjs --find | grep x`) is fine.
    if (isRawCodeDiscoveryCommand(sourceStage)) {
      return false;
    }

    return filterStages.some((stage) => FILTER_COMMAND_RE.test(stage));
  }
  // Path-like arguments of a command stage: tokens that contain a path
  // Separator or end in a file extension, excluding flags. A quoted token is
  // The search pattern, not a path argument.
  function extractPathArgs(stage) {
    const tokens = String(stage).match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
    return tokens
      .slice(1)
      .filter((token) => !token.startsWith('-'))
      .map((token) =>
        token.length >= 2 && (token.startsWith('"') || token.startsWith("'")) ? token.slice(1, -1) : token,
      )
      .filter((token) => /[\\/]/.test(token) || /\.[A-Za-z0-9]+$/.test(token));
  }
  function isTargetedTextFileLookup(cmd) {
    const stages = splitPipeline(cmd);
    // Must be a search binary in command position — and `find` itself is a
    // File-finder, not a content search (#292).
    if (!isSearchCommandStage(stages[0]) || isFindCommandStage(stages[0])) {
      return false;
    }

    if (
      stages.length > 1 &&
      stages.slice(1).some((stage) => !SIMPLE_LIMIT_PIPE_RE.test(stage) && !EXCLUSION_FILTER_RE.test(stage))
    ) {
      return false;
    }

    // Every path-like argument must be a text file. Testing the whole command
    // String let a single README.md mention wave a broad
    // `grep -rn needle src/` scan through (#292).
    const pathArgs = extractPathArgs(stages[0]);
    if (pathArgs.length === 0) {
      return false;
    }
    return pathArgs.every((arg) => TEXT_FILE_PATH_RE.test(` ${arg} `));
  }
  function isTargetedSymbolLookup(cmd) {
    const stages = splitPipeline(cmd);
    // Search binary in command position; a literal `find` command
    // Disqualifies, but the word "find" inside a pattern or a script name
    // Must not (#292).
    if (!isSearchCommandStage(stages[0]) || isFindCommandStage(stages[0])) {
      return false;
    }

    if (
      stages.length > 1 &&
      stages.slice(1).some((stage) => !SIMPLE_LIMIT_PIPE_RE.test(stage) && !EXCLUSION_FILTER_RE.test(stage))
    ) {
      return false;
    }

    let pattern = null,
      hasQuotedPattern = false,
      m;
    // Reset the module-level /g flag's lastIndex. The original (hooks/guardrail-utils.js)
    // Reused QUOTED_PATTERN_RE across calls without resetting; because the loop below
    // `break`s on the first non-glob candidate, lastIndex was left stale and a later
    // Call could start scanning mid-string. Resetting here makes the function
    // Deterministic across calls (intentional deviation from the original, which had
    // This latent stateful-regex bug; covered by test/tool-guardrails.test.js parity).
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
}
