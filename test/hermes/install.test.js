const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), install = require('../../src/hermes/install'),
  { runInstall, hookCommand } = install, { runUninstall } = require('../../src/hermes/uninstall'), doctor = require('../../src/hermes/doctor');







// ---- helpers ----

function makeIo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-hermes-install-')),
    home = path.join(root, 'hermes-home'),
  lines = (() => {

    fs.mkdirSync(home, { recursive: true });
    
  return ([]);
})();return { home, log: (l) => lines.push(l), lines, root };
}

function readConfig(home) {
  return fs.readFileSync(path.join(home, 'config.yaml'), 'utf8');
}

function readAllowlist(home) {
  return JSON.parse(fs.readFileSync(path.join(home, 'shell-hooks-allowlist.json'), 'utf8'));
}

// =====================================================================
// RunInstall
// =====================================================================

describe('hermes install: default install', () => {
  let io;
  beforeEach(async () => {
    io = makeIo();
    await runInstall([], io);
  });

  test('writes config.yaml with mcp_servers.lapis entry', () => {
    const text = readConfig(io.home);
    expect(text).toMatch(/mcp_servers:\n  lapis:/);
    expect(text).toContain('memory-store.js');
    expect(text).toContain('- mcp');
    expect(text).toContain('enabled: true');
    expect(text).toContain('LAPIS_HOME:');
  });

  test('wires all three hook events with the LaPis hook command', () => {
    const text = readConfig(io.home),
      cmd = hookCommand();
    expect(text).toContain('hooks:');
    expect(text).toContain('  pre_tool_call:');
    expect(text).toContain('  post_tool_call:');
    expect(text).toContain('  on_session_end:');
    expect(text).toContain(`command: "${cmd}"`);
    expect(text).toMatch(/hooks_auto_accept:\s*true/);
  });

  test('writes consent for every hook event', () => {
    const allow = readAllowlist(io.home),
    cmd = (() => {

      expect(allow.approvals).toHaveLength(5);
      
  return (hookCommand());
})();for (const event of ['pre_tool_call', 'post_tool_call', 'pre_llm_call', 'on_session_start', 'on_session_end']) {
      expect(allow.approvals.some((a) => a.event === event && a.command === cmd)).toBe(true);
    }
  });

  test('wires pre_llm_call and on_session_start hook events', () => {
    const text = readConfig(io.home);
    expect(text).toContain('  pre_llm_call:');
    expect(text).toContain('  on_session_start:');
  });

  test('pre_tool_call matcher covers search_files', () => {
    const text = readConfig(io.home);
    expect(text).toContain('matcher: "^(read_file|search_files)$"');
  });

  test('installs the bundled skill', () => {
    const skill = path.join(io.home, 'skills', 'memory', 'lapis', 'SKILL.md');
    expect(fs.existsSync(skill)).toBe(true);
    expect(fs.readFileSync(skill, 'utf8')).toContain('mcp_lapis_memory_code');
  });

  test('reports what was written', () => {
    expect(io.lines.some((l) => l.includes('Installed LaPis for Hermes Agent'))).toBe(true);
    expect(io.lines.some((l) => l.includes('lapis hermes doctor'))).toBe(true);
  });
});

describe('hermes install: idempotency and coexistence', () => {
  test('re-install does not duplicate entries', async () => {
    const io = makeIo();
    await runInstall([], io);
    await runInstall([], io);
    const text = readConfig(io.home),
    allow = (() => {

      expect(text.match(/  lapis:/g)).toHaveLength(1);
      expect(text.match(/- matcher: "\^\(read_file\|search_files\)\$"/g)).toHaveLength(1);
      
  return (readAllowlist(io.home));
})();expect(allow.approvals).toHaveLength(5);
  });

  test('preserves pre-existing MCP servers and user hooks', async () => {
    const io = makeIo();
    fs.writeFileSync(
      path.join(io.home, 'config.yaml'),
      [
        'mcp_servers:',
        '  time:',
        '    command: uvx',
        '    args:',
        '      - mcp-server-time',
        'hooks:',
        '  pre_tool_call:',
        '    - matcher: "^terminal$"',
        '      command: "/user/script.sh"',
        '      timeout: 10',
        'display:',
        '  skin: dark',
        '',
      ].join('\n'),
    );
    await runInstall([], io);
    const text = readConfig(io.home);
    expect(text).toContain('    command: uvx');
    expect(text).toContain('"/user/script.sh"');
    expect(text).toContain('skin: dark');
  });
});

describe('hermes install: flags', () => {
  test('--no-hooks skips hooks and allowlist', async () => {
    const io = makeIo();
    await runInstall(['--no-hooks'], io);
    const text = readConfig(io.home);
    expect(text).toContain('mcp_servers:');
    expect(text).not.toContain('hooks:');
    expect(fs.existsSync(path.join(io.home, 'shell-hooks-allowlist.json'))).toBe(false);
  });

  test('--no-skill skips the skill copy', async () => {
    const io = makeIo();
    await runInstall(['--no-skill'], io);
    expect(fs.existsSync(path.join(io.home, 'skills', 'memory', 'lapis', 'SKILL.md'))).toBe(false);
  });

  test('--mcp-name renames the server entry', async () => {
    const io = makeIo();
    await runInstall(['--mcp-name', 'mymem'], io);
    const text = readConfig(io.home);
    expect(text).toMatch(/mcp_servers:\n  mymem:/);
    expect(text).not.toMatch(/mcp_servers:\n  lapis:/);
  });

  test('rejects unknown flags', async () => {
    const io = makeIo();
    await expect(runInstall(['--bogus'], io)).rejects.toThrow('Unknown flag');
  });
});

// =====================================================================
// RunUninstall
// =====================================================================

describe('hermes uninstall', () => {
  test('removes only LaPis-owned entries', async () => {
    const io = makeIo();
    fs.writeFileSync(
      path.join(io.home, 'config.yaml'),
      [
        'mcp_servers:',
        '  time:',
        '    command: uvx',
        '  lapis:',
        '    command: /usr/bin/node',
        '    enabled: true',
        'hooks:',
        '  pre_tool_call:',
        '    - matcher: "^terminal$"',
        '      command: "/user/script.sh"',
        '      timeout: 10',
        '    - matcher: "^read_file$"',
        `      command: "${hookCommand()}"`,
        '      timeout: 15',
        '  on_session_end:',
        `    - command: "${hookCommand()}"`,
        '      timeout: 20',
        'hooks_auto_accept: true',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(io.home, 'shell-hooks-allowlist.json'),
      JSON.stringify({
        approvals: [
          { event: 'pre_tool_call', command: hookCommand() },
          { event: 'on_session_end', command: hookCommand() },
          { event: 'pre_tool_call', command: '/user/script.sh' },
        ],
      }),
    );

    const { removed } = await runUninstall([], io),
      text = readConfig(io.home),
    allow = (() => {

  
      expect(removed).toContain('mcp_servers.lapis');
      expect(removed).toContain('hooks.pre_tool_call');
      expect(removed).toContain('hooks.on_session_end');
      expect(text).not.toContain('lapis:');
      expect(text).not.toContain(hookCommand());
      // A user hook remains, so the shared hooks_auto_accept scalar survives —
      // It may be used by other hooks for headless consent.
      expect(text).toContain('hooks_auto_accept: true');
      expect(removed).not.toContain('hooks_auto_accept');
  
      // User's server and hook survive.
      expect(text).toContain('    command: uvx');
      expect(text).toContain('"/user/script.sh"');
  
      
  return (readAllowlist(io.home));
})();expect(allow.approvals).toHaveLength(1);
    expect(allow.approvals[0].command).toBe('/user/script.sh');
  });

  test('is a no-op when nothing is installed', async () => {
    const io = makeIo();
    fs.writeFileSync(path.join(io.home, 'config.yaml'), 'model:\n  default: x\n');
    const { removed } = await runUninstall([], io);
    expect(removed).toEqual([]);
    expect(readConfig(io.home)).toContain('model:');
  });

  test('leaves no empty block shells when removing an installer-created config', async () => {
    const io = makeIo();
    await runInstall([], io);
    await runUninstall([], io);
    const text = readConfig(io.home);
    expect(text.trim()).toBe('');
    expect(text).not.toContain('mcp_servers');
    expect(text).not.toContain('hooks:');
    expect(text).not.toContain('hooks_auto_accept');
    expect(fs.existsSync(path.join(io.home, 'skills', 'memory', 'lapis', 'SKILL.md'))).toBe(false);
    // Zero residue: empty skill parent dirs and the now-empty allowlist file
    // (install's shape is `{approvals:[…]}` only) are removed too.
    expect(fs.existsSync(path.join(io.home, 'skills', 'memory'))).toBe(false);
    expect(fs.existsSync(path.join(io.home, 'skills'))).toBe(false);
    expect(fs.existsSync(path.join(io.home, 'shell-hooks-allowlist.json'))).toBe(false);
  });

  test('keeps the allowlist file when it holds non-approval keys or user approvals', async () => {
    const io = makeIo();
    await runInstall([], io);
    // Simulate a user-added key in the allowlist (Hermes may store more than
    // Approvals): the file must survive with LaPis approvals filtered out.
    const allowPath = path.join(io.home, 'shell-hooks-allowlist.json'),
      allow = JSON.parse(fs.readFileSync(allowPath, 'utf8'));
    allow.version = 1;
    allow.approvals.push({ event: 'pre_tool_call', command: '/user/script.sh' });
    fs.writeFileSync(allowPath, `${JSON.stringify(allow, null, 2)}\n`);

    const { removed } = await runUninstall([], io),
    after = (() => {

      expect(removed.some((r) => r.startsWith('allowlist'))).toBe(true);
      expect(fs.existsSync(allowPath)).toBe(true);
      
  return (JSON.parse(fs.readFileSync(allowPath, 'utf8')));
})();expect(after.version).toBe(1);
    expect(after.approvals).toEqual([{ event: 'pre_tool_call', command: '/user/script.sh' }]);
  });
});

// =====================================================================
// Doctor
// =====================================================================

describe('hermes doctor', () => {
  test('fails when nothing is installed', () => {
    const io = makeIo(),
      { ok, checks } = doctor.runDoctor([], io);
    expect(ok).toBe(false);
    expect(checks.find((c) => c.name.includes('Hermes config file')).ok).toBe(false);
  });

  test('passes config, hooks, consent, and skill checks after install', async () => {
    const io = makeIo();
    await runInstall([], io);
    const { ok, checks } = doctor.runDoctor([], io),
      nameOf = (n) => checks.find((c) => c.name.includes(n));
    expect(nameOf('Hermes config file').ok).toBe(true);
    expect(nameOf('MCP server').ok).toBe(true);
    expect(nameOf('Hooks config').ok).toBe(true);
    expect(nameOf('Hook consent').ok).toBe(true);
    expect(nameOf('Hermes skill').ok).toBe(true);
    expect(ok).toBe(true);
  });
});
