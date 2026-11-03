// Verifier results: GNATprove adapter (against real GNATprove FSF 16.1.0
// reports in test/fixtures/gnatprove), neutral-format validation, ingest and
// proof-state staleness. The DB is the per-file temp one from setup-lapis-home.
const fs = require('fs'),
  os = require('os'),
  path = require('path'),
  { execFileSync } = require('child_process'),
  dbModule = require('../db'),
  { readReportDir, parseGnatprove } = require('../src/verification/gnatprove'),
  { validateNeutral, resolvePaths } = require('../src/verification/results'),
  { ingestReport, proofState } = require('../src/verification');

const FIXTURES = path.join(__dirname, 'fixtures', 'gnatprove'),
  parse = (name) => parseGnatprove(readReportDir(path.join(FIXTURES, name))),
  byUnit = (units) => Object.fromEntries(units.map((u) => [u.unit, u])),
  sum = (units, f) => units.reduce((s, u) => s + u[f], 0);

describe('GNATprove adapter (real reports)', () => {
  it('matches the gnatprove.out summary: 5 proved, 1 justified, 1 unproved', () => {
    const r = parse('basic');
    expect(r).toMatchObject({ verifier: 'gnatprove', verifier_version: 'FSF 16.1.0', ran_at: '2026-11-03T03:59:51Z' });
    expect([sum(r.units, 'proved'), sum(r.units, 'justified'), sum(r.units, 'unproved')]).toEqual([5, 1, 1]);
    const u = byUnit(r.units);
    expect(Object.keys(u).sort()).toEqual(['Demo', 'Demo.Add_Justified', 'Demo.Add_Small', 'Demo.Add_Unchecked']);
    expect(u['Demo.Add_Unchecked']).toMatchObject({ file: 'demo.ads', line: 10, unproved: 1 });
    expect(u['Demo.Add_Unchecked'].open_checks[0]).toMatchObject({
      file: 'demo.adb',
      line: 10,
      rule: 'VC_OVERFLOW_CHECK',
      status: 'unproved',
      severity: 'high',
    });
    expect(u['Demo.Add_Justified'].open_checks[0]).toMatchObject({
      status: 'justified',
      reason: expect.stringMatching(/sensor/),
    });
  });

  it('counts pragma Assume as justified, marks SPARK_Mode Off bodies not analyzed, and skips Off units', () => {
    const r = parse('variant'),
      u = byUnit(r.units);
    expect(r.verifier_version).toBeNull(); // no gnatprove.sarif in this fixture
    expect(u['Demo.Assumed']).toMatchObject({ justified: 1, unproved: 0 });
    expect(u['Demo.Assumed'].open_checks[0]).toMatchObject({ status: 'assumed', line: 25 });
    expect(u['Demo.Skipped'].analyzed).toBe(false);
    expect(u['Demo.Bad_Flow']).toMatchObject({ flow_errors: 1, proved: 0 }); // the unused-variable warning is not a check
    expect(u.Main).toBeUndefined(); // spark mode "no"
  });

  it('rejects a folder without .spark files and a non-.spark JSON', () => {
    expect(() => parseGnatprove(new Map())).toThrow(/no \.spark files/);
    expect(() => parseGnatprove(new Map([['x.spark', '{"a":1}']]))).toThrow(/not a GNATprove/);
  });
});

describe('neutral format validation', () => {
  const unit = { file: 'src/a.ads', unit: 'A', proved: 1 };
  it('accepts a minimal report and fills defaults', () => {
    const { report } = validateNeutral({ verifier: 'lean', units: [unit] });
    expect(report.units[0]).toMatchObject({
      analyzed: true,
      unproved: 0,
      justified: 0,
      flow_errors: 0,
      open_checks: [],
    });
  });

  it.each([
    [{ verifier: 'Bad Name', units: [] }, /verifier/],
    [{ verifier: 'x', units: {} }, /units/],
    [{ verifier: 'x', units: [{ ...unit, file: '/etc/passwd' }] }, /repo-relative/],
    [{ verifier: 'x', units: [{ ...unit, file: 'C:\\x\\a.ads' }] }, /repo-relative/],
    [{ verifier: 'x', units: [{ ...unit, file: 'src/../../a.ads' }] }, /repo-relative/],
    [{ verifier: 'x', units: [{ ...unit, proved: -1 }] }, /non-negative/],
    [{ verifier: 'x', units: [{ ...unit, unit: '' }] }, /unit/],
  ])('rejects %j', (raw, msg) => {
    expect(validateNeutral(raw).error).toMatch(msg);
  });

  it('caps open checks per unit', () => {
    const checks = Array.from({ length: 80 }, (_, i) => ({ line: i + 1, status: 'unproved' })),
      { report } = validateNeutral({ verifier: 'x', units: [{ ...unit, open_checks: checks }] });
    expect(report.units[0].open_checks).toHaveLength(50);
  });

  it('resolves bare file names to unique repo paths', () => {
    const report = () => validateNeutral({ verifier: 'x', units: [{ ...unit, file: 'demo.ads' }] }).report;
    expect(resolvePaths(report(), ['src/demo.ads']).report.units[0].file).toBe('src/demo.ads');
    expect(resolvePaths(report(), ['a/demo.ads', 'b/demo.ads']).error).toMatch(/several files/);
    expect(resolvePaths(report(), ['src/other.ads']).error).toMatch(/not found/);
  });
});

describe('verify-ingest and proof-state over a git repo', () => {
  let dir;
  const deps = dbModule,
    git = (...args) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
        cwd: dir,
        stdio: 'pipe',
      }),
    write = (file, text) => {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
    },
    ingest = (name, opts = {}) => ingestReport(deps, { cwd: dir, report: path.join(FIXTURES, name), ...opts }),
    state = () => proofState(deps, { cwd: dir }).runs[0],
    statuses = (run) => Object.fromEntries(run.units.map((u) => [u.unit, u.status]));

  beforeAll(() => dbModule.ensureDb());

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-proof-'));
    git('init', '-q', '-b', 'main');
    write('.gitignore', 'obj/\n');
    write('demo.gpr', 'project Demo is\nend Demo;\n');
    write('src/demo.ads', 'package Demo with SPARK_Mode => On is\nend Demo;\n');
    write('src/demo.adb', 'package body Demo with SPARK_Mode => On is\nend Demo;\n');
    write('src/main.adb', 'procedure Main is begin null; end Main;\n');
    write('README.md', 'demo\n');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('stores a clean run tied to HEAD and reports each unit', () => {
    const head = git('rev-parse', 'HEAD').toString().trim(),
      res = ingest('basic');
    expect(res).toMatchObject({ duplicate: false, commit: head, dirty: false, origin: 'imported' });
    expect(res.totals).toEqual({ units: 4, proved: 5, unproved: 1, justified: 1, flow_errors: 0 });

    const run = state();
    expect(run).toMatchObject({ verifier: 'gnatprove', signed: false, stale_reason: null, dirty: false });
    expect(statuses(run)).toEqual({
      Demo: 'proved',
      'Demo.Add_Justified': 'justified',
      'Demo.Add_Small': 'proved',
      'Demo.Add_Unchecked': 'unproved',
    });
    expect(run.units[0].file).toBe('src/demo.ads');
    expect(ingest('basic')).toMatchObject({ duplicate: true, run_id: res.run_id });
  });

  it('marks units stale when their spec or body changes, committed or not', () => {
    ingest('basic');
    write('README.md', 'unrelated\n');
    write('src/main.adb', 'procedure Main is begin null; null; end Main;\n');
    expect(statuses(state())['Demo.Add_Small']).toBe('proved');

    write('src/demo.adb', 'package body Demo with SPARK_Mode => On is\n  --  edited\nend Demo;\n');
    expect(new Set(Object.values(statuses(state())))).toEqual(new Set(['stale']));
    git('commit', '-qam', 'edit body');
    expect(new Set(Object.values(statuses(state())))).toEqual(new Set(['stale']));
  });

  it('marks every unit stale when a project file changes', () => {
    ingest('basic');
    write('demo.gpr', 'project Demo is\n   for Source_Dirs use ("src/");\nend Demo;\n');
    const run = state();
    expect(run.stale_reason).toMatch(/project file/);
    expect(new Set(Object.values(statuses(run)))).toEqual(new Set(['stale']));
  });

  it('flags a run ingested with uncommitted Ada changes as dirty', () => {
    write('src/demo.adb', 'package body Demo with SPARK_Mode => On is\n  --  wip\nend Demo;\n');
    expect(ingest('basic').dirty).toBe(true);
    expect(state().dirty).toBe(true);
  });

  it('reports not-analyzed, flow errors and assumptions from the variant run', () => {
    ingest('variant');
    expect(statuses(state())).toMatchObject({
      'Demo.Skipped': 'not-analyzed',
      'Demo.Bad_Flow': 'unproved',
      'Demo.Assumed': 'justified',
    });
  });

  it('rejects a report whose files are not in the repo, and a repo without commits', () => {
    git('rm', '-q', 'src/demo.ads');
    expect(ingest('basic').error).toMatch(/"demo\.ads" not found/);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-proof-empty-'));
    execFileSync('git', ['init', '-q'], { cwd: empty });
    expect(ingestReport(deps, { cwd: empty, report: path.join(FIXTURES, 'basic') }).error).toMatch(/no commits/);
    fs.rmSync(empty, { recursive: true, force: true });
  });

  it('ingests a neutral .json and ignores any origin it claims', () => {
    write(
      'obj/results.json',
      JSON.stringify({
        verifier: 'lean',
        origin: 'ci-signed',
        units: [{ file: 'README.md', unit: 'Readme', proved: 1 }],
      }),
    );
    const res = ingestReport(deps, { cwd: dir, report: 'obj/results.json' });
    expect(res).toMatchObject({ verifier: 'lean', origin: 'imported', duplicate: false });
    expect(proofState(deps, { cwd: dir, verifier: 'lean' }).runs[0]).toMatchObject({
      signed: false,
      origin: 'imported',
    });
  });

  it('runs end to end through the CLI', () => {
    const cli = path.resolve(__dirname, '..', 'memory-store.js'),
      run = (...args) =>
        JSON.parse(execFileSync(process.execPath, [cli, ...args, '--path', dir], { stdio: 'pipe' }).toString());
    expect(run('verify-ingest', '--report', path.join(FIXTURES, 'basic')).totals.unproved).toBe(1);
    expect(run('proof-state').runs[0].summary).toEqual({ proved: 2, justified: 1, unproved: 1 });
  });
});
