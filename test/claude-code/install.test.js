const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const install = require('../../src/claude-code/install'),
  { runInstall } = install;
const { runUninstall } = require('../../src/claude-code/uninstall');
const doctor = require('../../src/claude-code/doctor');
const { parseRoleFilter } = require('../../src/claude-code/hooks');
const { handlePostToolUse } = require('../../src/claude-code/handlers/post-tool-use');
const realStateStore = require('../../src/claude-code/state-store');
const { postToolRole, preToolRole, mcpToolName } = require('../../src/claude-code/tool-map');

// ---- helpers ----

function makeIo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-cc-install-')),
    cwd = path.join(root, 'project'),
    home = path.join(root, 'home');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const lines = [];
  return { cwd, home, log: (l) => lines.push(l), lines, root };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function allHandlers(settings, event) {
  return (settings.hooks[event] || []).flatMap((g) => g.hooks || []);
}

// =====================================================================
// RunInstall — default project-scoped install
// =====================================================================

describe('claude-code install: default (npx, project scope)', () => {
  let io;
  beforeEach(async () => {
    io = makeIo();
    await runInstall([], io);
  });

  test('.mcp.json gets the committable npx server entry', async () => {
    const mcp = readJson(path.join(io.cwd, '.mcp.json'));
    expect(mcp.mcpServers.lapis).toEqual({
      command: 'npx',
      args: ['-y', '@genegulanesjr/lapis', 'mcp'],
    });
  });

  test('hooks land in .claude/settings.json, never settings.local.json', async () => {
    expect(fs.existsSync(path.join(io.cwd, '.claude', 'settings.json'))).toBe(true);
    expect(fs.existsSync(path.join(io.cwd, '.claude', 'settings.local.json'))).toBe(false);
    expect(fs.existsSync(path.join(io.home, '.claude', 'settings.json'))).toBe(false);
  });

  test('SessionStart has separate startup|resume|clear and compact matcher groups', async () => {
    const settings = readJson(path.join(io.cwd, '.claude', 'settings.json')),
      matchers = settings.hooks.SessionStart.map((g) => g.matcher);
    expect(matchers).toEqual(['startup|resume|clear', 'compact']);
  });

  test('every handler is exec-form (command + args array) invoking claude-code hook <Event>', async () => {
    const settings = readJson(path.join(io.cwd, '.claude', 'settings.json'));
    for (const event of Object.keys(settings.hooks)) {
      for (const h of allHandlers(settings, event)) {
        expect(h.type).toBe('command');
        expect(h.command).toBe('npx');
        expect(Array.isArray(h.args)).toBe(true);
        expect(h.args.slice(0, 4)).toEqual(['-y', '@genegulanesjr/lapis', 'claude-code', 'hook']);
        expect(h.args[4]).toBe(event);
      }
    }
  });

  test('PreToolUse: Read|Grep|Glob (timeout 15), a single bare Bash matcher, mcp__lapis__.* cadence', async () => {
    const settings = readJson(path.join(io.cwd, '.claude', 'settings.json')),
      groups = settings.hooks.PreToolUse;
    expect(groups.map((g) => g.matcher)).toEqual(['Read|Grep|Glob', 'Bash', 'mcp__lapis__.*']);
    expect(groups[0].hooks[0].timeout).toBe(15);
    // Bash is one handler with NO `if` prefix rule — the handler classifies
    // Compound commands itself (#225, #226).
    expect(groups[1].hooks).toHaveLength(1);
    expect(groups[1].hooks[0].if).toBeUndefined();
    expect(groups[1].hooks[0].timeout).toBe(15);
  });

  test('always-fire events carry NO matcher', async () => {
    const settings = readJson(path.join(io.cwd, '.claude', 'settings.json'));
    for (const event of ['UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd']) {
      for (const group of settings.hooks[event]) {
        expect(group.matcher).toBeUndefined();
      }
    }
  });

  test('heavy handlers are async: Stop, and the PostToolUse git-trust split', async () => {
    const settings = readJson(path.join(io.cwd, '.claude', 'settings.json')),
      stop = allHandlers(settings, 'Stop');
    expect(stop).toHaveLength(1);
    expect(stop[0].async).toBe(true);

    const post = allHandlers(settings, 'PostToolUse');
    expect(post).toHaveLength(2);
    const sync = post.find((h) => !h.async),
      asyncH = post.find((h) => h.async);
    expect(sync.args.slice(5)).toEqual(['--skip', 'git-trust']);
    expect(asyncH.args.slice(5)).toEqual(['--only', 'git-trust']);
    // No `if` prefix rule on git-trust: GIT_TRUST_OP_RE classifies compound
    // Commands like `cd repo && git pull` (#225).
    expect(asyncH.if).toBeUndefined();
  });

  test('CLAUDE.md protocol block is written between delimiters', async () => {
    const md = fs.readFileSync(path.join(io.cwd, '.claude', 'CLAUDE.md'), 'utf8');
    expect(md).toContain('<!-- lapis:start -->');
    expect(md).toContain('<!-- lapis:end -->');
    expect(md).toContain('**What**');
    expect(md).toContain('memory-code');
  });

  test('output surfaces the project .mcp.json first-use approval requirement', async () => {
    expect(io.lines.join('\n')).toContain('Pending approval');
  });
});

// =====================================================================
// Idempotency + dedupe
// =====================================================================

describe('claude-code install: idempotency', () => {
  test('re-install produces byte-identical config (no duplicate handlers or servers)', async () => {
    const io = makeIo();
    await runInstall(['--auto-allow'], io);
    const settingsPath = path.join(io.cwd, '.claude', 'settings.json'),
      mcpPath = path.join(io.cwd, '.mcp.json'),
      firstSettings = fs.readFileSync(settingsPath, 'utf8'),
      firstMcp = fs.readFileSync(mcpPath, 'utf8'),
      firstMd = fs.readFileSync(path.join(io.cwd, '.claude', 'CLAUDE.md'), 'utf8');

    await runInstall(['--auto-allow'], io);
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(firstSettings);
    expect(fs.readFileSync(mcpPath, 'utf8')).toBe(firstMcp);
    expect(fs.readFileSync(path.join(io.cwd, '.claude', 'CLAUDE.md'), 'utf8')).toBe(firstMd);
  });

  test('renaming via --mcp-name removes the stale same-command entry (dedupe by command string)', async () => {
    const io = makeIo();
    await runInstall([], io);
    await runInstall(['--mcp-name', 'pi-memory'], io);
    const mcp = readJson(path.join(io.cwd, '.mcp.json'));
    expect(Object.keys(mcp.mcpServers)).toEqual(['pi-memory']);
  });

  test('custom --mcp-name propagates to the PreToolUse MCP matcher', async () => {
    const io = makeIo();
    await runInstall(['--mcp-name', 'pi-memory'], io);
    const settings = readJson(path.join(io.cwd, '.claude', 'settings.json'));
    expect(settings.hooks.PreToolUse.map((g) => g.matcher)).toContain('mcp__pi-memory__.*');
  });
});

// =====================================================================
// --global
// =====================================================================

describe('claude-code install: --global', () => {
  test('MCP goes to ~/.claude.json user scope, hooks to ~/.claude/settings.json', async () => {
    const io = makeIo();
    await runInstall(['--global'], io);

    const claudeJson = readJson(path.join(io.home, '.claude.json'));
    expect(claudeJson.mcpServers.lapis.command).toBe('npx');
    expect(claudeJson.projects).toBeUndefined();

    const settings = readJson(path.join(io.home, '.claude', 'settings.json'));
    expect(settings.hooks.SessionStart).toBeDefined();

    // Project-scoped files stay untouched.
    expect(fs.existsSync(path.join(io.cwd, '.mcp.json'))).toBe(false);
    expect(fs.existsSync(path.join(io.cwd, '.claude', 'settings.json'))).toBe(false);

    // CLAUDE.md goes to the user scope too.
    expect(fs.existsSync(path.join(io.home, '.claude', 'CLAUDE.md'))).toBe(true);
  });
});

// =====================================================================
// Machine-specific --bin
// =====================================================================

describe('claude-code install: machine-specific --bin', () => {
  test('hooks route to settings.local.json, MCP to ~/.claude.json local scope; committable files untouched', async () => {
    const io = makeIo(),
      bin = path.join(io.root, 'clone', 'memory-store.js');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, '// stub', 'utf8');

    await runInstall(['--bin', bin], io);

    // NOT in committable files.
    expect(fs.existsSync(path.join(io.cwd, '.mcp.json'))).toBe(false);
    expect(fs.existsSync(path.join(io.cwd, '.claude', 'settings.json'))).toBe(false);

    const local = readJson(path.join(io.cwd, '.claude', 'settings.local.json')),
      handler = local.hooks.SessionStart[0].hooks[0];
    expect(handler.command).toBe('node');
    expect(handler.args[0]).toBe(bin);

    const claudeJson = readJson(path.join(io.home, '.claude.json'));
    expect(claudeJson.mcpServers).toBeUndefined(); // Not user scope
    expect(claudeJson.projects[io.cwd].mcpServers.lapis).toEqual({
      command: 'node',
      args: [bin, 'mcp'],
    });
  });

  test('a bin inside the project is rewritten to ${CLAUDE_PROJECT_DIR} in hook args only', async () => {
    const io = makeIo(),
      bin = path.join(io.cwd, 'vendor', 'lapis', 'memory-store.js');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, '// stub', 'utf8');

    await runInstall(['--bin', bin], io);

    const local = readJson(path.join(io.cwd, '.claude', 'settings.local.json')),
      handler = local.hooks.SessionStart[0].hooks[0];
    expect(handler.args[0]).toBe('${CLAUDE_PROJECT_DIR}/vendor/lapis/memory-store.js');

    // MCP servers do not receive CLAUDE_PROJECT_DIR → absolute path there.
    const claudeJson = readJson(path.join(io.home, '.claude.json'));
    expect(claudeJson.projects[io.cwd].mcpServers.lapis.args[0]).toBe(bin);
  });

  test('a bare --bin name is treated as PATH-relative (committable global-bin mode)', async () => {
    const io = makeIo();
    await runInstall(['--bin', 'lapis'], io);
    const mcp = readJson(path.join(io.cwd, '.mcp.json'));
    expect(mcp.mcpServers.lapis).toEqual({ command: 'lapis', args: ['mcp'] });
    const settings = readJson(path.join(io.cwd, '.claude', 'settings.json'));
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe('lapis');
  });
});

// =====================================================================
// --auto-allow / --no-claude-md / flag validation
// =====================================================================

describe('claude-code install: optional flags', () => {
  test('--auto-allow adds permissions.allow mcp__lapis__* (default off)', async () => {
    const io = makeIo();
    await runInstall([], io);
    let settings = readJson(path.join(io.cwd, '.claude', 'settings.json'));
    expect(settings.permissions).toBeUndefined();

    await runInstall(['--auto-allow'], io);
    settings = readJson(path.join(io.cwd, '.claude', 'settings.json'));
    expect(settings.permissions.allow).toEqual(['mcp__lapis__*']);
  });

  test('--no-claude-md skips the CLAUDE.md block', async () => {
    const io = makeIo();
    await runInstall(['--no-claude-md'], io);
    expect(fs.existsSync(path.join(io.cwd, '.claude', 'CLAUDE.md'))).toBe(false);
  });

  test('unknown flags and malformed --mcp-name throw', async () => {
    expect(() => install.parseFlags(['--bogus'])).toThrow(/Unknown flag/);
    expect(() => install.parseFlags(['--mcp-name', 'bad name!'])).toThrow(/mcp-name/);
    expect(() => install.parseFlags(['--bin'])).toThrow(/--bin/);
    expect(() => install.parseFlags(['--daemon-port', '0'])).toThrow(/daemon-port/);
  });

  test('--daemon invokes detached daemon start with --daemon-port', async () => {
    const io = makeIo();
    const daemonMod = require('../../src/claude-code/daemon'),
      startSpy = vi.spyOn(daemonMod, 'runStart').mockResolvedValue({
        pid: 12345,
        port: 9200,
        host: '127.0.0.1',
      }),
      result = await runInstall(['--daemon', '--daemon-port', '9200'], io);
    expect(startSpy).toHaveBeenCalledWith(['--detached', '--port', '9200'], io);
    expect(result.daemon.port).toBe(9200);
    expect(io.lines.some((l) => l.includes('daemon dispatch'))).toBe(true);
    startSpy.mockRestore();
  });
});

// =====================================================================
// Preserving unrelated config
// =====================================================================

describe('claude-code install: leaves unrelated config intact', () => {
  function seedForeignConfig(io) {
    fs.mkdirSync(path.join(io.cwd, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(io.cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'other-tool', args: ['serve'] } } }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(io.cwd, '.claude', 'settings.json'),
      JSON.stringify({
        model: 'opus',
        permissions: { allow: ['Bash(npm test)'] },
        hooks: {
          PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'my-linter', args: [] }] }],
        },
      }),
      'utf8',
    );
    fs.writeFileSync(path.join(io.cwd, '.claude', 'CLAUDE.md'), '# My project notes\n\nKeep these.\n', 'utf8');
  }

  test('install keeps foreign servers, hooks, permissions, and CLAUDE.md prose', async () => {
    const io = makeIo();
    seedForeignConfig(io);
    await runInstall(['--auto-allow'], io);

    const mcp = readJson(path.join(io.cwd, '.mcp.json'));
    expect(mcp.mcpServers.other).toEqual({ command: 'other-tool', args: ['serve'] });
    expect(mcp.mcpServers.lapis).toBeDefined();

    const settings = readJson(path.join(io.cwd, '.claude', 'settings.json'));
    expect(settings.model).toBe('opus');
    expect(settings.permissions.allow).toEqual(['Bash(npm test)', 'mcp__lapis__*']);
    const preGroups = settings.hooks.PreToolUse;
    expect(preGroups[0]).toEqual({
      matcher: 'Write',
      hooks: [{ type: 'command', command: 'my-linter', args: [] }],
    });

    const md = fs.readFileSync(path.join(io.cwd, '.claude', 'CLAUDE.md'), 'utf8');
    expect(md).toContain('# My project notes');
    expect(md).toContain('<!-- lapis:start -->');
  });

  test('uninstall restores the foreign config exactly and drops lapis-only files', async () => {
    const io = makeIo();
    seedForeignConfig(io);
    await runInstall(['--auto-allow'], io);
    await runUninstall([], io);

    const mcp = readJson(path.join(io.cwd, '.mcp.json'));
    expect(mcp).toEqual({ mcpServers: { other: { command: 'other-tool', args: ['serve'] } } });

    const settings = readJson(path.join(io.cwd, '.claude', 'settings.json'));
    expect(settings).toEqual({
      model: 'opus',
      permissions: { allow: ['Bash(npm test)'] },
      hooks: {
        PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'my-linter', args: [] }] }],
      },
    });

    const md = fs.readFileSync(path.join(io.cwd, '.claude', 'CLAUDE.md'), 'utf8');
    expect(md).toContain('# My project notes');
    expect(md).not.toContain('<!-- lapis:start -->');
  });

  test('refuses to clobber a corrupt settings file — and writes NOTHING (no partial install)', async () => {
    const io = makeIo();
    fs.mkdirSync(path.join(io.cwd, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(io.cwd, '.claude', 'settings.json'), '{ not json', 'utf8');
    await expect(runInstall([], io)).rejects.toThrow(/corrupt JSON/);
    expect(fs.readFileSync(path.join(io.cwd, '.claude', 'settings.json'), 'utf8')).toBe('{ not json');
    // All reads happen before any write: .mcp.json must not have been created.
    expect(fs.existsSync(path.join(io.cwd, '.mcp.json'))).toBe(false);
  });

  test('a user hook whose script path merely contains "claude-code"/"hook" survives install and uninstall', async () => {
    const io = makeIo(),
      foreign = {
        type: 'command',
        command: '/home/me/.claude/claude-code-hook.sh',
        args: ['--fast'],
      };
    fs.mkdirSync(path.join(io.cwd, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(io.cwd, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [foreign] }] } }),
      'utf8',
    );

    await runInstall([], io);
    let settings = readJson(path.join(io.cwd, '.claude', 'settings.json'));
    expect(settings.hooks.Stop[0].hooks).toContainEqual(foreign);

    await runUninstall([], io);
    settings = readJson(path.join(io.cwd, '.claude', 'settings.json'));
    expect(settings).toEqual({ hooks: { Stop: [{ hooks: [foreign] }] } });
  });

  test('unrelated ~/.claude.json content (OAuth state, other projects) survives a --bin install + uninstall', async () => {
    const io = makeIo(),
      claudeJsonPath = path.join(io.home, '.claude.json'),
      foreign = {
        oauthAccount: { accountUuid: 'abc-123', emailAddress: 'me@example.com' },
        projects: { '/other/project': { allowedTools: ['Bash'], history: [{ display: 'hi' }] } },
        mcpServers: { linear: { type: 'http', url: 'https://mcp.linear.app/sse' } },
      };
    fs.writeFileSync(claudeJsonPath, JSON.stringify(foreign), 'utf8');
    const bin = path.join(io.root, 'clone', 'memory-store.js');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, '// stub', 'utf8');

    await runInstall(['--bin', bin], io);
    let claudeJson = readJson(claudeJsonPath);
    expect(claudeJson.oauthAccount).toEqual(foreign.oauthAccount);
    expect(claudeJson.projects['/other/project']).toEqual(foreign.projects['/other/project']);
    expect(claudeJson.mcpServers).toEqual(foreign.mcpServers); // User scope untouched
    expect(claudeJson.projects[io.cwd].mcpServers.lapis).toBeDefined();

    await runUninstall([], io);
    claudeJson = readJson(claudeJsonPath);
    expect(claudeJson).toEqual(foreign);
  });

  test('re-install with the same --bin is byte-identical in ~/.claude.json and settings.local.json', async () => {
    const io = makeIo(),
      bin = path.join(io.root, 'clone', 'memory-store.js');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, '// stub', 'utf8');
    await runInstall(['--bin', bin], io);
    const claudeJsonPath = path.join(io.home, '.claude.json'),
      localPath = path.join(io.cwd, '.claude', 'settings.local.json'),
      firstClaudeJson = fs.readFileSync(claudeJsonPath, 'utf8'),
      firstLocal = fs.readFileSync(localPath, 'utf8');

    await runInstall(['--bin', bin], io);
    expect(fs.readFileSync(claudeJsonPath, 'utf8')).toBe(firstClaudeJson);
    expect(fs.readFileSync(localPath, 'utf8')).toBe(firstLocal);
  });
});

// =====================================================================
// Uninstall
// =====================================================================

describe('claude-code uninstall', () => {
  test('a clean project install is fully reversed (files removed when empty)', async () => {
    const io = makeIo();
    await runInstall([], io);
    const { cleaned } = await runUninstall([], io);
    expect(cleaned.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(io.cwd, '.mcp.json'))).toBe(false);
    expect(fs.existsSync(path.join(io.cwd, '.claude', 'settings.json'))).toBe(false);
    expect(fs.existsSync(path.join(io.cwd, '.claude', 'CLAUDE.md'))).toBe(false);
  });

  test('--global uninstall reverses a --global install', async () => {
    const io = makeIo();
    await runInstall(['--global'], io);
    await runUninstall(['--global'], io);
    expect(fs.existsSync(path.join(io.home, '.claude', 'settings.json'))).toBe(false);
    expect(fs.existsSync(path.join(io.home, '.claude', 'CLAUDE.md'))).toBe(false);
    // ~/.claude.json is never deleted, but the lapis entry is gone.
    const claudeJson = readJson(path.join(io.home, '.claude.json'));
    expect(claudeJson.mcpServers?.lapis).toBeUndefined();
  });

  test('uninstall reverses a machine-specific --bin install (local scope entry removed)', async () => {
    const io = makeIo(),
      bin = path.join(io.root, 'clone', 'memory-store.js');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, '// stub', 'utf8');
    await runInstall(['--bin', bin], io);
    await runUninstall([], io);
    expect(fs.existsSync(path.join(io.cwd, '.claude', 'settings.local.json'))).toBe(false);
    const claudeJson = readJson(path.join(io.home, '.claude.json'));
    expect(claudeJson.projects?.[io.cwd]?.mcpServers?.lapis).toBeUndefined();
  });

  test('uninstall without --mcp-name still reverses an install that used a custom name', async () => {
    const io = makeIo();
    await runInstall(['--mcp-name', 'pi-memory', '--auto-allow'], io);
    await runUninstall([], io);
    expect(fs.existsSync(path.join(io.cwd, '.mcp.json'))).toBe(false);
    expect(fs.existsSync(path.join(io.cwd, '.claude', 'settings.json'))).toBe(false);
  });

  test('does not remove a same-named server that is not LaPis (sentinel identity)', async () => {
    const io = makeIo();
    fs.writeFileSync(
      path.join(io.cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { lapis: { command: 'someone-elses-tool', args: ['start'] } } }),
      'utf8',
    );
    await runUninstall([], io);
    const mcp = readJson(path.join(io.cwd, '.mcp.json'));
    expect(mcp.mcpServers.lapis).toEqual({ command: 'someone-elses-tool', args: ['start'] });
  });

  test('is a no-op on a machine with no LaPis config', async () => {
    const io = makeIo(),
      { cleaned } = await runUninstall([], io);
    expect(cleaned).toEqual([]);
  });

  test('stops the daemon when a lockfile is present', async () => {
    const io = makeIo(),
      lockfilePath = path.join(io.root, 'claude-daemon.json');
    const daemonMod = require('../../src/claude-code/daemon');
    daemonMod.writeLockfile({ pid: 999999999, port: 9100, host: '127.0.0.1' }, lockfilePath);
    const stopSpy = vi.spyOn(daemonMod, 'runStop').mockResolvedValue({ stopped: true });

    await runInstall([], io);
    await runUninstall([], { ...io, lockfilePath });

    expect(stopSpy).toHaveBeenCalledWith([], expect.objectContaining({ lockfilePath }));
    stopSpy.mockRestore();
  });
});

// =====================================================================
// Doctor
// =====================================================================

describe('claude-code doctor', () => {
  const fakeDbOk = {
    ensureDb: () => {},
    getDb: () => ({ prepare: () => ({ get: () => ({ 1: 1 }) }) }),
    get DB_PATH() {
      return doctorDbPath;
    },
  };
  let doctorDbPath;

  function makeDoctorIo(io) {
    doctorDbPath = path.join(io.home, 'memory.db');
    fs.writeFileSync(doctorDbPath, '', 'utf8');
    const stateDir = path.join(io.home, 'claude-sessions');
    return {
      ...io,
      db: fakeDbOk,
      requireModule: () => ({}),
      stateStore: { DEFAULT_DIR: stateDir },
      env: { PATH: io.root },
    };
  }

  test('all checks pass after an install when command/DB/state resolve', async () => {
    const io = makeIo();
    // Fake `npx` on the doctor's PATH.
    fs.writeFileSync(path.join(io.root, 'npx'), '#!/bin/sh\n', { mode: 0o755 });
    await runInstall([], io);

    const { ok, checks } = doctor.runDoctor([], makeDoctorIo(io));
    expect(checks.map((c) => [c.name, c.ok])).toEqual([
      ['better-sqlite3 native module', true],
      ['database', true],
      ['MCP server config', true],
      ['hooks config', true],
      ['session state store', true],
    ]);
    expect(ok).toBe(true);
  });

  test('fails with guidance when nothing is installed', async () => {
    const io = makeIo(),
      { ok, checks } = doctor.runDoctor([], makeDoctorIo(io));
    expect(ok).toBe(false);
    const mcpCheck = checks.find((c) => c.name === 'MCP server config');
    expect(mcpCheck.ok).toBe(false);
    expect(mcpCheck.detail).toContain('lapis claude-code install');
    expect(checks.find((c) => c.name === 'hooks config').ok).toBe(false);
  });

  test('flags an MCP command that does not resolve on PATH', async () => {
    const io = makeIo();
    await runInstall([], io); // Npx entry, but no npx on the fake PATH
    const { checks } = doctor.runDoctor([], makeDoctorIo(io)),
      mcpCheck = checks.find((c) => c.name === 'MCP server config');
    expect(mcpCheck.ok).toBe(false);
    expect(mcpCheck.detail).toContain('not found on PATH');
  });

  test('flags a broken native module and unwritable DB', async () => {
    const io = makeIo();
    await runInstall([], io);
    const base = makeDoctorIo(io),
      { checks } = doctor.runDoctor([], {
        ...base,
        requireModule: () => {
          throw new Error('bindings missing');
        },
        db: {
          ensureDb: () => {
            throw new Error('EACCES: permission denied');
          },
        },
      });
    expect(checks.find((c) => c.name === 'better-sqlite3 native module').ok).toBe(false);
    expect(checks.find((c) => c.name === 'database').ok).toBe(false);
    expect(checks.find((c) => c.name === 'database').detail).toContain('EACCES');
  });

  test('validates a node-script (--bin) MCP entry by script existence', async () => {
    const io = makeIo(),
      bin = path.join(io.root, 'clone', 'memory-store.js');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, '// stub', 'utf8');
    await runInstall(['--bin', bin], io);

    let result = doctor.runDoctor([], makeDoctorIo(io));
    expect(result.checks.find((c) => c.name === 'MCP server config').ok).toBe(true);

    fs.unlinkSync(bin);
    result = doctor.runDoctor([], makeDoctorIo(io));
    const mcpCheck = result.checks.find((c) => c.name === 'MCP server config');
    expect(mcpCheck.ok).toBe(false);
    expect(mcpCheck.detail).toContain('script not found');
  });
});

// =====================================================================
// PostToolUse role filter (--skip / --only from the install config)
// =====================================================================

describe('claude-code hook role filter', () => {
  test('parseRoleFilter reads --only / --skip after the event name', async () => {
    expect(parseRoleFilter(['hook', 'PostToolUse'])).toBeUndefined();
    expect(parseRoleFilter(['hook', 'PostToolUse', '--only', 'git-trust'])).toEqual({
      only: 'git-trust',
      skip: undefined,
    });
    expect(parseRoleFilter(['hook', 'PostToolUse', '--skip', 'git-trust'])).toEqual({
      only: undefined,
      skip: 'git-trust',
    });
  });

  function makeStateStore() {
    const map = new Map();
    return {
      loadState: (id) => map.get(id) || realStateStore.defaultState(),
      saveState: (id, s) => map.set(id, s),
      mutateState: async (id, mutator) => {
        const s = map.get(id) || realStateStore.defaultState(),
          r = await mutator(s);
        map.set(id, s);
        return r;
      },
      _peek: (id) => map.get(id),
    };
  }

  test('--skip git-trust suppresses the git-trust dispatch but keeps edit-track', async () => {
    const calls = [],
      dispatch = async (cmd, args) => {
        calls.push({ cmd, args });
        return { ok: true };
      },
      stateStore = makeStateStore(),
      getKnownRepos = () => [{ name: 'proj', path: '/proj' }];

    await handlePostToolUse({
      payload: {
        session_id: 's1',
        tool_name: 'Bash',
        tool_input: { command: 'git pull origin main' },
        cwd: '/proj',
      },
      dispatch,
      getKnownRepos,
      stateStore,
      roleFilter: { skip: 'git-trust' },
    });
    expect(calls).toEqual([]);

    await handlePostToolUse({
      payload: { session_id: 's1', tool_name: 'Write', tool_input: { file_path: '/proj/a.js' }, cwd: '/proj' },
      dispatch,
      getKnownRepos,
      stateStore,
      roleFilter: { skip: 'git-trust' },
    });
    expect(stateStore._peek('s1').editedFiles).toEqual(['/proj/a.js', 'a.js']);
  });

  test('--only git-trust runs git-trust and nothing else', async () => {
    const calls = [],
      dispatch = async (cmd, args) => {
        calls.push({ cmd, args });
        return { ok: true };
      },
      stateStore = makeStateStore(),
      getKnownRepos = () => [{ name: 'proj', path: '/proj' }];

    await handlePostToolUse({
      payload: { session_id: 's2', tool_name: 'Write', tool_input: { file_path: '/proj/a.js' }, cwd: '/proj' },
      dispatch,
      getKnownRepos,
      stateStore,
      roleFilter: { only: 'git-trust' },
    });
    expect(stateStore._peek('s2')).toBeUndefined();

    await handlePostToolUse({
      payload: {
        session_id: 's2',
        tool_name: 'Bash',
        tool_input: { command: 'git checkout main' },
        cwd: '/proj',
      },
      dispatch,
      getKnownRepos,
      stateStore,
      roleFilter: { only: 'git-trust' },
    });
    expect(calls).toEqual([{ cmd: 'sync-code-trust', args: { repo: 'proj' } }]);
  });

  test('the git-trust role never writes state back (async handler must not clobber concurrent saves)', async () => {
    const stateStore = makeStateStore();
    // Simulate the synchronous handler having already recorded an edit.
    stateStore.saveState('s3', {
      ...realStateStore.defaultState(),
      editedFiles: ['/proj/from-sync-handler.js'],
    });
    let saves = 0;
    const originalSave = stateStore.saveState;
    stateStore.saveState = (id, s) => {
      saves++;
      originalSave(id, s);
    };

    await handlePostToolUse({
      payload: { session_id: 's3', tool_name: 'Bash', tool_input: { command: 'git pull' }, cwd: '/proj' },
      dispatch: async () => ({ ok: true }),
      getKnownRepos: () => [{ name: 'proj', path: '/proj' }],
      stateStore,
      roleFilter: { only: 'git-trust' },
    });

    expect(saves).toBe(0);
    expect(stateStore._peek('s3').editedFiles).toEqual(['/proj/from-sync-handler.js']);
  });

  test('tool-state mirroring survives a --mcp-name rename (any mcp__<name>__ prefix maps)', async () => {
    expect(mcpToolName('mcp__pi-memory__memory-search')).toBe('memory-search');
    expect(postToolRole('mcp__pi-memory__memory-save')).toBe('memory-save-mirror');
    expect(preToolRole('mcp__pi-memory__memory-code')).toBe('memory-code-seed');

    const stateStore = makeStateStore();
    await handlePostToolUse({
      payload: {
        session_id: 's4',
        tool_name: 'mcp__pi-memory__memory-search',
        tool_input: { query: 'auth flow' },
        tool_response: { content: [{ type: 'text', text: '[#12] some memory\n[#34] another' }] },
        cwd: '/proj',
      },
      dispatch: async () => ({ ok: true }),
      getKnownRepos: () => [],
      stateStore,
    });
    const ids = stateStore._peek('s4').pendingRecallFeedback.map(([id]) => id);
    expect(ids).toEqual([12, 34]);
  });
});

// =====================================================================
// CLAUDE.md block writers — symlink safety
// =====================================================================
//
// A malicious repo can commit `.claude/CLAUDE.md` as a symlink to an
// Attacker-chosen file (e.g. ~/.bashrc). install/uninstall must NEVER read or
// Write through that link — only ever replace it with a fresh regular file
// (upsert) or unlink the link itself (remove). Regression coverage for the
// Arbitrary-file-write vector fixed alongside this test.

describe('claude-code install: CLAUDE.md symlink safety', () => {
  const { upsertClaudeMdBlock, removeClaudeMdBlock, claudeMdBlock } = install;

  function makeSymlinkRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-cc-symlink-')),
      claudeDir = path.join(root, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const target = path.join(root, 'victim.txt');
    fs.writeFileSync(target, 'victim-contents-before\n', 'utf8');
    const md = path.join(claudeDir, 'CLAUDE.md');
    fs.symlinkSync(target, md);
    return { root, claudeDir, target, md };
  }

  test('upsertClaudeMdBlock does NOT write through a symlink to its target', () => {
    const { target, md } = makeSymlinkRoot(),
      before = fs.readFileSync(target, 'utf8');

    upsertClaudeMdBlock(md, claudeMdBlock('lapis'));

    // The victim file must be byte-for-byte untouched.
    expect(fs.readFileSync(target, 'utf8')).toBe(before);
    // The path is now a regular file (the symlink was replaced), carrying the
    // LaPis block — not the victim's prior contents.
    expect(fs.lstatSync(md).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(md, 'utf8')).toContain('<!-- lapis:start -->');
    expect(fs.readFileSync(md, 'utf8')).not.toContain('victim-contents');
  });

  test('removeClaudeMdBlock on a bare symlink unlinks the LINK, never the target', () => {
    const { target, md } = makeSymlinkRoot(),
      before = fs.readFileSync(target, 'utf8'),
      removed = removeClaudeMdBlock(md);

    expect(removed).toBe(true);
    // Symlink itself is gone.
    expect(fs.existsSync(md)).toBe(false);
    // Target file is untouched.
    expect(fs.readFileSync(target, 'utf8')).toBe(before);
  });

  test('upsert then remove round-trips on a regular file (no symlink regression)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-cc-md-')),
      md = path.join(root, 'CLAUDE.md');
    fs.writeFileSync(md, '# My project notes\n\nKeep these.\n', 'utf8');

    upsertClaudeMdBlock(md, claudeMdBlock('lapis'));
    expect(fs.readFileSync(md, 'utf8')).toContain('# My project notes');
    expect(fs.readFileSync(md, 'utf8')).toContain('<!-- lapis:start -->');

    const removed = removeClaudeMdBlock(md);
    expect(removed).toBe(true);
    // Surrounding prose is preserved, the block is gone.
    const after = fs.readFileSync(md, 'utf8');
    expect(after).toContain('# My project notes');
    expect(after).not.toContain('<!-- lapis:start -->');
  });

  test('full install over a symlinked .claude/CLAUDE.md does not corrupt the target', async () => {
    const io = makeIo(),
      target = path.join(io.root, 'victim.txt');
    fs.writeFileSync(target, 'victim-contents-before\n', 'utf8');
    const md = path.join(io.cwd, '.claude', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(md), { recursive: true });
    fs.symlinkSync(target, md);
    const before = fs.readFileSync(target, 'utf8');

    await runInstall([], io);

    // Victim untouched, CLAUDE.md is now a regular file with the protocol block.
    expect(fs.readFileSync(target, 'utf8')).toBe(before);
    expect(fs.lstatSync(md).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(md, 'utf8')).toContain('<!-- lapis:start -->');
  });
});
