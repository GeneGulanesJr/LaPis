const fs = require('fs');
const path = require('path');
const { pathIsInside, SECRET_FILE_RE } = require('./scanner');

/**
 * Resolve a changed-path entry to an absolute path inside repoRoot.
 * Returns null when the path escapes the repo or matches secret-file patterns.
 */
function resolveRepoScopedPath(repoPath, filePath, rejections) {
  if (!filePath || typeof filePath !== 'string') {
    if (rejections) {
      rejections.push({ path: filePath, reason: 'invalid_path' });
    }
    return null;
  }
  let absRoot;
  try {
    absRoot = fs.realpathSync(path.resolve(repoPath));
  } catch {
    if (rejections) {
      rejections.push({ path: filePath, reason: 'repo_unavailable' });
    }
    return null;
  }
  const abs = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(absRoot, filePath);
  let resolved = abs;
  try {
    resolved = fs.realpathSync(abs);
  } catch {
    if (rejections) {
      rejections.push({ path: filePath, reason: 'unreadable' });
    }
    return null;
  }
  if (!pathIsInside(absRoot, resolved)) {
    if (rejections) {
      rejections.push({ path: filePath, reason: 'outside_repo' });
    }
    return null;
  }
  if (SECRET_FILE_RE.test(resolved.replace(/\\/g, '/'))) {
    if (rejections) {
      rejections.push({ path: filePath, reason: 'secret_file' });
    }
    return null;
  }
  return resolved;
}

module.exports = { resolveRepoScopedPath };
