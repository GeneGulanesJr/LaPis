const {
    readGuardReason,
    guardReason,
    searchGuardReason,
    buildSessionEndArgs,
    handlePayload,
    runHook,
    countSessionMemories,
  } = require('../../src/hermes/hook'),
  REPOS = [{ name: 'Proj', path: '/work/proj' }];

function payload(overrides = {}) {
  return {
    hook_event_name: 'pre_tool_call',
    tool_name: 'read_file',
    tool_input: { path: '/work/proj/src/a.js' },
    session_id: 's1',
    cwd: '/work/proj',
    extra: {},
    ...overrides,
  };
}

describe('hermes hook: read guardrail', () => {
  test('blocks a whole-file read of indexed code', () => {
    const reason = readGuardReason(payload(), { repos: REPOS });
    expect(reason).toBeTruthy();
    expect(reason).toContain('Blocked by LaPis read guard');
    expect(reason).toContain('memory_code');
  });

  test('allows targeted reads with offset/limit', () => {
    const reason = readGuardReason(payload({ tool_input: { path: '/work/proj/src/a.js', offset: 10, limit: 40 } }), {
      repos: REPOS,
    });
    expect(reason).toBeNull();
  });

  test('allows non-code files', () => {
    const reason = readGuardReason(payload({ tool_input: { path: '/work/proj/README.md' } }), { repos: REPOS });
    expect(reason).toBeNull();
  });

  test('allows config filenames (package.json)', () => {
    const reason = readGuardReason(payload({ tool_input: { path: '/work/proj/package.json' } }), { repos: REPOS });
    expect(reason).toBeNull();
  });

  test('allows node_modules paths', () => {
    const reason = readGuardReason(payload({ tool_input: { path: '/work/proj/node_modules/lodash/index.js' } }), {
      repos: REPOS,
    });
    expect(reason).toBeNull();
  });

  test('allows files outside the indexed repo', () => {
    const reason = readGuardReason(payload({ tool_input: { path: '/elsewhere/b.js' } }), { repos: REPOS });
    expect(reason).toBeNull();
  });

  test('allows everything when no repos are indexed', () => {
    const reason = readGuardReason(payload(), { repos: [] });
    expect(reason).toBeNull();
  });

  test('tolerates missing path and missing input', () => {
    expect(readGuardReason(payload({ tool_input: {} }), { repos: REPOS })).toBeNull();
    expect(readGuardReason(payload({ tool_input: undefined }), { repos: REPOS })).toBeNull();
  });
});

describe('hermes hook: payload dispatch', () => {
  test('ignores unrelated tools and events', () => {
    expect(handlePayload(payload({ hook_event_name: 'pre_tool_call', tool_name: 'terminal' }))).toBeNull();
    expect(handlePayload(payload({ hook_event_name: 'pre_verify' }))).toBeNull();
    expect(handlePayload(payload({ hook_event_name: 'post_tool_call', tool_name: 'browser_navigate' }))).toBeNull();
  });

  test('returns a block decision for whole-file indexed reads', () => {
    const decision = handlePayload(payload(), { repos: REPOS });
    expect(decision).toEqual({ block: expect.stringContaining('Blocked by LaPis read guard') });
  });

  test('requests trust sync after write_file/patch', () => {
    for (const tool of ['write_file', 'patch']) {
      const decision = handlePayload(
        payload({ hook_event_name: 'post_tool_call', tool_name: tool, tool_input: { path: '/work/proj/src/a.js' } }),
      );
      expect(decision).toEqual({ syncTrust: true });
    }
  });

  test('requests session close on session end', () => {
    const decision = handlePayload(payload({ hook_event_name: 'on_session_end' }));
    expect(decision).toEqual({ sessionEnd: true });
  });

  test('requests session start on on_session_start', () => {
    const decision = handlePayload(payload({ hook_event_name: 'on_session_start', tool_name: null }));
    expect(decision).toEqual({ sessionStart: true });
  });

  test('requests context injection on pre_llm_call', () => {
    const decision = handlePayload(payload({ hook_event_name: 'pre_llm_call', tool_name: null }));
    expect(decision).toEqual({ injectContext: true });
  });
});

describe('hermes hook: runHook wire format', () => {
  test('emits a Hermes-compatible block envelope on stdout', () => {
    const out = runHook({ input: JSON.stringify(payload()), repos: REPOS });
    expect(out).toEqual({ block: expect.any(String) });
  });

  test('is silent for no-op payloads', () => {
    expect(runHook({ input: JSON.stringify(payload({ tool_name: 'terminal' })) })).toBeNull();
  });

  test('fails open on garbage input', () => {
    expect(runHook({ input: 'not json {' })).toBeNull();
    expect(runHook({ input: '' })).toBeNull();
  });
});

describe('hermes hook: countSessionMemories', () => {
  test('returns 0 for missing/empty session ids', () => {
    expect(countSessionMemories(undefined)).toBe(0);
    expect(countSessionMemories(null)).toBe(0);
    expect(countSessionMemories('')).toBe(0);
  });

  test('returns 0 when the DB is unreachable (fail-open)', () => {
    // The hook process has no guaranteed DB; any error must degrade to 0.
    expect(countSessionMemories('s-never-indexed')).toBe(0);
  });
});

describe('hermes hook: search guardrail', () => {
  const searchPayload = (ti) => payload({ tool_name: 'search_files', tool_input: ti });

  test('blocks broad content search in an indexed repo', () => {
    const reason = guardReason(searchPayload({ pattern: '.*', target: 'content', path: '/work/proj/src' }), {
      repos: REPOS,
    });
    expect(reason).toBeTruthy();
    expect(reason).toContain('Blocked by LaPis search guard');
    expect(reason).toContain('memory_code');
  });

  test('allows targeted single-symbol lookup', () => {
    const reason = guardReason(
      searchPayload({ pattern: 'rankObservations', target: 'content', path: '/work/proj/src' }),
      { repos: REPOS },
    );
    expect(reason).toBeNull();
  });

  test('allows search outside indexed repos', () => {
    const reason = guardReason(searchPayload({ pattern: '.*', target: 'content', path: '/elsewhere' }), {
      repos: REPOS,
    });
    expect(reason).toBeNull();
  });

  test('searchGuardReason blocks broad scans and allows targeted ones', () => {
    expect(
      searchGuardReason(searchPayload({ pattern: '.*', target: 'content', path: '/work/proj/src' }), { repos: REPOS }),
    ).toBeTruthy();
    expect(
      searchGuardReason(searchPayload({ pattern: 'rankObservations', target: 'content', path: '/work/proj/src' }), {
        repos: REPOS,
      }),
    ).toBeNull();
  });

  test('allows read_file guard behavior unchanged', () => {
    expect(readGuardReason(payload(), { repos: REPOS })).toBeTruthy();
  });
});

describe('hermes hook: session-end args', () => {
  test('session-end uses mapped lapis session id when present', () => {
    const args = buildSessionEndArgs({ session_id: 'hermes-s1' }, { lapisSessionId: 42 });
    expect(args).toEqual([
      expect.stringContaining('memory-store.js'),
      'session-end',
      '--id',
      '42',
      '--memories',
      '0',
      '--auto',
      'true',
    ]);
  });

  test('session-end falls back to hermes session id when unmapped', () => {
    const args = buildSessionEndArgs({ session_id: 'hermes-s1' }, {});
    expect(args).toContain('hermes-s1');
  });
});
