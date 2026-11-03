// Everyday checkers: parsers against real tsc 6.0 / ESLint 10 / Vitest 4 /
// Jest 30 / pytest 9 output (test/fixtures/checks, sample root → <ROOT>),
// capture into a temp git repo, staleness, context rendering and the stop gate.
const fs = require('fs'),
  os = require('os'),
  path = require('path'),
  { execFileSync } = require('child_process'),
  dbModule = require('../db'),
  { parseCheckOutput, isCheckCommand } = require('../src/verification/checkers'),
  { captureCheckOutput } = require('../src/verification/capture'),
  { proofState, gateEnabled, verificationEnabled } = require('../src/verification'),
  { renderCheckState } = require('../src/verification/render'),
  { evaluateGate, gateBaseline, failureKeys } = require('../src/verification/gate'),
  { handleVerifyGate } = require('../src/claude-code/handlers/stop'),
  { handlePostToolUseFailure } = require('../src/claude-code/handlers/post-tool-use-failure');

const FIX = path.join(__dirname, 'fixtures', 'checks'),
  fixture = (name, root = '/repo') =>
    fs
      .readFileSync(path.join(FIX, `${name}.txt`), 'utf8')
      .split('<ROOT>')
      .join(root),
  only = (command, name, root) => {
    const r = parseCheckOutput(command, fixture(name, root));
    expect(r).toHaveLength(1);
    return r[0];
  },
  checks = (r) => r.units.flatMap((u) => u.open_checks.map((c) => `${u.file}:${c.line ?? ''} ${c.rule} ${c.message}`));

describe('check output parsers (real output)', () => {
  it('tsc: plain and --pretty give the same errors', () => {
    for (const name of ['tsc', 'tsc-pretty']) {
      const r = only('npx tsc --noEmit', name);
      expect(r.verifier).toBe('tsc');
      expect(r.totals.unproved).toBe(3);
      expect(checks(r)).toEqual([
        "src/math.ts:4 TS2322 Type 'string' is not assignable to type 'number'.",
        "src/math.ts:6 TS2322 Type 'number' is not assignable to type 'string'.",
        "src/other.ts:1 TS2307 Cannot find module './nowhere' or its corresponding type declarations.",
      ]);
    }
  });

  it('tsc: empty output of an explicit tsc run is clean; --version and config errors are not runs', () => {
    expect(only('tsc -p .', 'tsc-clean')).toMatchObject({ verifier: 'tsc', units: [], totals: { unproved: 0 } });
    expect(parseCheckOutput('tsc --version', 'Version 6.0.3')).toEqual([]);
    expect(parseCheckOutput('tsc src/a.ts', 'error TS5112: tsconfig.json is present but will not be loaded')).toEqual(
      [],
    );
    expect(parseCheckOutput('npm test', '')).toEqual([]); // empty output proves nothing without a summary
  });

  it('ESLint: errors per file, warnings ignored, empty output clean', () => {
    const r = only('npx eslint src', 'eslint', 'C:\\repo');
    expect(checks(r)).toEqual(["C:\\repo\\src\\lint.js:2 no-undef 'undefinedThing' is not defined"]);
    expect(only('npx eslint src/clean.js', 'eslint-clean').totals.unproved).toBe(0);
  });

  it('Vitest: default and verbose reporters, failing test named by file', () => {
    for (const name of ['vitest', 'vitest-verbose']) {
      const r = only('npx vitest run', name);
      expect(r.totals).toMatchObject({ proved: 2, unproved: 1 });
      expect(checks(r)).toEqual(['test/vmath.test.mjs: test math > fails on purpose']);
    }
    expect(only('npm test', 'vitest-clean')).toMatchObject({ units: [], totals: { proved: 1, unproved: 0 } });
  });

  it('Jest: failing file and test from the ● lines', () => {
    const r = only('npx jest', 'jest');
    expect(r.totals).toMatchObject({ proved: 2, unproved: 1 });
    expect(checks(r)).toEqual(['test/jmath.test.js: test math › fails on purpose']);
    expect(only('yarn test', 'jest-clean').totals).toMatchObject({ proved: 1, unproved: 0 });
  });

  it('pytest: default and -v, paths under rootdir', () => {
    for (const [cmd, name] of [
      ['python -m pytest pytests', 'pytest'],
      ['pytest -v', 'pytest-v'],
    ]) {
      const r = only(cmd, name, '/repo');
      expect(r.totals).toMatchObject({ proved: 2, unproved: 1 });
      expect(checks(r)).toEqual(['/repo/pytests/test_calc.py: test test_broken - AssertionError: deliberate']);
    }
    expect(only('pytest', 'pytest-clean').totals).toMatchObject({ proved: 1, unproved: 0 });
  });

  it('recognises check commands, including compound and package-script forms', () => {
    for (const c of [
      'npx tsc --noEmit',
      'cd app && npm run test',
      'pnpm lint',
      'python3 -m pytest -q',
      'node_modules/.bin/vitest run',
    ]) {
      expect(isCheckCommand(c)).toBe(true);
    }
    for (const c of ['git status', 'ls tests', 'cat tsconfig.json', 'echo jest']) {
      expect(isCheckCommand(c)).toBe(c === 'echo jest'); // "echo jest" is a false positive, but its output has no summary
    }
    expect(parseCheckOutput('echo jest', 'jest')).toEqual([]);
  });
});

describe('capture, staleness, rendering and the gate', () => {
  let dir;
  const git = (...args) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
        cwd: dir,
        stdio: 'pipe',
      }),
    write = (file, text) => {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
    },
    capture = (command, name) => captureCheckOutput(dbModule, { cwd: dir, command, output: fixture(name, dir) }),
    state = () => proofState(dbModule, { cwd: dir }),
    run = (verifier) => state().runs.find((r) => r.verifier === verifier);

  beforeAll(() => dbModule.ensureDb());

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-checks-'));
    git('init', '-q', '-b', 'main');
    for (const f of [
      'src/math.ts',
      'src/other.ts',
      'src/ok.ts',
      'src/lint.js',
      'test/vmath.test.mjs',
      'test/jmath.test.js',
      'pytests/test_calc.py',
    ]) {
      write(f, `// ${f}\n`);
    }
    git('add', '.');
    git('commit', '-q', '-m', 'base');
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('stores each checker with repo-relative files (absolute ESLint and pytest paths included)', () => {
    expect(capture('npx tsc --noEmit', 'tsc').captured[0]).toMatchObject({ verifier: 'tsc', totals: { unproved: 3 } });
    capture('npx eslint src', 'eslint');
    capture('python -m pytest', 'pytest');
    capture('npx vitest run', 'vitest');
    capture('npx jest', 'jest');
    const s = state();
    expect(s.runs.map((r) => r.verifier)).toEqual(['eslint', 'jest', 'pytest', 'tsc', 'vitest']);
    expect(run('eslint').units.map((u) => u.file)).toEqual(['src/lint.js']);
    expect(run('pytest').units.map((u) => u.file)).toEqual(['pytests/test_calc.py']);
    expect(run('tsc').units.map((u) => [u.file, u.status])).toEqual([
      ['src/math.ts', 'unproved'],
      ['src/other.ts', 'unproved'],
    ]);
  });

  it('ignores non-check commands and output without a result', () => {
    expect(captureCheckOutput(dbModule, { cwd: dir, command: 'ls', output: 'x' }).captured).toEqual([]);
    expect(
      captureCheckOutput(dbModule, { cwd: dir, command: 'npm test', output: 'npm ERR! missing script' }).captured,
    ).toEqual([]);
    expect(state().runs).toEqual([]);
  });

  it('a file edited before the run is not "changed since"; editing it again is', () => {
    write('src/math.ts', '// edited before the run\n');
    capture('npx tsc', 'tsc');
    expect(run('tsc').changed_since).toEqual([]);
    expect(run('tsc').units.every((u) => u.status === 'unproved')).toBe(true);

    write('src/math.ts', '// edited again\n');
    expect(run('tsc').changed_since).toEqual(['src/math.ts']);
    expect(run('tsc').units.find((u) => u.file === 'src/math.ts').status).toBe('stale');

    git('checkout', '--', 'src/math.ts'); // reverted to HEAD: still differs from what tsc saw
    expect(run('tsc').changed_since).toEqual(['src/math.ts']);
  });

  it('renders failing, clean and changed-since runs before memories', () => {
    capture('npx tsc', 'tsc');
    capture('npm test', 'vitest-clean');
    write('src/ok.ts', '// changed\n');
    const lines = renderCheckState(state());
    expect(lines[0]).toMatch(/^### Checks/);
    expect(lines.find((l) => l.includes('**tsc**'))).toMatch(/✗ 3 failing: src\/math\.ts:4 TS2322/);
    expect(lines.find((l) => l.includes('**vitest**'))).toMatch(/✓ clean \(1 file changed since — re-run to confirm\)/);
    expect(renderCheckState({ runs: [] })).toEqual([]);
  });

  it('keeps only the newest 20 runs per checker', () => {
    for (let i = 0; i < 22; i++) {
      captureCheckOutput(dbModule, { cwd: dir, command: 'npx tsc', output: `src/ok.ts(1,1): error TS1000: n${i}` });
    }
    const repo = state().repo_root;
    expect(
      dbModule.sqlJson("SELECT COUNT(*) n FROM verifier_runs WHERE repo_root = ? AND verifier = 'tsc'", [repo])[0].n,
    ).toBe(20);
    expect(run('tsc').units[0].open_checks[0].message).toBe('n21');
  });

  describe('gate', () => {
    it('does not block a session that edited nothing, or with no runs', () => {
      capture('npx tsc', 'tsc');
      expect(evaluateGate(state(), null, []).block).toBe(false);
      expect(evaluateGate({ repo_root: dir, runs: [] }, null, ['src/math.ts']).block).toBe(false);
    });

    it('blocks edits made after the last run of a checker that covers them', () => {
      capture('npx tsc', 'tsc');
      const baseline = gateBaseline(state());
      write('src/ok.ts', '// edited by the agent\n');
      const v = evaluateGate(state(), baseline, [path.join(dir, 'src', 'ok.ts')]);
      expect(v.block).toBe(true);
      expect(v.reason).toMatch(/Re-run tsc: you edited src\/ok\.ts/);
      expect(v.fresh).toEqual([]); // the 3 errors were there when the session started

      capture('npx tsc', 'tsc'); // re-run: same pre-existing errors, nothing unchecked
      expect(evaluateGate(state(), baseline, [path.join(dir, 'src', 'ok.ts')]).block).toBe(false);
    });

    it('blocks new failures only for checkers that had a baseline run', () => {
      capture('npx vitest run', 'vitest-clean');
      const baseline = gateBaseline(state());
      write('src/ok.ts', '// edited\n');
      capture('npx vitest run', 'vitest');
      capture('npx tsc', 'tsc'); // first tsc run this session: its errors may predate the agent
      const v = evaluateGate(state(), baseline, ['src/ok.ts']);
      expect(v.block).toBe(true);
      expect(v.fresh).toEqual(['vitest|test/vmath.test.mjs|test|math > fails on purpose']);
      expect(v.reason).toMatch(
        /New failures since the session started:\n {2}- vitest test\/vmath\.test\.mjs test math > fails on purpose/,
      );
    });

    it('failure keys ignore line numbers', () => {
      const s = (line) => ({
        runs: [
          {
            verifier: 'tsc',
            totals: {},
            units: [
              { file: 'a.ts', open_checks: [{ file: 'a.ts', line, rule: 'TS1', message: 'm', status: 'unproved' }] },
            ],
          },
        ],
      });
      expect(failureKeys(s(3))).toEqual(failureKeys(s(9)));
    });
  });

  describe('Claude Code hooks', () => {
    const store = () => {
      const s = { editedFiles: [], checkBaseline: null, gateBlocks: 0 };
      return {
        s,
        loadState: () => s,
        mutateState: async (_id, fn) => fn(s),
        saveState: () => {},
      };
    };

    it('the Stop gate blocks with a reason, then lets the agent go after the cap', async () => {
      capture('npx tsc', 'tsc');
      write('src/ok.ts', '// edited\n');
      const st = store(),
        dispatch = async (cmd, args) => (cmd === 'proof-state' ? proofState(dbModule, { cwd: args.path }) : null);
      st.s.editedFiles = [path.join(dir, 'src', 'ok.ts')];
      st.s.checkBaseline = gateBaseline(state());
      const payload = { session_id: 's1', cwd: dir };
      const first = await handleVerifyGate({ payload, dispatch, stateStore: st });
      expect(first).toMatchObject({ decision: 'block' });
      expect(first.reason).toMatch(/Re-run tsc/);
      await handleVerifyGate({ payload, dispatch, stateStore: st });
      expect((await handleVerifyGate({ payload, dispatch, stateStore: st })).reason).toMatch(
        /Last check-gate reminder/,
      );
      expect(await handleVerifyGate({ payload, dispatch, stateStore: st })).toBeNull();
      expect(st.s.gateBlocks).toBe(3);
    });

    it('PostToolUseFailure captures a failing check run', async () => {
      const calls = [];
      await handlePostToolUseFailure({
        payload: {
          tool_name: 'Bash',
          tool_input: { command: 'npx tsc --noEmit' },
          error: `Exit code 2\n${fixture('tsc')}`,
          cwd: dir,
        },
        dispatch: async (cmd, args) => calls.push([cmd, args]),
      });
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toBe('capture-checks');
      expect(calls[0][1]).toMatchObject({ command: 'npx tsc --noEmit', path: path.resolve(dir) });
      expect(calls[0][1].output).toMatch(/TS2322/);
    });
  });

  it('config switches: verification off implies gate off', () => {
    expect(gateEnabled({ verification: { enabled: true, gate: true } })).toBe(true);
    expect(gateEnabled({ verification: { enabled: true, gate: false } })).toBe(false);
    expect(gateEnabled({ verification: { enabled: false, gate: true } })).toBe(false);
    expect(verificationEnabled({})).toBe(true);
  });
});
