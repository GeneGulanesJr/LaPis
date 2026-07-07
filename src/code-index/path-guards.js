const fs = require('fs');
const path = require('path');
const { pathIsInside, SECRET_FILE_RE } = require('./scanner');

/**
 * Resolve a changed-path entry to an absolute path inside repoRoot.
 * Returns null when the path escapes the repo or matches secret-file patterns.
 */
function resolveRepoScopedPath(repoPath, filePath) {
  if (!filePath || typeof filePath !== 'string') {
    return null;
  }
  const absRoot = path.resolve(repoPath);
  const abs = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(absRoot, filePath);
  let resolved = abs;
  try {
    resolved = fs.realpathSync(abs);
  } catch {
    return null;
  }
  if (!pathIsInside(absRoot, resolved)) {
    return null;
  }
  if (SECRET_FILE_RE.test(resolved.replace(/\\/g, '/'))) {
    return null;
  }
  return resolved;
}

module.exports = { resolveRepoScopedPath };
