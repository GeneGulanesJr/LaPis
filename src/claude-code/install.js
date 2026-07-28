'use strict';

/**
 * Claude Code bridge: `lapis claude-code install` — config writer.
 *
 * Claude Code has TWO separate config systems and this module never mixes them:
 *   - MCP servers → `.mcp.json` (project scope, committable) or `~/.claude.json`
 *     (user scope at the top-level `mcpServers` key; local scope under
 *     `projects[<cwd>].mcpServers`).
 *   - Hooks → `.claude/settings.json` (project, committable),
 *     `~/.claude/settings.json` (user), or `.claude/settings.local.json`
 *     (project, gitignored, machine-specific).
 *
 * Command-resolution strategies (portability ladder):
 *   - npx (default): `npx -y @genegulanesjr/lapis …` — portable, committable.
 *   - global bin (`--bin lapis` or any bare name on PATH): fastest direct-mode
 *     spawn, still committable because it is PATH-relative.
 *   - `--daemon`: after install, start a detached `lapis serve` and write the
 *     daemon lockfile so hook handlers POST to `/dispatch` instead of cold-starting.
 *   - local clone (`--bin <path>`): machine-specific absolute path → hooks go
 *     to `settings.local.json`, MCP goes to `~/.claude.json` local scope. The
 *     committable files are NEVER touched with a machine-specific path.
 *
 * Idempotency: re-install replaces the existing LaPis entries in place. Hook
 * handlers are identified by a sentinel (the `claude-code hook` argument
 * grammar only LaPis writes); MCP servers are deduped by server name AND by
 * resolved command string, so a rename via `--mcp-name` never leaves a stale
 * duplicate spawning a second server.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PACKAGE_NAME = '@genegulanesjr/lapis';
const DEFAULT_MCP_NAME = 'lapis';
const CLAUDE_MD_START = '<!-- lapis:start -->';
const CLAUDE_MD_END = '<!-- lapis:end -->';

// --- flag parsing ---------------------------------------------------------

/**
 * Parse `install`/`uninstall` flags. Unknown flags throw so a typo never
 * silently installs the wrong config.
 */
function parseFlags(argv) {
  const flags = {
    global: false,
    mcpName: DEFAULT_MCP_NAME,
    claudeMd: true,
    bin: null,
    autoAllow: false,
    daemon: false,
    daemonPort: 9100,
  };
  const args = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--global') {
      flags.global = true;
    } else if (a === '--mcp-name') {
      const v = args[++i];
      if (!v || !/^[A-Za-z0-9_-]+$/.test(v)) {
        throw new Error('--mcp-name requires a value matching [A-Za-z0-9_-]+');
      }
      flags.mcpName = v;
    } else if (a === '--no-claude-md') {
      flags.claudeMd = false;
    } else if (a === '--bin') {
      const v = args[++i];
      if (!v) {
        throw new Error('--bin requires a path or command name');
      }
      flags.bin = v;
    } else if (a === '--auto-allow') {
      flags.autoAllow = true;
    } else if (a === '--daemon') {
      flags.daemon = true;
    } else if (a === '--daemon-port') {
      const v = Number(args[++i]);
      if (!Number.isInteger(v) || v <= 0 || v > 65535) {
        throw new Error('--daemon-port requires an integer between 1 and 65535');
      }
      flags.daemonPort = v;
    } else {
      throw new Error(`Unknown flag: ${a}`);
    }
  }
  return flags;
}

// --- command resolution ----------------------------------------------------

/**
 * Resolve how Claude Code should spawn LaPis.
 *
 * @returns {{ mode: string, command: string, baseArgs: string[], machineSpecific: boolean }}
 */
function resolveInvocation(flags, io) {
  const bin = flags.bin;
  if (!bin) {
    return { mode: 'npx', command: 'npx', baseArgs: ['-y', PACKAGE_NAME], machineSpecific: false };
  }
  const hasSeparator = bin.includes('/') || bin.includes('\\');
  if (!hasSeparator) {
    // Bare name on PATH (e.g. `--bin lapis` after a global npm install):
    // PATH-relative, so still committable.
    return { mode: 'global-bin', command: bin, baseArgs: [], machineSpecific: false };
  }
  const abs = path.resolve(io.cwd, bin);
  if (abs.endsWith('.js') || abs.endsWith('.cjs') || abs.endsWith('.mjs')) {
    // `node <script>` works on every platform (Windows cannot exec-spawn a
    // shebang script or a .cmd shim).
    return { mode: 'local-clone', command: 'node', baseArgs: [abs], machineSpecific: true };
  }
  return { mode: 'local-clone', command: abs, baseArgs: [], machineSpecific: true };
}

/**
 * Rewrite a machine-specific invocation for HOOK entries: a bin path inside
 * the project becomes `${CLAUDE_PROJECT_DIR}/<rel>` — Claude Code substitutes
 * that placeholder in exec-form hooks (both the `command` field and each
 * `args` element, per the hooks reference) and also exports it as an env var
 * on the spawned process. Hook config placeholders are NOT expanded for MCP
 * server entries, so the MCP entry keeps the absolute path; this only applies
 * to the hooks config system.
 */
function hookInvocationFor(invocation, { cwd, global: isGlobal }) {
  if (isGlobal || !invocation.machineSpecific) {
    return invocation;
  }
  const rewrite = (p) => {
    if (typeof p !== 'string' || !path.isAbsolute(p)) {
      return p;
    }
    const rel = path.relative(cwd, p);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return p;
    }
    return `\${CLAUDE_PROJECT_DIR}/${rel.split(path.sep).join('/')}`;
  };
  return {
    ...invocation,
    command: invocation.command === 'node' ? invocation.command : rewrite(invocation.command),
    baseArgs: invocation.baseArgs.map(rewrite),
  };
}

/** The single-string identity of an invocation, used for MCP dedupe. */
function commandString(entry) {
  const args = Array.isArray(entry?.args) ? entry.args : [];
  return [entry?.command, ...args].filter(Boolean).join(' ');
}

// --- sentinel identity -----------------------------------------------------

/**
 * True when a hook handler was written by LaPis. The sentinel is the exact
 * argument grammar the installer emits — an args array containing the adjacent
 * tokens `claude-code`, `hook`, `<Event>` — which holds for every resolution
 * strategy (npx, global bin, `node <script>`, arbitrary `--bin` paths). A
 * loose substring match would false-positive on user scripts with names like
 * `claude-code-hook.sh` and get them deleted on install/uninstall.
 */
function isLapisHookHandler(handler) {
  if (!handler || typeof handler !== 'object' || !Array.isArray(handler.args)) {
    return false;
  }
  const i = handler.args.indexOf('claude-code');
  return i !== -1 && handler.args[i + 1] === 'hook' && typeof handler.args[i + 2] === 'string';
}

/** Does this path/name look like a LaPis executable or entry script? */
function isLapisBinName(value) {
  const base = path.basename(String(value || '')).toLowerCase();
  return base.startsWith('lapis') || base.startsWith('memory-store') || base === 'cli.js';
}

/**
 * True when an MCP server entry is a LaPis server (sentinel identity). This
 * must be precise enough for name-independent removal on uninstall, so a
 * generic `npx -y <other-package> mcp` or `node <other-server>.js mcp` must
 * NOT match: the entry has to spawn `mcp` via the published package name or a
 * LaPis-named bin/script.
 */
function isLapisMcpEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return false;
  }
  if (commandString(entry).includes(PACKAGE_NAME)) {
    return true;
  }
  const args = Array.isArray(entry.args) ? entry.args : [];
  if (args[args.length - 1] !== 'mcp') {
    return false;
  }
  const base = path.basename(String(entry.command || '')).toLowerCase();
  if (base === 'node' || base === 'node.exe') {
    return isLapisBinName(args[0]);
  }
  return isLapisBinName(entry.command);
}

// --- hook config builder ---------------------------------------------------

/** Build one exec-form command hook handler. */
function hookHandler(invocation, event, { timeout, async: isAsync, ifRule, extraArgs = [] } = {}) {
  const handler = {
    type: 'command',
    command: invocation.command,
    args: [...invocation.baseArgs, 'claude-code', 'hook', event, ...extraArgs],
  };
  if (ifRule) {
    handler.if = ifRule;
  }
  if (typeof timeout === 'number') {
    handler.timeout = timeout;
  }
  if (isAsync) {
    handler.async = true;
  }
  return handler;
}

/**
 * The full LaPis hook configuration (issue #209 spec):
 *   - SessionStart `startup|resume|clear` and `compact` as SEPARATE matcher
 *     groups (compact re-injects only; the handler branches on `source`).
 *   - PreToolUse `Read|Grep|Glob` (timeout 15), `Bash` gated per raw-search
 *     command via `if` rules, and `mcp__<name>__.*` for the memory-tool cadence.
 *   - UserPromptSubmit / PostToolUse / Stop / SessionEnd have NO matcher.
 *   - Heavy handlers run `async: true`: git-trust (PostToolUse `--only`
 *     split so tracking/mirroring stays synchronous) and Stop
 *     (passive-capture + checkpoint + dream).
 *
 * Bash command-prefix `if` rules are intentionally NOT used: Claude Code
 * evaluates `if` as a literal command-prefix match, so `cd repo && git pull`
 * or `ls | grep foo` would bypass the guardrail entirely. The Bash matcher is
 * a single bare `Bash` group and the handlers themselves do the real
 * classification (GIT_TRUST_OP_RE / RAW_CODE_DISCOVERY_RE), returning null
 * fast for non-matching commands (#225, #226).
 */
function buildHookGroups(invocation, mcpName) {
  const h = (event, opts) => hookHandler(invocation, event, opts);
  return {
    SessionStart: [
      { matcher: 'startup|resume|clear', hooks: [h('SessionStart', { timeout: 30 })] },
      { matcher: 'compact', hooks: [h('SessionStart', { timeout: 30 })] },
    ],
    UserPromptSubmit: [{ hooks: [h('UserPromptSubmit', { timeout: 30 })] }],
    PreToolUse: [
      { matcher: 'Read|Grep|Glob', hooks: [h('PreToolUse', { timeout: 15 })] },
      { matcher: 'Bash', hooks: [h('PreToolUse', { timeout: 15 })] },
      { matcher: `mcp__${mcpName}__.*`, hooks: [h('PreToolUse', { timeout: 15 })] },
    ],
    PostToolUse: [
      {
        hooks: [
          // Tracking + tool-state mirroring stays synchronous so the next
          // PreToolUse sees fresh state (edit-track, exploredFiles, recall).
          h('PostToolUse', { timeout: 15, extraArgs: ['--skip', 'git-trust'] }),
          // git-trust is heavy (sync-code-trust over the repo) → background.
          // No `if` prefix rule: the handler's GIT_TRUST_OP_RE does the real
          // check, so compound commands like `cd repo && git pull` are covered.
          h('PostToolUse', {
            timeout: 60,
            async: true,
            extraArgs: ['--only', 'git-trust'],
          }),
        ],
      },
    ],
    Stop: [{ hooks: [h('Stop', { timeout: 60, async: true })] }],
    SessionEnd: [{ hooks: [h('SessionEnd', { timeout: 30 })] }],
  };
}

/** Remove every LaPis hook handler from a settings object (sentinel identity). */
function stripLapisHooks(settings) {
  if (!settings || typeof settings !== 'object' || !settings.hooks || typeof settings.hooks !== 'object') {
    return settings;
  }
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) {
      continue;
    }
    const kept = [];
    for (const group of groups) {
      if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) {
        kept.push(group);
        continue;
      }
      const remaining = group.hooks.filter((handler) => !isLapisHookHandler(handler));
      if (remaining.length > 0) {
        kept.push({ ...group, hooks: remaining });
      }
    }
    if (kept.length > 0) {
      settings.hooks[event] = kept;
    } else {
      delete settings.hooks[event];
    }
  }
  // The (possibly now-empty) `hooks` key is kept in place so a re-install
  // preserves key order (byte-identical idempotency); uninstall drops it.
  return settings;
}

/** Merge the LaPis hook groups into a settings object (strip-then-append). */
function mergeHookGroups(settings, groups) {
  stripLapisHooks(settings);
  if (!settings.hooks || typeof settings.hooks !== 'object') {
    settings.hooks = {};
  }
  for (const [event, lapisGroups] of Object.entries(groups)) {
    const existing = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    settings.hooks[event] = [...existing, ...lapisGroups];
  }
  return settings;
}

// --- permissions (--auto-allow) --------------------------------------------

function autoAllowRule(mcpName) {
  return `mcp__${mcpName}__*`;
}

function addAutoAllow(settings, mcpName) {
  if (!settings.permissions || typeof settings.permissions !== 'object') {
    settings.permissions = {};
  }
  if (!Array.isArray(settings.permissions.allow)) {
    settings.permissions.allow = [];
  }
  const rule = autoAllowRule(mcpName);
  if (!settings.permissions.allow.includes(rule)) {
    settings.permissions.allow.push(rule);
  }
  return settings;
}

function removeAutoAllow(settings, mcpName) {
  const allow = settings?.permissions?.allow;
  if (!Array.isArray(allow)) {
    return settings;
  }
  const rule = autoAllowRule(mcpName);
  settings.permissions.allow = allow.filter((r) => r !== rule);
  if (settings.permissions.allow.length === 0) {
    delete settings.permissions.allow;
  }
  if (Object.keys(settings.permissions).length === 0) {
    delete settings.permissions;
  }
  return settings;
}

// --- MCP entry --------------------------------------------------------------

function buildMcpEntry(invocation) {
  return { command: invocation.command, args: [...invocation.baseArgs, 'mcp'] };
}

/**
 * Upsert the LaPis server into an `mcpServers` map. Dedupes by name (overwrite)
 * AND by resolved command string (a `--mcp-name` rename must not leave the old
 * entry spawning a second server).
 */
function upsertMcpServer(servers, mcpName, entry) {
  const target = commandString(entry);
  for (const [name, existing] of Object.entries(servers)) {
    if (name !== mcpName && isLapisMcpEntry(existing) && commandString(existing) === target) {
      delete servers[name];
    }
  }
  servers[mcpName] = entry;
  return servers;
}

// --- JSON + CLAUDE.md file I/O ----------------------------------------------

/** Read a JSON config file. Missing → {}. Corrupt → throw (never clobber). */
function readJson(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      return {};
    }
    throw e;
  }
  if (!raw.trim()) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Refusing to overwrite corrupt JSON at ${filePath}: ${e.message}`, { cause: e });
  }
}

/**
 * Atomic write (temp file + rename, same pattern as state-store.js): a crash
 * or ENOSPC mid-write must never leave a truncated config — `~/.claude.json`
 * also holds the user's OAuth state. Preserves the existing file mode
 * (`~/.claude.json` is typically 0600).
 */
function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let mode;
  try {
    mode = fs.statSync(filePath).mode & 0o777;
  } catch {
    // New file → default mode.
  }
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(
    tmpPath,
    `${JSON.stringify(value, null, 2)}\n`,
    mode === undefined ? { encoding: 'utf8' } : { encoding: 'utf8', mode },
  );
  if (mode !== undefined) {
    // writeFileSync's mode only applies at creation; enforce it explicitly.
    fs.chmodSync(tmpPath, mode);
  }
  fs.renameSync(tmpPath, filePath);
}

/** True when a config object carries no meaningful keys anymore. */
function isEmptyConfig(value) {
  if (!value || typeof value !== 'object') {
    return true;
  }
  return Object.entries(value).every(([, v]) => {
    if (v === null || v === undefined) {
      return true;
    }
    if (Array.isArray(v)) {
      return v.length === 0;
    }
    if (typeof v === 'object') {
      return isEmptyConfig(v);
    }
    return false;
  });
}

/** Write back a mutated config, deleting the file when nothing remains. */
function writeJsonOrRemove(filePath, value) {
  if (isEmptyConfig(value)) {
    try {
      fs.unlinkSync(filePath);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        throw e;
      }
    }
    return false;
  }
  writeJson(filePath, value);
  return true;
}

/**
 * The CLAUDE.md memory-usage protocol block — the Claude Code equivalent of
 * the repo's AGENTS.md "Protocols" section, delimited so re-install replaces
 * it in place and uninstall removes exactly this block.
 */
function claudeMdBlock(mcpName) {
  return [
    CLAUDE_MD_START,
    '## LaPis Memory Protocol',
    '',
    `LaPis is the persistent memory stack for this workspace (MCP tools prefixed \`mcp__${mcpName}__\`).`,
    '',
    '### Code & doc retrieval',
    '',
    '- Prefer `memory-code` for code lookups (modes: outline, callers, callees, blast-radius,',
    '  dead-code, complexity, deps, churn, hotspots, cycles, importance, coupling, search)',
    '  instead of raw file reads or grep in an indexed repo.',
    '- Prefer `memory-doc` for documentation lookups (search, outline, backlinks, glossary).',
    '- Run `memory-code outline` on a file before reading it; then use targeted',
    '  offset/limit reads for editing.',
    '- Use `memory-code search` for semantic queries; use plain grep only for exact',
    '  single-symbol lookups.',
    '',
    '### Persistent memory',
    '',
    '- `memory-save` — decisions, bugfixes, architecture constraints, patterns, discoveries.',
    '  Always `memory-search` first to avoid duplicates.',
    '- `memory-search` — before making decisions, to avoid repeating past mistakes or',
    '  re-deciding settled questions.',
    '- `memory-get` / `memory-related` — read one memory in full / find memories linked',
    '  to the same code symbol.',
    '- `memory-update` / `memory-delete` — correct or remove stale memories in place',
    '  instead of saving a correction entry.',
    '',
    '### Content format for saves',
    '',
    'Use **What/Why/Where/Learned** in the content field:',
    '',
    '```',
    '**What**: …',
    '**Why**: …',
    '**Where**: …',
    '**Learned**: …',
    '```',
    CLAUDE_MD_END,
  ].join('\n');
}

/**
 * Read a CLAUDE.md file WITHOUT following a symlink. A symlinked CLAUDE.md is
 * unexpected for a project memory-protocol file and is a known arbitrary-file-
 * write vector for a malicious repo (commit `.claude/CLAUDE.md` → `~/.bashrc`,
 * then `install` writes through the link). Treat a symlink as absent so we
 * neither leak the target's contents into the block nor write back through it.
 * Returns { existed: bool, content: string }.
 */
function readClaudeMdSafe(filePath) {
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) {
      return { existed: false, content: '' };
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      throw e;
    }
    return { existed: false, content: '' };
  }
  try {
    return { existed: true, content: fs.readFileSync(filePath, 'utf8') };
  } catch (e) {
    if (e.code === 'ENOENT') {
      return { existed: false, content: '' };
    }
    throw e;
  }
}

/**
 * Atomic text write (temp + rename), matching writeJson's discipline so a crash
 * mid-write never leaves a truncated file and a symlink at the path is REPLACED
 * by a regular file rather than written through. The previous direct
 * writeFileSync followed symlinks (see readClaudeMdSafe).
 */
function writeTextAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

/** Insert or replace the delimited LaPis block in a CLAUDE.md file. */
function upsertClaudeMdBlock(filePath, block) {
  const { existed, content: existing } = readClaudeMdSafe(filePath);
  // If a symlink is in the way, remove the link itself (NOT its target) so the
  // atomic rename below installs a fresh regular file.
  if (existed === false) {
    try {
      if (fs.lstatSync(filePath).isSymbolicLink()) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // raced away — the atomic rename below still produces a regular file
    }
  }
  const start = existing.indexOf(CLAUDE_MD_START);
  const end = existing.indexOf(CLAUDE_MD_END);
  let next;
  if (start !== -1 && end !== -1 && end > start) {
    next = existing.slice(0, start) + block + existing.slice(end + CLAUDE_MD_END.length);
  } else if (existing.trim()) {
    next = `${existing.replace(/\n*$/, '\n\n')}${block}\n`;
  } else {
    next = `${block}\n`;
  }
  writeTextAtomic(filePath, next);
}

/** Remove the delimited LaPis block; delete the file when nothing else remains. */
function removeClaudeMdBlock(filePath) {
  const { existed, content: existing } = readClaudeMdSafe(filePath);
  if (!existed) {
    // A bare symlink (no block to remove) — unlink the LINK only, never a target.
    try {
      if (fs.lstatSync(filePath).isSymbolicLink()) {
        fs.unlinkSync(filePath);
        return true;
      }
    } catch {
      // already gone
    }
    return false;
  }
  const start = existing.indexOf(CLAUDE_MD_START);
  const end = existing.indexOf(CLAUDE_MD_END);
  if (start === -1 || end === -1 || end <= start) {
    return false;
  }
  const next = (existing.slice(0, start) + existing.slice(end + CLAUDE_MD_END.length)).replace(/\n{3,}/g, '\n\n');
  if (!next.trim()) {
    fs.unlinkSync(filePath);
  } else {
    writeTextAtomic(filePath, next);
  }
  return true;
}

// --- path routing ------------------------------------------------------------

function resolveIo(io = {}) {
  const home = io.home || process.env.HOME || process.env.USERPROFILE || os.homedir();
  const cwd = path.resolve(io.cwd || process.cwd());
  const log = io.log || ((line) => process.stdout.write(`${line}\n`));
  return { home, cwd, log };
}

function configPaths({ home, cwd }) {
  return {
    projectMcp: path.join(cwd, '.mcp.json'),
    projectSettings: path.join(cwd, '.claude', 'settings.json'),
    localSettings: path.join(cwd, '.claude', 'settings.local.json'),
    projectClaudeMd: path.join(cwd, '.claude', 'CLAUDE.md'),
    userSettings: path.join(home, '.claude', 'settings.json'),
    userClaudeMd: path.join(home, '.claude', 'CLAUDE.md'),
    claudeJson: path.join(home, '.claude.json'),
  };
}

/**
 * Route the two config systems for this install shape.
 *
 * | shape                     | MCP target                              | hooks target          |
 * | project (default)         | .mcp.json                               | .claude/settings.json |
 * | project + machine `--bin` | ~/.claude.json projects[cwd].mcpServers | settings.local.json   |
 * | --global                  | ~/.claude.json mcpServers (user scope)  | ~/.claude/settings.json |
 */
function routeTargets(flags, invocation, paths, cwd) {
  if (flags.global) {
    return {
      hooksFile: paths.userSettings,
      claudeMdFile: paths.userClaudeMd,
      mcp: { kind: 'user', file: paths.claudeJson },
    };
  }
  if (invocation.machineSpecific) {
    return {
      hooksFile: paths.localSettings,
      claudeMdFile: paths.projectClaudeMd,
      mcp: { kind: 'local', file: paths.claudeJson, projectKey: cwd },
    };
  }
  return {
    hooksFile: paths.projectSettings,
    claudeMdFile: paths.projectClaudeMd,
    mcp: { kind: 'project', file: paths.projectMcp },
  };
}

/** Get (creating as needed) the mcpServers map for a routed MCP target. */
function mcpServersFor(config, target) {
  if (target.kind === 'project' || target.kind === 'user') {
    if (!config.mcpServers || typeof config.mcpServers !== 'object') {
      config.mcpServers = {};
    }
    return config.mcpServers;
  }
  // local scope: ~/.claude.json → projects[<cwd>].mcpServers
  if (!config.projects || typeof config.projects !== 'object') {
    config.projects = {};
  }
  if (!config.projects[target.projectKey] || typeof config.projects[target.projectKey] !== 'object') {
    config.projects[target.projectKey] = {};
  }
  const project = config.projects[target.projectKey];
  if (!project.mcpServers || typeof project.mcpServers !== 'object') {
    project.mcpServers = {};
  }
  return project.mcpServers;
}

// --- install ------------------------------------------------------------------

/**
 * Run `lapis claude-code install`.
 *
 * @param {string[]} argv  flags after `install`
 * @param {{ cwd?: string, home?: string, log?: Function }} [io]  injectable for tests
 * @returns {{ written: string[], mcpScope: string, mcpName: string, invocation: object, daemon: object|null }}
 */
async function runInstall(argv, io) {
  const flags = parseFlags(argv);
  const { home, cwd, log } = resolveIo(io);
  const invocation = resolveInvocation(flags, { cwd });
  const paths = configPaths({ home, cwd });
  const targets = routeTargets(flags, invocation, paths, cwd);
  const written = [];

  // READ PHASE — parse every target file before writing any of them, so a
  // corrupt file aborts the whole install instead of leaving a half-installed
  // state (readJson throws on corrupt JSON rather than clobbering it).
  const mcpConfig = readJson(targets.mcp.file);
  const settings = readJson(targets.hooksFile);

  // WRITE PHASE.
  // 1. MCP server config (one of the two config systems).
  upsertMcpServer(mcpServersFor(mcpConfig, targets.mcp), flags.mcpName, buildMcpEntry(invocation));
  writeJson(targets.mcp.file, mcpConfig);
  written.push(targets.mcp.file);

  // 2. Hooks config (the other config system) — plus optional auto-allow.
  const groups = buildHookGroups(hookInvocationFor(invocation, { cwd, global: flags.global }), flags.mcpName);
  mergeHookGroups(settings, groups);
  if (flags.autoAllow) {
    addAutoAllow(settings, flags.mcpName);
  }
  writeJson(targets.hooksFile, settings);
  written.push(targets.hooksFile);

  // 3. CLAUDE.md memory protocol block (optional, default on).
  if (flags.claudeMd) {
    upsertClaudeMdBlock(targets.claudeMdFile, claudeMdBlock(flags.mcpName));
    written.push(targets.claudeMdFile);
  }

  const dispatchMode = flags.daemon ? 'daemon' : invocation.mode;
  log(`Installed LaPis for Claude Code (${dispatchMode} dispatch).`);
  log(`  MCP server "${flags.mcpName}" (${targets.mcp.kind} scope) → ${targets.mcp.file}`);
  log(`  Hooks → ${targets.hooksFile}`);
  if (flags.claudeMd) {
    log(`  Memory protocol → ${targets.claudeMdFile}`);
  }
  if (targets.mcp.kind === 'project') {
    log('');
    log('Note: project .mcp.json servers require first-use approval — the server shows');
    log('"⏸ Pending approval" until you approve it via /mcp inside an interactive `claude` session.');
  }
  if (targets.hooksFile === paths.localSettings) {
    log('');
    log('Note: .claude/settings.local.json holds a machine-specific path; keep it gitignored.');
  }
  if (!flags.autoAllow) {
    log('Tip: pass --auto-allow to pre-approve mcp__' + flags.mcpName + '__* tool permissions.');
  }

  let daemon = null;
  if (flags.daemon) {
    const { runStart } = require('./daemon');
    daemon = await runStart(['--detached', '--port', String(flags.daemonPort)], io);
    log('');
    if (daemon?.alreadyRunning && daemon?.mismatch) {
      // runStart already warned; report the port hooks will actually POST to.
      log(
        `Daemon mode requested port ${flags.daemonPort}, but the running daemon is on port ${daemon.port}` +
          ` — hooks will POST to port ${daemon.port}. Run \`lapis claude-code stop\` to relocate it.`,
      );
    } else {
      log(`Daemon mode enabled (port ${flags.daemonPort}) — hooks will POST to /dispatch.`);
    }
    log('Stop with: lapis claude-code stop');
  }

  return { written, mcpScope: targets.mcp.kind, mcpName: flags.mcpName, invocation, daemon };
}

module.exports = {
  PACKAGE_NAME,
  DEFAULT_MCP_NAME,
  CLAUDE_MD_START,
  CLAUDE_MD_END,
  parseFlags,
  resolveInvocation,
  hookInvocationFor,
  commandString,
  isLapisHookHandler,
  isLapisMcpEntry,
  hookHandler,
  buildHookGroups,
  stripLapisHooks,
  mergeHookGroups,
  addAutoAllow,
  removeAutoAllow,
  autoAllowRule,
  buildMcpEntry,
  upsertMcpServer,
  readJson,
  writeJson,
  writeJsonOrRemove,
  isEmptyConfig,
  claudeMdBlock,
  upsertClaudeMdBlock,
  removeClaudeMdBlock,
  readClaudeMdSafe,
  writeTextAtomic,
  resolveIo,
  configPaths,
  routeTargets,
  mcpServersFor,
  runInstall,
};
