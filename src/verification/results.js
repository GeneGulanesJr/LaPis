// Verifier results: validate the verifier-neutral format, store it in
// verifier_runs / verifier_results, and report proof state. A stored run says
// what the prover found at one commit; proof-state marks a unit stale as soon
// as its files change, so an old result never reads as proof of current code.
//
// Verifier-neutral format (what each adapter produces, or a .json you pass):
//   { "verifier": "gnatprove", "verifier_version": "FSF 16.1.0", "ran_at": "...",
//     "units": [{ "file": "src/demo.ads", "unit": "Demo.Add", "line": 6,
//                 "analyzed": true, "proved": 2, "unproved": 0, "justified": 0,
//                 "flow_errors": 0,
//                 "open_checks": [{ "file", "line", "rule", "message", "status",
//                                   "severity"?, "reason"? }] }] }
// Justified covers pragma Annotate and pragma Assume: never counted as proved.

const fs = require('fs'),
  path = require('path'),
  crypto = require('crypto'),
  { git, repoRoot, changedFiles, repoFiles } = require('./git'),
  { languageOf } = require('./bypass'),
  gnatprove = require('./gnatprove');

const MAX_OPEN_CHECKS = 50,
  MAX_TEXT = 500,
  COUNT_FIELDS = ['proved', 'unproved', 'justified', 'flow_errors'],
  ADA_PAIR = { '.ads': '.adb', '.adb': '.ads' },
  MAX_SNAPSHOT_FILES = 2000,
  KEEP_RUNS = 20, // per repo and verifier
  // A change to one of these can change every unit's result.
  PROJECT_FILE_RE = /(?:\.gpr|\.adc|(?:^|\/)(?:lakefile\.lean|lakefile\.toml|lean-toolchain|lake-manifest\.json))$/i;

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

function hashFiles(files) {
  const h = crypto.createHash('sha256');
  for (const [name, text] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    h.update(`${name}\0${sha256(text)}\0`);
  }
  return h.digest('hex');
}

function clip(v, max = MAX_TEXT) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function badPath(p) {
  return /^(?:[a-z]:)?\//i.test(p) || p.split('/').includes('..');
}

/** Validate a parsed neutral report. Returns { report } or { error }. */
function validateNeutral(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'report must be a JSON object' };
  }
  if (typeof raw.verifier !== 'string' || !/^[a-z][a-z0-9_.-]{0,31}$/.test(raw.verifier)) {
    return { error: '"verifier" must be a short lowercase name, e.g. "gnatprove"' };
  }
  if (!Array.isArray(raw.units)) {
    return { error: '"units" must be an array' };
  }
  const units = [];
  for (const [i, u] of raw.units.entries()) {
    const where = `units[${i}]`,
      file = typeof u?.file === 'string' ? u.file.replace(/\\/g, '/') : '';
    if (!file || file.length > 1024 || badPath(file)) {
      return { error: `${where}: "file" must be a repo-relative path` };
    }
    if (typeof u.unit !== 'string' || !u.unit.trim()) {
      return { error: `${where}: "unit" is required` };
    }
    if (u.line != null && !(Number.isInteger(u.line) && u.line > 0)) {
      return { error: `${where}: "line" must be a positive integer` };
    }
    const counts = {};
    for (const f of COUNT_FIELDS) {
      const n = u[f] ?? 0;
      if (!Number.isInteger(n) || n < 0) {
        return { error: `${where}: "${f}" must be a non-negative integer` };
      }
      counts[f] = n;
    }
    if (u.open_checks != null && !Array.isArray(u.open_checks)) {
      return { error: `${where}: "open_checks" must be an array` };
    }
    units.push({
      file,
      unit: clip(u.unit),
      line: u.line ?? null,
      analyzed: u.analyzed !== false,
      ...counts,
      open_checks: (u.open_checks || []).slice(0, MAX_OPEN_CHECKS).map((c) => ({
        file: clip(c?.file).replace(/\\/g, '/'),
        line: Number.isInteger(c?.line) ? c.line : null,
        rule: clip(c?.rule, 100),
        message: clip(c?.message),
        status: clip(c?.status, 32),
        ...(c?.severity ? { severity: clip(c.severity, 32) } : {}),
        ...(c?.reason ? { reason: clip(c.reason) } : {}),
      })),
    });
  }
  let totals = null;
  if (raw.totals != null) {
    totals = {};
    for (const f of COUNT_FIELDS) {
      const n = raw.totals[f] ?? 0;
      if (!Number.isInteger(n) || n < 0) {
        return { error: `totals: "${f}" must be a non-negative integer` };
      }
      totals[f] = n;
    }
  }
  return {
    report: {
      verifier: raw.verifier,
      verifier_version: typeof raw.verifier_version === 'string' ? clip(raw.verifier_version, 200) : null,
      ran_at: typeof raw.ran_at === 'string' ? clip(raw.ran_at, 64) : null,
      units,
      totals,
    },
  };
}

// GNATprove reports bare file names (unique within a GNAT project): map each
// to its repo path. A unit whose file cannot be found is an error, because a
// wrong path would hide the edits that make its result stale. `lenient`
// (auto-captured output) drops such units instead.
function resolvePaths(report, files, { lenient = false } = {}) {
  const set = new Set(files),
    byBase = new Map();
  for (const f of files) {
    const base = path.posix.basename(f).toLowerCase();
    byBase.set(base, [...(byBase.get(base) || []), f]);
  }
  const resolve = (p) => {
    if (set.has(p)) {
      return { path: p };
    }
    const hits = p.includes('/') ? [] : byBase.get(p.toLowerCase()) || [];
    if (hits.length === 1) {
      return { path: hits[0] };
    }
    return { error: hits.length ? `"${p}" matches several files: ${hits.join(', ')}` : `"${p}" not found in the repo` };
  };
  const kept = [];
  for (const u of report.units) {
    const r = resolve(u.file);
    if (r.error) {
      if (lenient) {
        continue;
      }
      return { error: `unit ${u.unit}: ${r.error}` };
    }
    if (u.unit === u.file) {
      u.unit = r.path; // everyday checkers name units by file
    }
    u.file = r.path;
    for (const c of u.open_checks) {
      c.file = c.file ? resolve(c.file).path || c.file : u.file;
    }
    kept.push(u);
  }
  report.units = kept;
  return { report };
}

function totalsOf(units, given) {
  const t = { units: units.length };
  for (const f of COUNT_FIELDS) {
    t[f] = given ? given[f] : units.reduce((s, u) => s + u[f], 0);
  }
  return t;
}

function hashFile(root, file) {
  try {
    const p = path.join(root, file),
      st = fs.statSync(p);
    // shortcut: files over 5 MB are fingerprinted by size+mtime instead of content, hash them if that misses edits.
    return st.size > 5 * 1024 * 1024 ? `big:${st.size}:${st.mtimeMs}` : sha256(fs.readFileSync(p));
  } catch {
    return null; // deleted
  }
}

// Content of every file that differs from HEAD when the run is stored, so an
// uncommitted file the checker already saw is not reported as changed since.
function worktreeSnapshot(root, changed) {
  if (changed.length > MAX_SNAPSHOT_FILES) {
    return null; // too many to fingerprint: treat every changed file as changed since
  }
  const snap = {};
  for (const c of changed) {
    snap[c.file] = hashFile(root, c.file);
  }
  return snap;
}

/**
 * Files that changed after the run: differ from the run's commit now and
 * either were not dirty when it ran or have different content since. Null
 * when the run's commit is gone (rebased or not fetched).
 */
function changedSinceRun(root, run) {
  let now;
  try {
    now = changedFiles(root, run.commit_sha);
  } catch {
    return null;
  }
  const snap = run.worktree_json ? JSON.parse(run.worktree_json) : run.dirty ? null : {},
    out = new Set();
  for (const f of new Set([...now.flatMap((c) => [c.file, c.oldPath].filter(Boolean)), ...Object.keys(snap || {})])) {
    if (!snap || !(f in snap) || hashFile(root, f) !== snap[f]) {
      out.add(f);
    }
  }
  return out;
}

function readReport(reportPath, format) {
  const stat = fs.statSync(reportPath),
    fmt = format || (stat.isDirectory() ? 'gnatprove' : 'neutral');
  if (fmt === 'gnatprove') {
    if (!stat.isDirectory()) {
      throw new Error('--format gnatprove expects the gnatprove output folder (obj/.../gnatprove)');
    }
    const files = gnatprove.readReportDir(reportPath);
    return { sha: hashFiles(files), parsed: gnatprove.parseGnatprove(files) };
  }
  if (fmt === 'neutral') {
    const bytes = fs.readFileSync(reportPath);
    return { sha: sha256(bytes), parsed: JSON.parse(bytes.toString('utf8')) };
  }
  throw new Error(`unknown --format "${fmt}" (gnatprove | neutral)`);
}

/**
 * Store a prover report for the repo containing `cwd`, tied to its HEAD.
 * The run is marked dirty when verifier sources differ from HEAD. Origin is
 * always "imported": a self-reported file is never treated as signed.
 */
function ingestReport(deps, { cwd = process.cwd(), report, format } = {}) {
  if (typeof report !== 'string' || !report) {
    return { error: 'Missing --report <gnatprove output folder | results .json>' };
  }
  let root, commit;
  try {
    root = repoRoot(cwd);
  } catch {
    return { error: `Not a git repository: ${cwd}` };
  }
  try {
    commit = git(root, ['rev-parse', '--verify', 'HEAD']).trim();
  } catch {
    return { error: 'The repository has no commits yet: commit before ingesting a report' };
  }

  let read;
  try {
    read = readReport(path.resolve(cwd, report), format);
  } catch (e) {
    return { error: `Cannot read report ${report}: ${e.message}` };
  }
  return storeReport(deps, { root, commit, parsed: read.parsed, sha: read.sha });
}

/** Validate, resolve and store a parsed neutral report for `root` at `commit`. */
function storeReport({ sqlJson, sqlRun, withTransaction }, { root, commit, parsed, sha, lenient = false }) {
  const valid = validateNeutral(parsed);
  if (valid.error) {
    return { error: `Invalid report: ${valid.error}` };
  }
  const resolved = resolvePaths(valid.report, repoFiles(root), { lenient });
  if (resolved.error) {
    return { error: `Invalid report: ${resolved.error}` };
  }
  const r = resolved.report,
    changed = changedFiles(root, 'HEAD'),
    dirty = changed.some((c) => languageOf(c.file) || PROJECT_FILE_RE.test(c.file)) ? 1 : 0,
    snapshot = worktreeSnapshot(root, changed),
    totals = totalsOf(r.units, r.totals),
    summary = {
      verifier: r.verifier,
      verifier_version: r.verifier_version,
      commit,
      dirty: !!dirty,
      origin: 'imported',
      totals,
    },
    snapshotJson = snapshot ? JSON.stringify(snapshot) : null,
    existing = sqlJson(
      `SELECT id FROM verifier_runs WHERE repo_root = ? AND verifier = ? AND commit_sha = ? AND source_sha256 = ?
         AND dirty = ? AND worktree_json IS ?`,
      [root, r.verifier, commit, sha, dirty, snapshotJson],
    );
  if (existing.length) {
    return { run_id: existing[0].id, duplicate: true, ...summary };
  }

  const runId = withTransaction(() => {
    const id = Number(
      sqlRun(
        `INSERT INTO verifier_runs (repo_root, verifier, verifier_version, commit_sha, dirty, origin, source_sha256, totals_json, ran_at, worktree_json)
         VALUES (?, ?, ?, ?, ?, 'imported', ?, ?, ?, ?)`,
        [root, r.verifier, r.verifier_version, commit, dirty, sha, JSON.stringify(totals), r.ran_at, snapshotJson],
      ).lastInsertRowid,
    );
    // Keep the newest runs only (results first: foreign keys may be off).
    const old = `SELECT id FROM verifier_runs WHERE repo_root = ? AND verifier = ? ORDER BY id DESC LIMIT -1 OFFSET ${KEEP_RUNS}`;
    sqlRun(`DELETE FROM verifier_results WHERE run_id IN (${old})`, [root, r.verifier]);
    sqlRun(`DELETE FROM verifier_runs WHERE id IN (${old})`, [root, r.verifier]);
    for (const u of r.units) {
      sqlRun(
        `INSERT INTO verifier_results (run_id, file_path, unit, unit_key, line, analyzed, proved, unproved, justified, flow_errors, open_checks_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          u.file,
          u.unit,
          u.unit.toLowerCase(),
          u.line,
          u.analyzed ? 1 : 0,
          u.proved,
          u.unproved,
          u.justified,
          u.flow_errors,
          JSON.stringify(u.open_checks),
        ],
      );
    }
    return id;
  });
  return { run_id: runId, duplicate: false, ...summary };
}

function touched(changed, file) {
  const ext = path.posix.extname(file).toLowerCase();
  return changed.has(file) || (ADA_PAIR[ext] !== undefined && changed.has(file.slice(0, -ext.length) + ADA_PAIR[ext]));
}

function statusOf(row, stale) {
  if (stale) {
    return 'stale';
  }
  if (!row.analyzed) {
    return 'not-analyzed';
  }
  if (row.unproved || row.flow_errors) {
    return 'unproved';
  }
  return row.justified ? 'justified' : 'proved';
}

/**
 * Latest run per verifier for the repo containing `cwd`, with each unit's
 * status: proved | justified | unproved | not-analyzed | stale. A unit is
 * stale when its file (or its Ada spec/body) changed since the run's commit,
 * including uncommitted edits; a project-file change makes every unit stale.
 */
function proofState({ sqlJson }, { cwd = process.cwd(), verifier } = {}) {
  let root;
  try {
    root = repoRoot(cwd);
  } catch {
    return { error: `Not a git repository: ${cwd}` };
  }
  const runs = sqlJson(
    `SELECT * FROM verifier_runs WHERE id IN
       (SELECT MAX(id) FROM verifier_runs WHERE repo_root = ? ${verifier ? 'AND verifier = ?' : ''} GROUP BY verifier)
     ORDER BY verifier`,
    verifier ? [root, verifier] : [root],
  ).map((run) => {
    const changed = changedSinceRun(root, run),
      staleReason =
        changed === null
          ? `commit ${run.commit_sha.slice(0, 12)} not found`
          : [...changed].some((f) => PROJECT_FILE_RE.test(f))
            ? 'project file changed since the run'
            : null,
      units = sqlJson('SELECT * FROM verifier_results WHERE run_id = ? ORDER BY file_path, line', [run.id]).map(
        (u) => ({
          file: u.file_path,
          unit: u.unit,
          line: u.line,
          status: statusOf(u, staleReason !== null || touched(changed, u.file_path)),
          proved: u.proved,
          unproved: u.unproved,
          justified: u.justified,
          flow_errors: u.flow_errors,
          open_checks: JSON.parse(u.open_checks_json),
        }),
      ),
      summary = {};
    for (const u of units) {
      summary[u.status] = (summary[u.status] || 0) + 1;
    }
    return {
      verifier: run.verifier,
      verifier_version: run.verifier_version,
      run_id: run.id,
      commit: run.commit_sha,
      dirty: !!run.dirty,
      origin: run.origin,
      signed: run.origin === 'ci-signed',
      ran_at: run.ran_at,
      ingested_at: run.ingested_at,
      stale_reason: staleReason,
      totals: JSON.parse(run.totals_json),
      // Repo files edited after the run (any kind), so a clean run can still say "re-run".
      changed_since: changed ? [...changed].sort() : null,
      summary,
      units,
    };
  });
  return { repo_root: root, runs };
}

module.exports = { validateNeutral, resolvePaths, ingestReport, storeReport, proofState };
