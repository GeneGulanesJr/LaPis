const fs = require('fs'),
  os = require('os'),
  path = require('path'),
  { execFileSync } = require('child_process'),
  { scanFilePair, validateAllowlist, applyAllowlist, stripCommentsAndStrings } = require('../src/verification/bypass'),
  { scanRepo } = require('../src/verification');

const rules = (findings) => findings.map((f) => f.rule).sort();

describe('verification bypass rules', () => {
  const scan = (file, oldText, newText) => scanFilePair({ file, oldPath: oldText ? file : null, oldText, newText });

  it.each([
    ['pragma Assume', 'spark-assume', '   pragma Assume (X > 0);'],
    ['SPARK_Mode aspect Off', 'spark-mode-off', 'package body P with SPARK_Mode => Off is'],
    ['SPARK_Mode pragma Off', 'spark-mode-off', 'pragma SPARK_Mode (Off);'],
    ['pragma Annotate', 'spark-annotate', 'pragma Annotate (GNATprove, False_Positive, "overflow", "bounded");'],
    ['Annotate aspect', 'spark-annotate', 'procedure Q with Annotate => (GNATprove, Terminating);'],
    ['Post => True', 'post-true', '  with Post => True;'],
    ["Post'Class => True", 'post-true', "  with Post'Class => True,"],
    ['Pre => False', 'pre-false', '  with Pre => False;'],
  ])('flags added %s', (_label, rule, line) => {
    expect(rules(scan('src/p.adb', 'package body P is\nend P;\n', `package body P is\n${line}\nend P;\n`))).toContain(
      rule,
    );
  });

  it('is case-insensitive for Ada', () => {
    expect(rules(scan('p.adb', '', 'PRAGMA ASSUME (True);'))).toEqual(['spark-assume']);
  });

  it('ignores comments and string literals', () => {
    expect(scan('p.adb', '', '-- pragma Assume (X > 0);\nPut_Line ("pragma Assume");\n')).toEqual([]);
    expect(stripCommentsAndStrings('X := "a--b" & \'"\'; -- note')).toBe('X := "" & \'"\'; ');
  });

  it('does not flag a strengthened Post => True and ...', () => {
    expect(scan('p.ads', '', 'with Post => True and then X > 0;')).toEqual([]);
  });

  it('does not flag an unchanged escape hatch that only moved', () => {
    const before = 'pragma Assume (X > 0);\nY := 1;\n',
      after = 'Y := 1;\npragma Assume (X > 0);\n';
    expect(scan('p.adb', before, after)).toEqual([]);
  });

  it('flags an edited assumption as new', () => {
    expect(rules(scan('p.adb', 'pragma Assume (X > 0);', 'pragma Assume (X >= 0);'))).toEqual(['spark-assume']);
  });

  it('flags a removed contract by net count, not moved lines', () => {
    const spec =
        "procedure Inc (X : in out Integer)\n  with Pre  => X < Integer'Last,\n       Post => X = X'Old + 1;\n",
      noPost = "procedure Inc (X : in out Integer)\n  with Pre  => X < Integer'Last;\n",
      moved = "procedure Inc (X : in out Integer) with\n  Post => X = X'Old + 1,\n  Pre  => X < Integer'Last;\n";
    expect(rules(scan('p.adb', spec, noPost))).toEqual(['contract-removed']);
    expect(scan('p.adb', spec, moved)).toEqual([]);
  });

  it('warns when a contract line changes in a spec but not in a body', () => {
    const before = 'procedure P with Pre => X > 0;',
      after = 'procedure P with Pre => X > -1;';
    expect(scan('p.ads', before, after).map((f) => [f.rule, f.severity])).toEqual([['contract-changed', 'warning']]);
    expect(scan('p.adb', before, after)).toEqual([]);
  });

  it('compares multi-line contracts whole', () => {
    const before = 'procedure P (X : Integer)\n  with Pre =>\n    X > 0\n    and then X < 10;\n',
      continuation = 'procedure P (X : Integer)\n  with Pre =>\n    X > 0\n    and then X < 1000;\n',
      reflowed = 'procedure P (X : Integer) with Pre => X > 0 and then X < 10;\n';
    expect(scan('p.ads', before, continuation).map((f) => [f.rule, f.line, f.text])).toEqual([
      ['contract-changed', 2, 'Pre => X > 0 and then X < 10'],
    ]);
    expect(scan('p.ads', before, reflowed)).toEqual([]);
  });

  it('flags Post => True and Pre => False split over lines', () => {
    expect(rules(scan('p.adb', '', 'procedure P\n  with Post =>\n    True;\n'))).toEqual(['post-true']);
    expect(rules(scan('p.adb', '', 'procedure P\n  with Pre => (False),\n       Global => null;\n'))).toEqual([
      'pre-false',
    ]);
  });

  it('ends a contract at the call or body that encloses it', () => {
    expect(rules(scan('p.adb', '', 'Foo (Pre => True);\nprocedure Q with Post => True is begin null; end Q;'))).toEqual(
      ['post-true'],
    );
  });

  it('keeps Contract_Cases whole, nested arrows included', () => {
    const before = 'procedure P with Contract_Cases => (X > 0 => R = 1, others => R = 0);',
      after = 'procedure P with Contract_Cases => (X > 0 => R = 1, others => True);';
    expect(rules(scan('p.ads', before, after))).toEqual(['contract-changed']);
  });

  it('reports a removal as high only, without a duplicate change warning', () => {
    expect(rules(scan('p.ads', 'procedure P with Pre => X > 0;', 'procedure P;'))).toEqual(['contract-removed']);
  });

  it('flags a deleted spec that held contracts', () => {
    expect(
      rules(scanFilePair({ file: 'p.ads', oldPath: 'p.ads', oldText: 'procedure P with Post => R;', newText: '' })),
    ).toEqual(['contract-removed']);
  });

  it('flags SPARK_Mode Off in a configuration pragma file', () => {
    expect(rules(scan('gnat.adc', '', 'pragma SPARK_Mode (Off);'))).toEqual(['spark-mode-off']);
  });

  it('warns on any project file change', () => {
    expect(
      rules(
        scan('demo.gpr', 'project Demo is\nend Demo;', 'project Demo is\n  for Source_Dirs use ("src");\nend Demo;'),
      ),
    ).toEqual(['project-file-changed']);
  });

  it.each([
    ['sorry', 'lean-sorry', 'theorem t : 1 = 1 := by sorry'],
    ['admit', 'lean-sorry', '  admit'],
    ['axiom', 'lean-axiom', 'axiom magic : False'],
    ['private axiom', 'lean-axiom', 'private axiom magic : False'],
    ['native_decide', 'lean-native-decide', 'example : 2 + 2 = 4 := by native_decide'],
  ])('flags Lean %s', (_label, rule, line) => {
    expect(rules(scan('Foo.lean', '', line))).toEqual([rule]);
  });

  it('ignores Lean comments', () => {
    expect(scan('Foo.lean', '', '-- sorry\n/- axiom x : False\n sorry -/\ntheorem t : True := trivial')).toEqual([]);
  });

  it('ignores files in other languages', () => {
    expect(scan('a.js', '', 'pragma Assume (x)')).toEqual([]);
  });
});

describe('verification allowlist', () => {
  it('requires a reason and a known rule', () => {
    expect(validateAllowlist({}).error).toMatch(/array/);
    expect(validateAllowlist([{ rule: 'spark-mode-off', file: 'a.adb' }]).error).toMatch(/reason/);
    expect(validateAllowlist([{ rule: 'spark-mode-off', file: 'a.adb', reason: '  ' }]).error).toMatch(/reason/);
    expect(validateAllowlist([{ rule: 'nope', file: 'a.adb', reason: 'x' }]).error).toMatch(/unknown rule/);
  });

  it('marks matching findings as allowed with their reason', () => {
    const { entries } = validateAllowlist([{ rule: 'spark-mode-off', file: 'src\\io.adb', reason: 'Text_IO wrapper' }]),
      out = applyAllowlist(
        [
          { rule: 'spark-mode-off', file: 'src/io.adb' },
          { rule: 'spark-mode-off', file: 'src/other.adb' },
        ],
        entries,
      );
    expect(out[0]).toMatchObject({ allowed: true, reason: 'Text_IO wrapper' });
    expect(out[1].allowed).toBeUndefined();
  });
});

describe('verify-scan over a git repo', () => {
  let dir;
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
      cwd: dir,
      stdio: 'pipe',
    });
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-verify-'));
    git('init', '-q', '-b', 'main');
    write(
      'src/demo.ads',
      "package Demo with SPARK_Mode => On is\n  procedure Inc (X : in out Integer)\n    with Pre => X < 100, Post => X = X'Old + 1;\nend Demo;\n",
    );
    write(
      'src/demo.adb',
      'package body Demo with SPARK_Mode => On is\n  procedure Inc (X : in out Integer) is\n  begin\n    X := X + 1;\n  end Inc;\nend Demo;\n',
    );
    git('add', '.');
    git('commit', '-q', '-m', 'base');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('passes a clean tree', () => {
    expect(scanRepo({ cwd: dir })).toMatchObject({ passed: true, exit_code: 0, findings: [] });
  });

  it('fails on committed, uncommitted and untracked bypasses against a base', () => {
    git('checkout', '-q', '-b', 'feature');
    write('src/demo.adb', 'package body Demo with SPARK_Mode => Off is\nend Demo;\n');
    git('commit', '-qam', 'off');
    write('src/demo.ads', 'package Demo with SPARK_Mode => On is\n  procedure Inc (X : in out Integer);\nend Demo;\n');
    write('src/extra.adb', 'procedure Extra is begin pragma Assume (True); end Extra;\n');

    const result = scanRepo({ cwd: dir, base: 'main' });
    expect(result.exit_code).toBe(1);
    expect(result.findings.map((f) => `${f.file}:${f.rule}`).sort()).toEqual([
      'src/demo.adb:spark-mode-off',
      'src/demo.ads:contract-removed',
      'src/extra.adb:spark-assume',
    ]);
  });

  it('passes when the allowlist covers the finding, but warns that the allowlist changed', () => {
    write('src/demo.adb', 'package body Demo with SPARK_Mode => Off is\nend Demo;\n');
    write(
      '.lapis-verify-allow.json',
      JSON.stringify([{ rule: 'spark-mode-off', file: 'src/demo.adb', reason: 'I/O wrapper' }]),
    );
    const result = scanRepo({ cwd: dir });
    expect(result).toMatchObject({ passed: true, exit_code: 0, summary: { high: 0, allowed: 1, warning: 1 } });
    expect(result.findings.map((f) => f.rule).sort()).toEqual(['allowlist-changed', 'spark-mode-off']);
  });

  it('rejects an allowlist entry without a reason', () => {
    write('.lapis-verify-allow.json', JSON.stringify([{ rule: 'spark-mode-off', file: 'src/demo.adb' }]));
    expect(scanRepo({ cwd: dir }).error).toMatch(/reason/);
  });

  it('exits 1 from the CLI on a bypass and never creates a memory DB', () => {
    write('src/demo.adb', 'package body Demo with SPARK_Mode => Off is\nend Demo;\n');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-verify-home-')),
      cli = path.resolve(__dirname, '..', 'memory-store.js');
    let status = 0;
    try {
      execFileSync(process.execPath, [cli, 'verify-scan', '--path', dir], {
        env: { ...process.env, LAPIS_HOME: home },
        stdio: 'pipe',
      });
    } catch (e) {
      status = e.status;
    }
    const created = fs.readdirSync(home);
    fs.rmSync(home, { recursive: true, force: true });
    expect(status).toBe(1);
    expect(created).toEqual([]);
  });

  it('rejects an option-looking base', () => {
    expect(scanRepo({ cwd: dir, base: '--output=x' }).error).toMatch(/Invalid --base/);
  });
});
