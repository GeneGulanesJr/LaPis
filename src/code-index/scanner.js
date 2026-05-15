const path = require('path');
const fs = require('fs');
const { CODE_EXTENSIONS, IGNORE_DIRS_CODE } = require('../../utils');

function shouldSkipDir(dirName, extraIgnoreDirs = []) {
  return dirName.startsWith('.') || IGNORE_DIRS_CODE.has(dirName) || extraIgnoreDirs.includes(dirName);
}

function isCodeFile(filePath) {
  return CODE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function scanRepository(repoPath, options = {}) {
  const results = [];
  const extraIgnoreDirs = options.ignoreDirs || [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipDir(entry.name, extraIgnoreDirs)) {
          walk(fullPath);
        }
      } else if (entry.isFile() && isCodeFile(fullPath)) {
        results.push(fullPath);
      }
    }
  }

  walk(repoPath);
  return results;
}

module.exports = { isCodeFile, scanRepository, shouldSkipDir };
