// Git helpers shared by verify-scan and proof-state.

const { execFileSync } = require('child_process');

const GIT_MAX_BUFFER = 64 * 1024 * 1024;

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function repoRoot(cwd) {
  return git(cwd, ['rev-parse', '--show-toplevel']).trim();
}

// Changed paths between `rev` and the working tree, plus untracked files.
// Returns [{ file, oldPath, status }] with repo-relative forward-slash paths.
function changedFiles(root, rev) {
  const tokens = git(root, ['diff', '--name-status', '-z', '-M', rev, '--']).split('\0').filter(Boolean),
    out = [];
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i++];
    if (status[0] === 'R' || status[0] === 'C') {
      const oldPath = tokens[i++],
        file = tokens[i++];
      out.push({ file, oldPath: status[0] === 'R' ? oldPath : null, status: status[0] });
    } else {
      const file = tokens[i++];
      out.push({ file, oldPath: status[0] === 'A' ? null : file, status: status[0] });
    }
  }
  for (const file of git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)) {
    out.push({ file, oldPath: null, status: '?' });
  }
  return out;
}

// Tracked and untracked (not ignored) files.
function repoFiles(root) {
  return git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
}

module.exports = { git, repoRoot, changedFiles, repoFiles };
