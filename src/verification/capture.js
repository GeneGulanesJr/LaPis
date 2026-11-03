// Automatic capture: hosts call this after the agent's shell tool runs a check
// command (tsc, ESLint, Vitest, Jest, pytest). Each recognised result is
// stored as a run tied to HEAD plus the worktree snapshot. Never throws.

const path = require('path'),
  crypto = require('crypto'),
  { git, repoRoot } = require('./git'),
  { parseCheckOutput, isCheckCommand } = require('./checkers'),
  { storeReport } = require('./results');

// shortcut: only the last 256 KB of output is parsed (summary lines are at the end), failures printed earlier in huge outputs are missed; stream the full output if that matters.
const MAX_OUTPUT = 256 * 1024;

// Printed path (absolute, or relative to the command's cwd) → repo-relative, or null outside the repo.
// Backslashes count as separators everywhere: Windows tools print them (ESLint, pytest progress lines).
function toRepoPath(root, cwd, printed) {
  const p = printed.replace(/\\/g, '/'),
    abs = path.isAbsolute(p) ? p : path.resolve(cwd, p),
    rel = path.relative(root, abs).replace(/\\/g, '/');
  return rel && !rel.startsWith('../') && rel !== '..' && !path.isAbsolute(rel) ? rel : null;
}

function captureCheckOutput(deps, { cwd, command, output }) {
  try {
    if (!isCheckCommand(command) || typeof output !== 'string' || !cwd) {
      return { captured: [] };
    }
    const text = output.length > MAX_OUTPUT ? output.slice(-MAX_OUTPUT) : output,
      reports = parseCheckOutput(command, text);
    if (!reports.length) {
      return { captured: [] };
    }
    let root, commit;
    try {
      root = repoRoot(cwd);
      commit = git(root, ['rev-parse', '--verify', 'HEAD']).trim();
    } catch {
      return { captured: [], skipped: 'not a git repository with commits' };
    }
    const captured = [];
    for (const r of reports) {
      for (const u of r.units) {
        u.file = toRepoPath(root, cwd, u.file);
        u.unit = u.file;
        for (const c of u.open_checks) {
          c.file = u.file;
        }
      }
      r.units = r.units.filter((u) => u.file);
      const sha = crypto.createHash('sha256').update(`${r.verifier}\0${text}`).digest('hex'),
        res = storeReport(deps, { root, commit, parsed: r, sha, lenient: true });
      captured.push(
        res.error
          ? { verifier: r.verifier, error: res.error }
          : { verifier: r.verifier, run_id: res.run_id, totals: res.totals },
      );
    }
    return { captured };
  } catch (e) {
    return { captured: [], error: e instanceof Error ? e.message : String(e) };
  }
}

module.exports = { captureCheckOutput, toRepoPath, MAX_OUTPUT };
