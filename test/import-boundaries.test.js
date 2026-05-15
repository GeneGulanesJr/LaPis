/**
 * Import Boundary Enforcement Tests
 *
 * GitHub Issue: #86
 * Enforces that modules in one domain do not import from forbidden domains.
 * Tests are static analysis — no runtime side effects.
 */
const path = require('path');
const fs = require('fs');

const SRC_ROOT = path.resolve(__dirname, '..', 'src');

/**
 * Each key is a src/ domain. Its value lists domains it must NOT import from.
 * These boundaries preserve feature isolation — a failure in one domain
 * should not cascade into another.
 */
const FORBIDDEN_IMPORTS = {
  'trust-sync': ['doc-index', 'code-analysis', 'code-index', 'workflow-memory'],
  'workflow-memory': ['doc-index', 'code-analysis', 'code-index', 'trust-sync'],
  'doc-index': ['trust-sync', 'workflow-memory', 'memory-domain'],
  'code-analysis': ['doc-index', 'memory-domain', 'workflow-memory'],
  'code-index': ['doc-index', 'trust-sync', 'workflow-memory'],
};

function collectJsFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectJsFiles(full));
    } else if (entry.name.endsWith('.js')) {
      results.push(full);
    }
  }
  return results;
}

function extractRequires(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const requires = [];
  const regex = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    requires.push(match[1]);
  }
  return requires;
}

describe('Import boundary enforcement', () => {
  const domainNames = Object.keys(FORBIDDEN_IMPORTS);

  for (const domain of domainNames) {
    describe(`src/${domain} boundaries`, () => {
      const domainDir = path.join(SRC_ROOT, domain);
      const files = collectJsFiles(domainDir);
      const forbiddenDeps = FORBIDDEN_IMPORTS[domain];

      if (files.length === 0) {
        it.skip(`no source files found in src/${domain}`);
        return;
      }

      for (const file of files) {
        const relativePath = path.relative(SRC_ROOT, file);
        it(`${relativePath} does not import forbidden domains: ${forbiddenDeps.join(', ')}`, () => {
          const requires = extractRequires(file);
          const violations = [];

          for (const req of requires) {
            // Resolve relative imports to check if they escape into forbidden domains
            if (req.startsWith('.')) {
              const resolved = path.normalize(path.join(path.dirname(file), req));
              for (const forbidden of forbiddenDeps) {
                const forbiddenPath = path.join('src', forbidden);
                if (
                  resolved.includes(forbiddenPath + path.sep) ||
                  resolved.endsWith(forbiddenPath)
                ) {
                  violations.push({ require: req, forbidden });
                }
              }
            } else {
              // Non-relative requires — check for direct domain references
              for (const forbidden of forbiddenDeps) {
                if (req.includes(`/${forbidden}/`) || req.endsWith(`/${forbidden}`)) {
                  violations.push({ require: req, forbidden });
                }
              }
            }
          }

          expect(violations).toEqual([]);
        });
      }
    });
  }
});
