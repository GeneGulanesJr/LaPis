// Everyday checkers: recognise a shell command that runs tsc, ESLint, Vitest,
// Jest or pytest, and turn its printed output into verifier-neutral reports.
// Parsers are pure and lenient: output without a checker's summary line (or,
// for tsc/ESLint, an explicit clean run with empty output) yields nothing, so
// truncated, unrelated or `--version`/`--help` output is never recorded.
//
// Units are the files with problems; passing runners only print totals, so
// each report carries `totals` for the whole run, plus its scope (test
// `files`, or pytest `tests`) so a partial run can be told from a full one. Paths are returned as
// printed (absolute or relative to `cwd`); results.js maps them into the repo.

const CHECK_COMMAND_RE =
    /(?:^|[\s;&|(/\\])(?:(?:vue-)?tsc|eslint|vitest|jest|pytest|py\.test)(?:\.cmd|\.exe)?(?=$|[\s;&|)])|\bpython\d*(?:\.exe)?\s+-m\s+pytest\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|typecheck|type-check|check)\b/i,
  ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g; // eslint-disable-line no-control-regex

const lines = (output) => output.replace(ANSI_RE, '').split(/\r?\n/);
const count = (text, word) => Number((text.match(new RegExp(`(\\d+) ${word}`)) || [])[1] || 0);

function addCheck(units, file, check) {
  let u = units.get(file);
  if (!u) {
    u = {
      file,
      unit: file,
      line: check.line ?? null,
      proved: 0,
      unproved: 0,
      justified: 0,
      flow_errors: 0,
      open_checks: [],
    };
    units.set(file, u);
  }
  u.unproved++;
  u.open_checks.push({ file, status: 'unproved', ...check });
}

function report(verifier, units, totals) {
  return { verifier, units: [...units.values()], totals };
}

// --- tsc: `src/a.ts(4,14): error TS2322: msg` or, with --pretty, `src/a.ts:4:14 - error TS2322: msg`.
function parseTsc(output, command) {
  const units = new Map();
  let configError = false;
  for (const l of lines(output)) {
    const m =
      l.match(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/) || l.match(/^(.+?):(\d+):(\d+) - error (TS\d+): (.*)$/);
    if (m) {
      addCheck(units, m[1], { line: Number(m[2]), rule: m[4], message: m[5] });
    } else if (/^error TS\d+:/.test(l)) {
      configError = true; // no file location: tsc did not check the project
    }
  }
  if (configError || (!units.size && (!/(?:^|[\s/\\])(?:vue-)?tsc\b/.test(command) || output.trim()))) {
    return null;
  }
  const errors = [...units.values()].reduce((s, u) => s + u.unproved, 0);
  return report('tsc', units, { proved: 0, unproved: errors, justified: 0, flow_errors: 0 });
}

// --- ESLint "stylish": a file path line, then `  2:10  error  message  rule`.
function parseEslint(output, command) {
  const units = new Map();
  let file = null,
    summary = false;
  for (const l of lines(output)) {
    const m = l.match(/^\s+(\d+):(\d+)\s+(error|warning)\s+(.*?)(?:\s{2,}(\S+))?$/);
    if (m && file) {
      if (m[3] === 'error') {
        addCheck(units, file, { line: Number(m[1]), rule: m[5] || '', message: m[4] });
      }
    } else if (/^[✖×]\s+\d+ problems?/.test(l)) {
      summary = true;
    } else if (/^\S/.test(l)) {
      file = l.trim();
    }
  }
  if (!summary && (output.trim() || !/(?:^|[\s/\\])eslint\b/.test(command))) {
    return null;
  }
  const errors = [...units.values()].reduce((s, u) => s + u.unproved, 0);
  return report('eslint', units, { proved: 0, unproved: errors, justified: 0, flow_errors: 0 });
}

// --- Vitest: `Test Files  1 failed | 1 passed (2)` / `Tests  1 failed | 2 passed (3)`.
function parseVitest(output) {
  const ls = lines(output),
    testsLine = ls.find((l) => /^\s*Tests\s{2,}/.test(l)),
    filesLine = ls.find((l) => /^\s*Test Files\s{2,}/.test(l));
  if (!filesLine || !testsLine) {
    return null;
  }
  const units = new Map();
  for (const l of ls) {
    const t = l.match(/^\s*FAIL\s+(\S+) > (.+)$/),
      suite = l.match(/^\s*FAIL\s+(\S+)\s+\[ .+ \]$/);
    if (t) {
      addCheck(units, t[1], { line: null, rule: 'test', message: t[2].trim() });
    } else if (suite) {
      addCheck(units, suite[1], { line: null, rule: 'suite', message: 'test file failed to run' });
    }
  }
  return report('vitest', units, {
    proved: count(testsLine, 'passed'),
    unproved: count(testsLine, 'failed'),
    justified: 0,
    flow_errors: 0,
    files: Number((filesLine.match(/\((\d+)\)\s*$/) || [])[1]) || null,
  });
}

// --- Jest: `FAIL test/x.test.js`, then `● Suite › test`; summary `Tests:  1 failed, 2 passed, 3 total`.
function parseJest(output) {
  const ls = lines(output),
    testsLine = ls.find((l) => /^Tests:\s+/.test(l)),
    suitesLine = ls.find((l) => /^Test Suites:\s+/.test(l));
  if (!testsLine || !suitesLine) {
    return null;
  }
  const units = new Map(),
    seen = new Set();
  let file = null;
  for (const l of ls) {
    const fail = l.match(/^FAIL\s+(\S+)/),
      bullet = l.match(/^\s+● (.+)$/);
    if (fail) {
      file = fail[1];
    } else if (/^PASS\s/.test(l)) {
      file = null;
    } else if (bullet && file && !seen.has(`${file}\0${bullet[1]}`)) {
      seen.add(`${file}\0${bullet[1]}`);
      addCheck(units, file, { line: null, rule: 'test', message: bullet[1].trim() });
    }
  }
  return report('jest', units, {
    proved: count(testsLine, 'passed'),
    unproved: count(testsLine, 'failed'),
    justified: 0,
    flow_errors: 0,
    files: count(suitesLine, 'total') || null,
  });
}

// --- pytest: `FAILED tests/x.py::test_y - msg` / `ERROR tests/x.py - msg`; summary `=== 1 failed, 2 passed in 0.2s ===`.
function parsePytest(output) {
  const ls = lines(output),
    summary = [...ls].reverse().find((l) => /^=+ .*\bin [\d.]+s\b.* =+$/.test(l));
  if (!summary) {
    return null;
  }
  const units = new Map(),
    rootdir = (ls.find((l) => l.startsWith('rootdir: ')) || '').slice('rootdir: '.length).trim(),
    abs = (p) => (rootdir ? `${rootdir}/${p}` : p);
  for (const l of ls) {
    const m = l.match(/^(FAILED|ERROR) (\S+?)(?:::(\S+))?(?: - (.*))?$/);
    if (m) {
      addCheck(units, abs(m[2]), {
        line: null,
        rule: m[1] === 'ERROR' ? 'error' : 'test',
        message: [m[3], m[4]].filter(Boolean).join(' - ') || m[1],
      });
    }
  }
  // `collected 10 items / 7 deselected / 3 selected`: the run covered the selected ones.
  const collected = ls.find((l) => /collected \d+ items?/.test(l)) || '',
    selected = count(collected, 'selected') || count(collected, 'items?') - count(collected, 'deselected');
  return report('pytest', units, {
    proved: count(summary, 'passed'),
    unproved: count(summary, 'failed') + count(summary, 'errors?'),
    justified: 0,
    flow_errors: 0,
    tests: selected > 0 ? selected : null,
  });
}

const PARSERS = [parseTsc, parseEslint, parseVitest, parseJest, parsePytest];

function isCheckCommand(command) {
  return typeof command === 'string' && CHECK_COMMAND_RE.test(command);
}

/** Reports for every checker whose output appears in `output` (e.g. `npm run check` may run several). */
function parseCheckOutput(command, output) {
  if (!isCheckCommand(command) || typeof output !== 'string') {
    return [];
  }
  return PARSERS.map((p) => p(output, command)).filter(Boolean);
}

module.exports = { isCheckCommand, parseCheckOutput };
