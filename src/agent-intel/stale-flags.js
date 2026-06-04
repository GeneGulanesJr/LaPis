// Module boundary:
// Scans source code for stale feature flags (one-sided branches).
// A one-sided branch is an if/ternary where one side is always executed.

const fs = require('fs');
const path = require('path');

// Patterns that indicate stale flags:
// 1. if (true) / if (false)
// 2. if (process.env.NODE_ENV === 'development') inside non-dev code
// 3. Feature flags checked but never toggled
// 4. Constant conditions in if statements

const STALE_FLAG_PATTERNS = [
  /\bif\s*\(\s*true\s*\)/gi,
  /\bif\s*\(\s*false\s*\)/gi,
  /FEATURE_[A-Z_]+\s*===\s*['"](?:enabled?|on|true)['"]/gi,
  /FEATURE_[A-Z_]+\s*!==\s*['"](?:disabled?|off|false)['"]/gi,
];

// Pattern to detect one-sided branches where if block is empty or just a comment,
// meaning the else block always runs
const ONE_SIDED_IF_PATTERNS = [
  // if (!x) { /* empty or only comments */ } else { ... }
  /\bif\s*\(\s*![^)]+\)\s*\{\s*\/(?:\/|\*)[^\}]*\}\s*else/g,
  // if (constant_expression) { never_runs(); } else { always_runs(); }
  // Detect when if body clearly never executes (throw, return, etc.)
  /\bif\s*\(\s*(?:true|false|1\s*==\s*1|0\s*==\s*1)\s*\)\s*\{(?:\s| |\n)*(?:return|throw|break|continue)[^}]*\}\s*else/g,
];

const ALWAYS_TRUE_CONTEXT = [
  'process.env.NODE_ENV',
  'process.env.DEBUG',
  'process.env.TESTING',
];

function scanFileForStaleFlags(filePath) {
  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const findings = [];

  // Pattern-based detection for constant conditions
  for (const pattern of STALE_FLAG_PATTERNS) {
    let match;
    const regex = new RegExp(pattern.source, pattern.flags);
    while ((match = regex.exec(content)) !== null) {
      const lineNum = content.substring(0, match.index).split('\n').length;
      const line = lines[lineNum - 1]?.trim() || '';

      findings.push({
        filePath,
        lineNumber: lineNum,
        type: 'constant_condition',
        context: line.substring(0, 100),
      });
    }
  }

  // Detect one-sided branches using dedicated patterns
  for (const pattern of ONE_SIDED_IF_PATTERNS) {
    let match;
    const regex = new RegExp(pattern.source, pattern.flags || 'g');
    while ((match = regex.exec(content)) !== null) {
      const lineNum = content.substring(0, match.index).split('\n').length;
      const line = lines[lineNum - 1]?.trim() || '';

      findings.push({
        filePath,
        lineNumber: lineNum,
        type: 'one_sided_branch',
        context: line.substring(0, 100),
      });
    }
  }

  // Check for one-sided ternaries: condition ? expr : expr (where expr is same)
  const ternaryRegex = /(\w+)\s*\?\s*(\w+)\s*:\s*\w+/g;
  let match;
  while ((match = ternaryRegex.exec(content)) !== null) {
    const [, condition] = match;
    // Check if the condition looks like a flag constant
    if (ALWAYS_TRUE_CONTEXT.some(c => condition.includes(c))) {
      const lineNum = content.substring(0, match.index).split('\n').length;
      const line = lines[lineNum - 1]?.trim() || '';

      findings.push({
        filePath,
        lineNumber: lineNum,
        type: 'likely_stale_flag',
        context: line.substring(0, 100),
      });
    }
  }

  return findings;
}

function detectStaleFlagsInRepo(db, repoId, repoPath) {
  // Get all JS/TS files
  const files = db.prepare(`
    SELECT path FROM code_files
    WHERE repo_id = ? AND (path LIKE '%.js' OR path LIKE '%.ts')
  `).all(repoId);

  const allFindings = [];

  for (const { path: filePath } of files) {
    // Resolve relative to repo path (code_files.path may be absolute or relative to repo root)
    let fullPath;
    if (path.isAbsolute(filePath)) {
      fullPath = filePath;
    } else if (repoPath) {
      fullPath = path.join(repoPath, filePath);
    } else {
      fullPath = filePath;
    }

    const findings = scanFileForStaleFlags(fullPath);

    for (const f of findings) {
      // Determine branch_type based on finding type
      let branchType = 'always-true';
      if (f.type === 'constant_condition') {
        if (f.context.includes('false')) {
          branchType = 'always-false';
        }
      } else if (f.type === 'one_sided_branch') {
        branchType = 'one-sided';
      }

      allFindings.push({
        repo_id: repoId,
        file_path: f.filePath,
        line_number: f.lineNumber,
        flag_name: f.context.match(/FEATURE_\w+/)?.[0] || extractCondition(f.context),
        branch_type: branchType,
        context: f.context,
      });
    }
  }

  return allFindings;
}

function extractCondition(context) {
  const match = context.match(/if\s*\(\s*([^)]+)\s*\)/);
  return match ? match[1].trim() : context.substring(0, 50);
}

function persistStaleFlags(db, findings) {
  if (findings.length === 0) return { inserted: 0, errors: [] };

  // Check if table exists before inserting
  try {
    const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='stale_flags'").get();
    if (!tableCheck) return { inserted: 0, errors: ['stale_flags table does not exist'] };
  } catch (e) {
    return { inserted: 0, errors: [e.message] };
  }

  const insert = db.prepare(`
    INSERT INTO stale_flags (repo_id, file_path, line_number, flag_name, branch_type, context)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const errors = [];
  const tx = db.transaction((items) => {
    let count = 0;
    for (const f of items) {
      try {
        insert.run(f.repo_id, f.file_path, f.line_number, f.flag_name, f.branch_type, f.context);
        count++;
      } catch (e) {
        // Only skip duplicates, collect other errors
        if (!e.message.includes('UNIQUE constraint failed')) {
          errors.push(`Insert error for ${f.file_path}:${f.line_number}: ${e.message}`);
        }
      }
    }
    return count;
  });

  return { inserted: tx(findings), errors };
}

function getStaleFlags(db, repoId) {
  try {
    return db.prepare(`
      SELECT * FROM stale_flags WHERE repo_id = ? ORDER BY file_path, line_number
    `).all(repoId);
  } catch {
    return [];
  }
}

module.exports = {
  scanFileForStaleFlags,
  detectStaleFlagsInRepo,
  persistStaleFlags,
  getStaleFlags,
  STALE_FLAG_PATTERNS,
};
