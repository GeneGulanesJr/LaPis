const path = require('path'), fs = require('fs'), { CODE_EXTENSIONS, IGNORE_DIRS_CODE } = require('../../utils'),
  DEFAULT_MAX_FILE_SIZE = 1024 * 1024,
  DEFAULT_MAX_FILES = 20000,
  SECRET_FILE_RE = /(^|[/\\])(\.env($|\.)|id_rsa$|id_dsa$|id_ecdsa$|id_ed25519$|.*\.(pem|key|p12|pfx)$)/i,
  SKIP_FILE_RE =
    /(^|[/\\])(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Gemfile\.lock|poetry\.lock|Cargo\.lock|composer\.lock|pipfile\.lock|bun\.lockb|bun\.lock|conan\.lock|mix\.lock|podfile\.lock|go\.sum|requirements\.txt\.lock|\.yarn\/integrity|package\.json|bower\.json|composer\.json|tsconfig\.json|tsconfig\.[^/\\]+\.json|jsconfig\.json|\.babelrc|babel\.config\.[^/\\]+|\.eslintrc|eslint\.config\.[^/\\]+|\.prettierrc|prettier\.config\.[^/\\]+|\.stylelintrc|manifest\.json|manifest\.webmanifest|\.node-version|\.nvmrc|\.tool-versions)$|\.lock$|\.lock\.json$/i,
  PRIORITY_DIRS = ['src/', 'lib/', 'pkg/', 'cmd/', 'internal/', 'app/', 'packages/'];



function shouldSkipDir(dirName, extraIgnoreDirs = []) {
  return dirName.startsWith('.') || IGNORE_DIRS_CODE.has(dirName) || extraIgnoreDirs.includes(dirName);
}

function isCodeFile(filePath) {
  return CODE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function loadIgnoreRules(repoPath, filename) {
  let ig, added = false;
  try {
    ig = require('ignore')();
  } catch {
    return null;
  }

  

  

  {
let current = path.resolve(repoPath), limit = 20;
  const rootsToTry = [];

  // Walk up from repoPath, but stop at the Git repo boundary (directory containing .git/).
  // Git itself never loads .gitignore from parent directories outside the repo root.
  // Without this guard, a parent .gitignore with '*' (e.g. ~/.pi/agent/git/.gitignore)
  // Would cause the scanner to ignore every file in the repo.
  
  while (limit-- > 0) {
    rootsToTry.push(current);
    // Stop walking up if this directory is a Git repo root.
    // This prevents parent .gitignore rules from leaking into the scan.
    try {
      if (fs.statSync(path.join(current, '.git')).isDirectory()) {
        break;
      }
    } catch {
      // .git doesn't exist here — keep walking up
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  for (let i = rootsToTry.length - 1; i >= 0; i--) {
    tryLoad(rootsToTry[i]);
  }

  return added ? ig : null;
function tryLoad(dir) {
    const ignorePath = path.join(dir, filename);
    try {
      const content = fs.readFileSync(ignorePath, 'utf-8');
      ig.add(content);
      added = true;
    } catch {}
  }
}
}

function loadGitignoreRules(repoPath) {
  return loadIgnoreRules(repoPath, '.gitignore');
}

function loadMemorycodeignoreRules(repoPath) {
  return loadIgnoreRules(repoPath, '.memorycodeignore');
}

function tryCreateIgnore(patterns) {
  if (!patterns || patterns.length === 0) {
    return null;
  }
  try {
    return require('ignore')().add(patterns);
  } catch {
    return null;
  }
}

function isBinaryFile(filePath, sampleSize = 8000) {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(sampleSize),
        bytesRead = fs.readSync(fd, buf, 0, sampleSize, 0);
      if (bytesRead === 0) {
        return false;
      }
      for (let i = 0; i < bytesRead; i++) {
        if (buf[i] === 0) {
          return true;
        }
      }
      return false;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function pathIsInside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function prioritySort(root) {
  return (a, b) => {
    const ar = path.relative(root, a).replace(/\\/g, '/'),
      br = path.relative(root, b).replace(/\\/g, '/'),
      ap = PRIORITY_DIRS.findIndex((prefix) => ar.startsWith(prefix)),
      bp = PRIORITY_DIRS.findIndex((prefix) => br.startsWith(prefix)),
      ai = ap === -1 ? PRIORITY_DIRS.length : ap,
      bi = bp === -1 ? PRIORITY_DIRS.length : bp;
    if (ai !== bi) {
      return ai - bi;
    }
    return ar.localeCompare(br);
  };
}

function scanRepository(repoPath, options = {}) {
  const results = [],
    absRoot = path.resolve(repoPath),
    extraIgnoreDirs = options.ignoreDirs || [],
    gitignoreIg = loadGitignoreRules(absRoot),
    nestedGitignoreRules = [],
    memorycodeignoreIg = loadMemorycodeignoreRules(absRoot),
    extraIgnoreIg = tryCreateIgnore(options.extraIgnorePatterns || []),
    maxFileSize = Number(options.maxFileSize || DEFAULT_MAX_FILE_SIZE),
    maxFiles = Number(options.maxFiles || DEFAULT_MAX_FILES),
    followSymlinks = options.followSymlinks === true,
    skipReport = {
      builtIn: {},
      gitignore: {},
      memorycodeignore: {},
      extraIgnore: {},
      unsupportedExt: 0,
      tooLarge: 0,
      binary: 0,
      secret: 0,
      lock: 0,
      symlink: 0,
      pathTraversal: 0,
      unreadable: 0,
      fileLimit: 0,
    },
    ignoreFiles = options.onProgress || null,
    reportScanProgress = options.onScanProgress || null,
    scanStats = { dirsVisited: 0, entriesSeen: 0, codeFiles: 0, currentPath: '.', currentKind: 'directory' };

  function mark(reason, key, relativePath) {
    if (typeof skipReport[reason] === 'number') {
      skipReport[reason]++;
    } else {
      skipReport[reason][key] = (skipReport[reason][key] || 0) + 1;
    }
    if (ignoreFiles) {
      ignoreFiles(relativePath, reason);
    }
  }

  function maybeReportScanProgress(force = false) {
    if (!reportScanProgress) {
      return;
    }
    if (
      force ||
      scanStats.entriesSeen <= 10 ||
      scanStats.entriesSeen % 500 === 0 ||
      (scanStats.codeFiles > 0 && scanStats.codeFiles % 100 === 0)
    ) {
      reportScanProgress({ ...scanStats });
    }
  }

  function ignoredBy(relativePath, isDir = false) {
    const rel = relativePath.replace(/\\/g, '/') + (isDir && !relativePath.endsWith(path.sep) ? '/' : '');
    if (gitignoreIg && (gitignoreIg.ignores(relativePath) || gitignoreIg.ignores(rel))) {
      return 'gitignore';
    }
    for (const rule of nestedGitignoreRules) {
      if (!relativePath.startsWith(rule.prefix)) {
        // oxlint-disable-next-line no-continue
        continue;
      }
      const local = relativePath.slice(rule.prefix.length).replace(/\\/g, '/'),
        localDir = local + (isDir && !local.endsWith('/') ? '/' : '');
      if (local && (rule.ig.ignores(local) || rule.ig.ignores(localDir))) {
        return 'gitignore';
      }
    }
    if (memorycodeignoreIg && (memorycodeignoreIg.ignores(relativePath) || memorycodeignoreIg.ignores(rel))) {
      return 'memorycodeignore';
    }
    if (extraIgnoreIg && (extraIgnoreIg.ignores(relativePath) || extraIgnoreIg.ignores(rel))) {
      return 'extraIgnore';
    }
    return null;
  }

  function walk(dir) {
    scanStats.dirsVisited++;
    scanStats.currentPath = path.relative(absRoot, dir) || '.';
    scanStats.currentKind = 'directory';
    if (scanStats.dirsVisited <= 5 || scanStats.dirsVisited % 50 === 0) {
      maybeReportScanProgress(true);
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      skipReport.unreadable++;
      return;
    }

    if (entries.some((entry) => entry.isFile() && entry.name === '.gitignore')) {
      try {
        const ig = require('ignore')().add(fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8')),
          dirRel = path.relative(absRoot, dir);
        nestedGitignoreRules.push({ prefix: dirRel ? `${dirRel}${path.sep}` : '', ig });
      } catch {}
    }

    for (const entry of entries) {
      scanStats.entriesSeen++;
      const fullPath = path.join(dir, entry.name),
        relativePath = path.relative(absRoot, fullPath);
      scanStats.currentPath = relativePath;
      scanStats.currentKind = entry.isDirectory() ? 'directory' : 'file';
      if (entry.isSymbolicLink() && !followSymlinks) {
        mark('symlink', entry.name, relativePath);
        // oxlint-disable-next-line no-continue
        continue;
      }
      let resolved = fullPath;
      try {
        resolved = fs.realpathSync(fullPath);
      } catch {}
      if (!pathIsInside(absRoot, resolved)) {
        mark('pathTraversal', entry.name, relativePath);
        // oxlint-disable-next-line no-continue
        continue;
      }
      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name, extraIgnoreDirs)) {
          mark('builtIn', entry.name, relativePath);
        } else {
          const ignored = ignoredBy(relativePath, true);
          if (ignored) {
            mark(ignored, entry.name, relativePath);
          } else {
            walk(fullPath);
          }
        }
      } else if (entry.isFile()) {
        if (!isCodeFile(fullPath)) {
          skipReport.unsupportedExt++;
          maybeReportScanProgress();
          // oxlint-disable-next-line no-continue
          continue;
        }
        const ignored = ignoredBy(relativePath, false);
        if (ignored) {
          mark(ignored, path.extname(entry.name) || entry.name, relativePath);
          // oxlint-disable-next-line no-continue
          continue;
        }
        if (SECRET_FILE_RE.test(relativePath.replace(/\\/g, '/'))) {
          mark('secret', entry.name, relativePath);
          // oxlint-disable-next-line no-continue
          continue;
        }
        if (SKIP_FILE_RE.test(relativePath.replace(/\\/g, '/'))) {
          mark('lock', entry.name, relativePath);
          // oxlint-disable-next-line no-continue
          continue;
        }
        let stats;
        try {
          stats = fs.statSync(fullPath);
        } catch {
          skipReport.unreadable++;
          // oxlint-disable-next-line no-continue
          continue;
        }
        if (maxFileSize > 0 && stats.size > maxFileSize) {
          mark('tooLarge', path.extname(entry.name) || entry.name, relativePath);
          // oxlint-disable-next-line no-continue
          continue;
        }
        if (isBinaryFile(fullPath)) {
          mark('binary', path.extname(entry.name) || entry.name, relativePath);
          // oxlint-disable-next-line no-continue
          continue;
        }
        results.push(fullPath);
        scanStats.codeFiles++;
        maybeReportScanProgress();
      }
    }
  }

  walk(absRoot);
  if (results.length > maxFiles) {
    skipReport.fileLimit = results.length - maxFiles;
    results.sort(prioritySort(absRoot));
    results.length = maxFiles;
  }
  if (reportScanProgress) {
    reportScanProgress({ ...scanStats, done: true });
  }
  return { files: results, skipReport };
}

module.exports = {
  isBinaryFile,
  isCodeFile,
  scanRepository,
  shouldSkipDir,
  loadGitignoreRules,
  pathIsInside,
  SECRET_FILE_RE,
  SKIP_FILE_RE,
};
