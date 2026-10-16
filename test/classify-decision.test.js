// vitest globals enabled — no import
const {
  classifyCommandWithJudge,
  classifyCommandDetailed,
  maybeClassifyCommand,
  guardJevEnabled,
  COMMAND_CLASSES,
} = require('../src/token-saver/classify-jev');
const { classifyCommand } = require('../src/token-saver/classify-command');

function makeJudge(answers, meta = {}) {
  return vi.fn(async () => ({ status: meta.status || 'ok', answers, reason: meta.reason }));
}

const AMBIGUOUS = ['node', 'scripts/deploy.js', '--env=prod']; // matches no COMMAND_RULES → 'generic'

describe('classifyCommandWithJudge — regex-first cascade', () => {
  it('definitive regex classification → judge NEVER called, result identical to sync', async () => {
    const judge = makeJudge([]);
    for (const args of [
      ['git', 'diff', '--staged'],
      ['git', 'status'],
      ['npm', 'test'],
      ['cat', 'file.txt'],
      ['ls', '-la'],
      ['rg', 'pattern', '.'],
      ['tail', '-f', 'log.txt'],
      ['npm', 'install'],
    ]) {
      const result = await classifyCommandWithJudge(args, { judge });
      expect(result).toBe(classifyCommand(args));
    }
    expect(judge).not.toHaveBeenCalled();
  });

  it('ambiguous (generic) + judge pick ≥ floor → judgment-informed result, surface "guard"', async () => {
    const judge = makeJudge([{ id: 'guard-0', pick: 'file-read', confidence: 0.9 }]);
    const result = await classifyCommandWithJudge(AMBIGUOUS, { judge });
    expect(result).toBe('file-read');
    expect(judge).toHaveBeenCalledTimes(1);
    const [questions, opts] = judge.mock.calls[0];
    expect(opts).toEqual({ surface: 'guard' });
    expect(questions).toHaveLength(1);
    expect(questions[0].id).toBe('guard-0');
    expect(questions[0].judgment.kind).toBe('classify');
    // enum = the file's real COMMAND_RULES taxonomy + default
    expect(questions[0].judgment.enum).toEqual(COMMAND_CLASSES);
    // state = the joined command
    expect(questions[0].state.command).toBe('node scripts/deploy.js --env=prod');
  });

  it('confidence below floor (default 0.6) → sync result unchanged', async () => {
    const judge = makeJudge([{ id: 'guard-0', pick: 'file-read', confidence: 0.59 }]);
    const result = await classifyCommandWithJudge(AMBIGUOUS, { judge });
    expect(result).toBe('generic'); // exactly the sync classification
  });

  it('custom floor is honored (0.9 floor: 0.89 rejected, 0.91 accepted)', async () => {
    const low = makeJudge([{ id: 'guard-0', pick: 'search', confidence: 0.89 }]);
    expect(await classifyCommandWithJudge(AMBIGUOUS, { judge: low, floor: 0.9 })).toBe('generic');
    const high = makeJudge([{ id: 'guard-0', pick: 'search', confidence: 0.91 }]);
    expect(await classifyCommandWithJudge(AMBIGUOUS, { judge: high, floor: 0.9 })).toBe('search');
  });

  it('judge unavailable → sync result', async () => {
    const judge = makeJudge([], { status: 'unavailable', reason: 'off' });
    expect(await classifyCommandWithJudge(AMBIGUOUS, { judge })).toBe('generic');
  });

  it('judge invalid → sync result', async () => {
    const judge = makeJudge([], { status: 'invalid', reason: 'bad reply' });
    expect(await classifyCommandWithJudge(AMBIGUOUS, { judge })).toBe('generic');
  });

  it('judge that throws is contained → sync result', async () => {
    const judge = vi.fn(async () => {
      throw new Error('boom');
    });
    expect(await classifyCommandWithJudge(AMBIGUOUS, { judge })).toBe('generic');
  });

  it('missing answer / pick outside enum / generic pick / non-numeric confidence → sync result', async () => {
    expect(await classifyCommandWithJudge(AMBIGUOUS, { judge: makeJudge([]) })).toBe('generic');
    expect(
      await classifyCommandWithJudge(AMBIGUOUS, {
        judge: makeJudge([{ id: 'guard-0', pick: 'mutate', confidence: 0.99 }]),
      }),
    ).toBe('generic');
    expect(
      await classifyCommandWithJudge(AMBIGUOUS, {
        judge: makeJudge([{ id: 'guard-0', pick: 'generic', confidence: 0.99 }]),
      }),
    ).toBe('generic');
    expect(
      await classifyCommandWithJudge(AMBIGUOUS, {
        judge: makeJudge([{ id: 'guard-0', pick: 'search', confidence: 'high' }]),
      }),
    ).toBe('generic');
  });

  it('no judge provided → sync result, never throws', async () => {
    expect(await classifyCommandWithJudge(AMBIGUOUS)).toBe('generic');
    expect(await classifyCommandWithJudge(AMBIGUOUS, {})).toBe('generic');
  });

  it('FAIL-SAFE: judgment can only ever return a value from the sync taxonomy', async () => {
    for (const pick of COMMAND_CLASSES) {
      const judge = makeJudge([{ id: 'guard-0', pick, confidence: 1 }]);
      const result = await classifyCommandWithJudge(AMBIGUOUS, { judge });
      expect(COMMAND_CLASSES).toContain(result);
    }
  });

  it('state.command is capped at 500 chars (+ ellipsis marker)', async () => {
    const judge = makeJudge([{ id: 'guard-0', pick: 'list', confidence: 0.9 }]);
    await classifyCommandWithJudge(['node', 'x'.repeat(600)], { judge }); // 'node …' matches no rule → ambiguous
    const state = judge.mock.calls[0][0][0].state;
    expect(state.command.startsWith('node ')).toBe(true);
    expect(state.command.length).toBe(501); // 500 + '…'
  });
});

describe('classifyCommandDetailed — provenance', () => {
  it('definitive sync match carries source "sync"; judge absent → source "sync"', async () => {
    expect(await classifyCommandDetailed(['git', 'diff'], { judge: makeJudge([]) })).toEqual({
      type: 'git-diff',
      source: 'sync',
    });
    expect(await classifyCommandDetailed(AMBIGUOUS)).toEqual({ type: 'generic', source: 'sync' });
  });

  it('confident judgment pick carries source "judgment" + confidence', async () => {
    const judge = makeJudge([{ id: 'guard-0', pick: 'logs', confidence: 0.87 }]);
    expect(await classifyCommandDetailed(AMBIGUOUS, { judge })).toEqual({
      type: 'logs',
      source: 'judgment',
      confidence: 0.87,
    });
  });

  it('sync classifier blowing up degrades to the conservative default, never throws', async () => {
    const result = await classifyCommandDetailed(null, {});
    expect(result).toEqual({ type: 'generic', source: 'sync' });
  });
});

describe('guardJevEnabled — opt-in matrix', () => {
  const { resetConfigCache } = require('../config');

  function withEnv(fn) {
    try {
      return fn();
    } finally {
      delete process.env.LAPIS_JUDGE_PROVIDER;
      delete process.env.LAPIS_JUDGE_DISABLE_GUARD;
      delete process.env.TYPESAFE_API_KEY;
      resetConfigCache();
    }
  }

  it('default config (heuristic, no key) → false', () => {
    withEnv(() => {
      resetConfigCache();
      expect(guardJevEnabled()).toBe(false);
    });
  });

  it('provider=jev + TYPESAFE_API_KEY → true', () => {
    withEnv(() => {
      process.env.LAPIS_JUDGE_PROVIDER = 'jev';
      process.env.TYPESAFE_API_KEY = 'k-test';
      resetConfigCache();
      expect(guardJevEnabled()).toBe(true);
    });
  });

  it('provider=jev without key → false', () => {
    withEnv(() => {
      process.env.LAPIS_JUDGE_PROVIDER = 'jev';
      resetConfigCache();
      expect(guardJevEnabled()).toBe(false);
    });
  });

  it('disables.guard (LAPIS_JUDGE_DISABLE_GUARD=1) → false even with jev + key', () => {
    withEnv(() => {
      process.env.LAPIS_JUDGE_PROVIDER = 'jev';
      process.env.TYPESAFE_API_KEY = 'k-test';
      process.env.LAPIS_JUDGE_DISABLE_GUARD = '1';
      resetConfigCache();
      expect(guardJevEnabled()).toBe(false);
    });
  });
});

describe('maybeClassifyCommand — single guarded seam entry', () => {
  const { resetConfigCache } = require('../config');

  it('disabled (heuristic default) → plain sync classification, judge untouched', async () => {
    try {
      resetConfigCache();
      const judge = makeJudge([]);
      const result = await maybeClassifyCommand(['node', 'server.js'], { _judge: judge });
      expect(result).toBe('generic');
      expect(judge).not.toHaveBeenCalled();
    } finally {
      resetConfigCache();
    }
  });

  it('enabled (jev + key) + args._judge → cascade consulted', async () => {
    process.env.LAPIS_JUDGE_PROVIDER = 'jev';
    process.env.TYPESAFE_API_KEY = 'k-test';
    try {
      resetConfigCache();
      const judge = makeJudge([{ id: 'guard-0', pick: 'logs', confidence: 0.95 }]);
      expect(await maybeClassifyCommand(AMBIGUOUS, { _judge: judge })).toBe('logs');
      expect(judge).toHaveBeenCalledTimes(1);
      // definitive commands still never reach the judge
      const judge2 = makeJudge([]);
      expect(await maybeClassifyCommand(['git', 'diff'], { _judge: judge2 })).toBe('git-diff');
      expect(judge2).not.toHaveBeenCalled();
    } finally {
      delete process.env.LAPIS_JUDGE_PROVIDER;
      delete process.env.TYPESAFE_API_KEY;
      resetConfigCache();
    }
  });
});
