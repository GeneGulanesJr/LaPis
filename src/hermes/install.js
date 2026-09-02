'use strict';

/**
 * Hermes Agent installer — `lapis hermes install`.
 *
 * Wires LaPis into a Hermes Agent installation the same way `claude-code
 * install` wires Claude Code, over two separate config systems in the Hermes
 * config file (`$HERMES_HOME/config.yaml`, default `~/.hermes/config.yaml`):
 *
 *   - MCP tools   → `mcp_servers.lapis` (stdio server, `memory-store.js mcp`)
 *   - Hooks       → `hooks:` shell-hook entries + `hooks_auto_accept` +
 *                   first-use consent in `$HERMES_HOME/shell-hooks-allowlist.json`
 *   - Skill       → bundled `hermes/SKILL.md` copied to
 *                   `$HERMES_HOME/skills/memory/lapis/SKILL.md`
 *
 * The MCP server entry pins `LAPIS_HOME` to the installing user's home so the
 * server and CLI always share the same SQLite database, regardless of how the
 * Hermes process was launched (see db.js LAPIS_HOME resolution).
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
    yamlScalar,
    upsertSubBlock,
    upsertListItem,
    upsertScalar,
    readText,
    writeTextAtomic,
  } = require('./config-editor'),
  DEFAULT_MCP_NAME = 'lapis',
  ALLOWLIST_FILENAME = 'shell-hooks-allowlist.json',
  SKILL_SOURCE = path.resolve(__dirname, '..', '..', 'hermes', 'SKILL.md'),
  SKILL_DEST_REL = ['skills', 'memory', 'lapis', 'SKILL.md'],
  // Hermes shell-hook events LaPis wires. Matchers are regex fullmatch on the
  // Hermes tool name; the same hook command handles every event (the event and
  // tool arrive on stdin — see hook.js).
  HOOK_EVENTS = [
    { event: 'pre_tool_call', matcher: '^(read_file|search_files)$', timeout: 15 },
    { event: 'post_tool_call', matcher: '^(write_file|patch)$', timeout: 20 },
    { event: 'pre_llm_call', matcher: null, timeout: 15 },
    { event: 'on_session_start', matcher: null, timeout: 20 },
    { event: 'on_session_end', matcher: null, timeout: 20 },
  ];

function parseFlags(argv) {
  const flags = {
      mcpName: DEFAULT_MCP_NAME,
      home: null,
      skill: true,
      hooks: true,
    },
    args = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--mcp-name') {
      const v = args[++i];
      if (!v || !/^[A-Za-z0-9_-]+$/.test(v)) {
        throw new Error('--mcp-name requires a value matching [A-Za-z0-9_-]+');
      }
      flags.mcpName = v;
    } else if (a === '--home') {
      const v = args[++i];
      if (!v) {
        throw new Error('--home requires a path');
      }
      flags.home = v;
    } else if (a === '--no-skill') {
      flags.skill = false;
    } else if (a === '--no-hooks') {
      flags.hooks = false;
    } else {
      throw new Error(`Unknown flag: ${a}`);
    }
  }
  return flags;
}

/** Resolve the Hermes home directory (config + skills + allowlist live here). */
function resolveHermesHome(flags, io) {
  if (flags.home) {
    return path.resolve(flags.home);
  }
  if (io && io.home) {
    return path.resolve(io.home);
  }
  if (process.env.HERMES_HOME) {
    return path.resolve(process.env.HERMES_HOME);
  }
  return path.join(os.homedir(), '.hermes');
}

function hermesPaths(home) {
  return {
    config: path.join(home, 'config.yaml'),
    allowlist: path.join(home, ALLOWLIST_FILENAME),
    skillFile: path.join(home, ...SKILL_DEST_REL),
  };
}

/** Absolute path to this repo's `memory-store.js` entry point. */
function lapisEntryPoint() {
  return path.resolve(__dirname, '..', '..', 'memory-store.js');
}

/** The single-string shell command Hermes uses to spawn the hook handler. */
function hookCommand() {
  const node = process.execPath,
    script = lapisEntryPoint();
  return `${yamlScalar(node)} ${yamlScalar(script)} hermes hook`;
}

/** The `mcp_servers.<name>` entry (body lines relative to the sub-key). */
function buildMcpEntry(flags, home) {
  const script = lapisEntryPoint();
  return {
    command: yamlScalar(process.execPath),
    args: [yamlScalar(script), 'mcp'],
    env: { LAPIS_HOME: home },
    enabled: true,
  };
}

function mcpBodyLines(flags, home) {
  const entry = buildMcpEntry(flags, home),
    lines = [`command: ${entry.command}`, 'args:'];
  for (const a of entry.args) {
    lines.push(`  - ${a}`);
  }
  lines.push('env:', `  LAPIS_HOME: ${yamlScalar(entry.env.LAPIS_HOME)}`, `enabled: ${entry.enabled}`);
  return lines;
}

/** Hook list-item lines (relative to the item, rendered at indent 4). */
function hookItemLines(event) {
  const lines = [];
  if (event.matcher) {
    lines.push(`- matcher: ${yamlScalar(event.matcher)}`);
  } else {
    lines.push(`- command: ${yamlScalar(hookCommand())}`);
    lines.push(`  timeout: ${event.timeout}`);
    return lines;
  }
  lines.push(`  command: ${yamlScalar(hookCommand())}`);
  lines.push(`  timeout: ${event.timeout}`);
  return lines;
}

/** Merge our approvals into the Hermes shell-hook allowlist (deduped). */
function mergeAllowlist(filePath, command) {
  let data = { approvals: [] };
  try {
    data = JSON.parse(readText(filePath) || '{}');
  } catch {
    data = { approvals: [] };
  }
  if (!Array.isArray(data.approvals)) {
    data.approvals = [];
  }
  for (const { event } of HOOK_EVENTS) {
    if (!data.approvals.some((a) => a && a.event === event && a.command === command)) {
      data.approvals.push({ event, command });
    }
  }
  writeTextAtomic(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

async function runInstall(argv, io = {}) {
  const flags = parseFlags(argv),
    home = resolveHermesHome(flags, io),
    paths = hermesPaths(home),
    log = io.log || ((l) => console.log(l)),
    written = [],
    command = hookCommand();

  // READ + WRITE phase: single read, then staged text edits, then one atomic
  // Write. A corrupt/absent config starts empty — install never crashes the
  // User's config, and only touches the keys LaPis owns.
  let text = readText(paths.config);

  text = upsertSubBlock(text, 'mcp_servers', flags.mcpName, mcpBodyLines(flags, home));
  written.push(paths.config);

  if (flags.hooks) {
    for (const hook of HOOK_EVENTS) {
      text = upsertListItem(text, 'hooks', hook.event, hookItemLines(hook), command);
    }
    text = upsertScalar(text, 'hooks_auto_accept', 'true');
    written.push(paths.config);
    mergeAllowlist(paths.allowlist, command);
    written.push(paths.allowlist);
  }

  if (text.trim() !== '') {
    writeTextAtomic(paths.config, text);
  }

  let skillInstalled = false;
  if (flags.skill && fs.existsSync(SKILL_SOURCE)) {
    fs.mkdirSync(path.dirname(paths.skillFile), { recursive: true });
    fs.copyFileSync(SKILL_SOURCE, paths.skillFile);
    written.push(paths.skillFile);
    skillInstalled = true;
  }

  log(`Installed LaPis for Hermes Agent.`);
  log(`  Hermes home → ${home}`);
  log(`  MCP server "${flags.mcpName}" → ${paths.config}`);
  if (flags.hooks) {
    log(`  Hooks (${HOOK_EVENTS.map((h) => h.event).join(', ')}) → ${paths.config}`);
    log(`  Hook consent → ${paths.allowlist}`);
  }
  if (skillInstalled) {
    log(`  Skill → ${paths.skillFile}`);
  }
  log('');
  log('Next steps:');
  log('  - Restart Hermes (or run /reload-mcp in a session) to load the MCP tools.');
  log('  - Hooks register at process start; hooks_auto_accept is set so no consent prompts appear.');
  log('  - Verify with: lapis hermes doctor');

  return { written, home, mcpName: flags.mcpName, config: paths.config };
}

module.exports = {
  DEFAULT_MCP_NAME,
  ALLOWLIST_FILENAME,
  HOOK_EVENTS,
  parseFlags,
  resolveHermesHome,
  hermesPaths,
  lapisEntryPoint,
  hookCommand,
  buildMcpEntry,
  mcpBodyLines,
  hookItemLines,
  mergeAllowlist,
  runInstall,
};
