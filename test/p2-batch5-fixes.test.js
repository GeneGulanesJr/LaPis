// Regression tests for review batch 5: #291 (gateway {error} results rendered
// as "No memories found" / "session undefined") and #292 (guardrail matcher
// bugs: whole-command text-file bypass, script-name over-block, unanchored
// repo prefix match).
import { describe, expect, it, vi } from 'vitest';
import { registerMemoryTools } from '../extensions/memory-layer/tools/memory-tools.ts';
import { registerSessionStart } from '../extensions/memory-layer/hooks/session-lifecycle.ts';
import {
  isRawCodeDiscoveryCommand,
  isSearchCommandStage,
  extractPathArgs,
  isTargetedSymbolLookup,
  isTargetedTextFileLookup,
} from '../extensions/memory-layer/hooks/guardrail-utils';

function captureNamedTool(register, deps, toolName) {
  let registered;
  register(
    {
      registerTool(tool) {
        if (tool.name === toolName) {
          registered = tool;
        }
      },
      registerCommand() {},
    },
    deps,
  );
  if (!registered) {
    throw new Error(`${toolName} tool was not registered`);
  }
  return registered;
}

function makeDeps(memResult) {
  return {
    state: { currentProject: 'demo', sessionId: 7, pendingRecallFeedback: null },
    mem: vi.fn().mockResolvedValue(memResult),
    memCmd: vi.fn(),
    trustIcon: () => '',
  };
}

describe('#291 gateway {error} results surface as tool errors', () => {
  const cases = [
    { tool: 'memory-search', params: { query: 'auth' }, label: 'Memory search failed' },
    { tool: 'memory-related', params: { id: '3' }, label: 'Failed to find related memories' },
    { tool: 'memory-load-context', params: { query: 'auth' }, label: 'Failed to load context' },
    { tool: 'memory-sync-code-trust', params: { repo: 'demo' }, label: 'Trust sync failed' },
  ];

  for (const { tool, params, label } of cases) {
    it(`${tool} reports isError when the gateway returns { error }`, async () => {
      const deps = makeDeps({ error: 'db locked' }),
        tool_ = captureNamedTool(registerMemoryTools, deps, tool),
        result = await tool_.execute('1', params, undefined, undefined, undefined);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(label);
      expect(result.content[0].text).toContain('db locked');
      expect(result.content[0].text).not.toContain('No memories');
    });
  }

  it('memory-search still reports genuinely empty results as before', async () => {
    const deps = makeDeps({ results: [] }),
      tool = captureNamedTool(registerMemoryTools, deps, 'memory-search'),
      result = await tool.execute('1', { query: 'auth' }, undefined, undefined, undefined);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe('No memories found.');
  });
});

describe('#291 session-start does not set sessionId from a failed backend', () => {
  it('notifies with the backend error and leaves sessionId unset', async () => {
    const state = { currentProject: null, sessionId: undefined },
      notifications = [],
      deps = {
        state,
        ensureNativeModules: async () => {},
        mem: vi.fn().mockResolvedValue({ error: 'SQLITE_BUSY' }),
        memCmd: vi.fn(),
        detectProject: async () => 'demo',
      },
      ctx = { cwd: '/tmp/x', ui: { notify: (m) => notifications.push(m), setStatus: () => {} } };

    let handler;
    registerSessionStart(
      {
        on(name, h) {
          if (name === 'session_start') handler = h;
        },
      },
      deps,
    );
    await handler({}, ctx);

    expect(state.sessionId).toBeUndefined();
    expect(notifications.some((m) => m.includes('failed to start session') && m.includes('SQLITE_BUSY'))).toBe(true);
    expect(notifications.some((m) => m.includes('session undefined'))).toBe(false);
  });
});

describe('#292 raw-discovery gate uses command position', () => {
  it('matches search binaries in command position', () => {
    expect(isRawCodeDiscoveryCommand('rg pattern src/')).toBe(true);
    expect(isRawCodeDiscoveryCommand('grep -rn foo .')).toBe(true);
    expect(isRawCodeDiscoveryCommand('sudo grep foo /var/log')).toBe(true);
    expect(isRawCodeDiscoveryCommand('cat f | grep needle')).toBe(true);
    expect(isRawCodeDiscoveryCommand('git grep needle')).toBe(true);
  });

  it('does not match script names or arguments containing the words', () => {
    expect(isRawCodeDiscoveryCommand('npm run find:deadcode')).toBe(false);
    expect(isRawCodeDiscoveryCommand('npm run grep-tests')).toBe(false);
    expect(isRawCodeDiscoveryCommand('echo find')).toBe(false);
    expect(isRawCodeDiscoveryCommand('node scripts/cleanup.js --tool=grep')).toBe(false);
  });
});

describe('#292 isTargetedTextFileLookup requires every path argument to be a text file', () => {
  it('no longer lets one text-file mention wave a broad scan through', () => {
    expect(isTargetedTextFileLookup('grep -rn "password" src/ README.md')).toBe(false);
    expect(isTargetedTextFileLookup('grep -R "TODO" docs/')).toBe(false);
  });

  it('still allows lookups scoped to concrete text files', () => {
    expect(isTargetedTextFileLookup('grep -n "^## Commands" AGENTS.md')).toBe(true);
    expect(isTargetedTextFileLookup('rg needle notes/meeting.txt')).toBe(true);
  });

  it('rejects searches with no path arguments (searches the whole cwd)', () => {
    expect(isTargetedTextFileLookup('grep -rn "password"')).toBe(false);
  });
});

describe('#292 search-command detection ignores words inside patterns and script names', () => {
  it('isSearchCommandStage requires the binary in command position', () => {
    expect(isSearchCommandStage('grep -rn "find" src/')).toBe(true);
    expect(isSearchCommandStage('npm run find:deadcode')).toBe(false);
    expect(isSearchCommandStage('find src -name "*.ts"')).toBe(true);
  });

  it('a pattern containing the word find no longer blocks a targeted lookup', () => {
    expect(isTargetedSymbolLookup('grep -rn "find" src/')).toBe(true);
  });

  it('a literal find command is still not a symbol lookup', () => {
    expect(isTargetedSymbolLookup('find src -name "*.ts"')).toBe(false);
    expect(isTargetedSymbolLookup('npm run find:deadcode')).toBe(false);
  });

  it('extractPathArgs skips flags and quoted patterns', () => {
    expect(extractPathArgs('grep -rn --include="*.js" "somePattern" src/ x.md')).toEqual(['src/', 'x.md']);
    expect(extractPathArgs('rg needle')).toEqual([]);
  });
});
