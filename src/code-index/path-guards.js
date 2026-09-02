const fs = require('fs'),
  path = require('path'),
  { pathIsInside, SECRET_FILE_RE } = require('./scanner');

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
  {
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
}

/**
 * Resolve a *deleted* path entry to an absolute path inside repoRoot.
 * Deleted files no longer exist on disk, so realpathSync cannot resolve them;
 * this variant validates containment against absRoot (which must itself be
 * real-path-resolved by the caller) without requiring the candidate to exist.
 * Returns the lexically-resolved absolute path, or null when it escapes the
 * repo or matches secret-file patterns.
 */
function resolveRepoScopedDeletedPath(absRoot, filePath, rejections) {
  if (!filePath || typeof filePath !== 'string') {
    if (rejections) {
      rejections.push({ path: filePath, reason: 'invalid_path' });
    }
    return null;
  }
  const abs = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(absRoot, filePath);
  if (!pathIsInside(absRoot, abs)) {
    if (rejections) {
      rejections.push({ path: filePath, reason: 'outside_repo' });
    }
    return null;
  }
  if (SECRET_FILE_RE.test(abs.replace(/\\/g, '/'))) {
    if (rejections) {
      rejections.push({ path: filePath, reason: 'secret_file' });
    }
    return null;
  }
  return abs;
}

module.exports = { resolveRepoScopedPath, resolveRepoScopedDeletedPath };
