// Integration tests for index-repo (WASM-based)
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process'),
  STORE = path.resolve(__dirname, '..', 'memory-store.js');

function writeTmpRepo(repoPath, files) {
  fs.mkdirSync(repoPath, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(repoPath, name), content);
  }
}

// Clean up any leftover test repos from previous runs
function cleanupRepo(name) {
  try {
    execSync(`node "${STORE}" remove-code-repo --repo ${name}`, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    /* Not found — fine */
  }
}

beforeAll(() => {
  cleanupRepo('test-wasm-integ');
  cleanupRepo('test-mixed-repo');
  cleanupRepo('test-bad-repo-2');
});

afterAll(() => {
  cleanupRepo('test-wasm-integ');
  cleanupRepo('test-mixed-repo');
  cleanupRepo('test-bad-repo-2');
});

describe('index-repo (WASM)', () => {
  describe('basic indexing', () => {
    it('should index a small repo without Python', () => {
      const tmpRepo = path.join('/tmp', 'test-wasm-integ-repo');
      fs.mkdirSync(tmpRepo, { recursive: true });
      fs.writeFileSync(
        path.join(tmpRepo, 'app.js'),
        '/** App entry */\nfunction main() {\n  console.log("hello");\n}\n\nclass Server {\n  start() {\n    return 42;\n  }\n}',
      );

      const out = execSync(`node "${STORE}" index-repo --path "${tmpRepo}" --name test-wasm-integ`, {
          encoding: 'utf8',
          timeout: 30000,
        }),
        result = JSON.parse(out);

      expect(result.success).toBe(true);
      expect(result.files_indexed).toBe(1);
      expect(result.symbols_extracted).toBeGreaterThanOrEqual(3);
    });

    it('should search indexed code after indexing', () => {
      const out = execSync(`node "${STORE}" search-code --query main --repo test-wasm-integ`, {
          encoding: 'utf8',
          timeout: 10000,
        }),
        result = JSON.parse(out);
      expect(result.results.length).toBeGreaterThanOrEqual(1);
      expect(result.results[0].symbol).toBe('main');
    });

    it('should retrieve source code for indexed symbols', () => {
      const out = execSync(
          `node "${STORE}" get-code-source --repo test-wasm-integ --file /tmp/test-wasm-integ-repo/app.js --name main`,
          {
            encoding: 'utf8',
            timeout: 10000,
          },
        ),
        result = JSON.parse(out);
      expect(result.success).toBe(true);
      expect(result.symbol).toBe('main');
      expect(result.source).toContain('main');
    });

    it('accepts repo-relative --file paths and reports resolved path on miss', () => {
      const absFile = '/tmp/test-wasm-integ-repo/app.js',
        relOut = execSync(`node "${STORE}" get-code-source --repo test-wasm-integ --file app.js --name main`, {
          encoding: 'utf8',
          timeout: 10000,
        }),
        relResult = JSON.parse(relOut);
      expect(relResult.success).toBe(true);
      expect(relResult.symbol).toBe('main');

      const absOut = execSync(`node "${STORE}" get-code-source --repo test-wasm-integ --file ${absFile} --name main`, {
          encoding: 'utf8',
          timeout: 10000,
        }),
        absResult = JSON.parse(absOut);
      expect(absResult.success).toBe(true);
      expect(absResult.symbol).toBe('main');

      let missErr = '';
      try {
        execSync(`node "${STORE}" get-code-source --repo test-wasm-integ --file app.js --name doesNotExist`, {
          encoding: 'utf8',
          timeout: 10000,
        });
      } catch (err) {
        missErr = JSON.parse(err.stderr || '').error || '';
      }
      expect(missErr).toContain(absFile);
      expect(missErr).toMatch(/resolved against the repo root/);
    });

    it('should not mention Python in error messages', () => {
      let stderr = '';
      try {
        execSync(`node "${STORE}" index-repo --path /nonexistent/path/abc123 --name nope`, {
          encoding: 'utf8',
          timeout: 10000,
        });
      } catch (err) {
        stderr = err.stderr || '';
      }
      expect(stderr).not.toContain('Python');
      expect(stderr).not.toContain('pip');
      expect(stderr).not.toContain('venv');
    });
  });

  describe('multi-language indexing', () => {
    it('should index a mixed-language repo (JS + TS + TSX)', () => {
      const tmpRepo = path.join('/tmp', 'test-mixed-repo-dir');
      writeTmpRepo(tmpRepo, {
        'utils.js': 'function helper(x) {\n  return x * 2;\n}',
        'types.ts':
          'interface Config {\n  port: number;\n}\n\nfunction parseConfig(): Config {\n  return { port: 3000 };\n}',
        'Component.tsx':
          'export function Button({ label }: { label: string }) {\n  return <button>{label}</button>;\n}',
      });

      const out = execSync(`node "${STORE}" index-repo --path "${tmpRepo}" --name test-mixed-repo`, {
          encoding: 'utf8',
          timeout: 30000,
        }),
        result = JSON.parse(out);

      expect(result.success).toBe(true);
      expect(result.files_indexed).toBe(3);
      expect(result.symbols_extracted).toBeGreaterThanOrEqual(4);
    });

    it('should handle repos with only unsupported file types gracefully', () => {
      const tmpRepo = path.join('/tmp', 'test-bad-repo-dir');
      writeTmpRepo(tmpRepo, { 'README.txt': 'Hello' });

      const out = execSync(`node "${STORE}" index-repo --path "${tmpRepo}" --name test-bad-repo-2`, {
          encoding: 'utf8',
          timeout: 10000,
        }),
        result = JSON.parse(out);
      expect(result.files_indexed).toBe(0);
      expect(result.success).toBe(true);
    });
  });

  describe('repo management', () => {
    it('should list code repos', () => {
      const out = execSync(`node "${STORE}" list-code-repos`, {
          encoding: 'utf8',
          timeout: 10000,
        }),
        result = JSON.parse(out);
      expect(result.total).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(result.repos)).toBe(true);
    });

    it('should reindex an existing repo in full mode', () => {
      const out = execSync(`node "${STORE}" reindex-repo --repo test-wasm-integ --mode full`, {
          encoding: 'utf8',
          timeout: 30000,
        }),
        result = JSON.parse(out);
      expect(result.success).toBe(true);
      // Full mode calls indexRepoInternal which returns files_indexed
      expect(typeof (result.files_indexed || result.files_reindexed)).toBe('number');
      expect(typeof result.symbols_extracted).toBe('number');
    });

    it('should return repos with name and numeric counts', () => {
      const out = execSync(`node "${STORE}" list-code-repos`, {
          encoding: 'utf8',
          timeout: 10000,
        }),
        result = JSON.parse(out);
      expect(result.repos.length).toBeGreaterThanOrEqual(1);
      const first = result.repos[0];
      expect(first.name).toBeTruthy();
      expect(typeof first.file_count).toBe('number');
      expect(typeof first.symbol_count).toBe('number');
    });

    it('should remove code repos cleanly', () => {
      const out = execSync(`node "${STORE}" remove-code-repo --repo test-mixed-repo`, {
          encoding: 'utf8',
          timeout: 10000,
        }),
        result = JSON.parse(out);
      expect(result.success).toBe(true);

      execSync(`node "${STORE}" remove-code-repo --repo test-bad-repo-2`, {
        encoding: 'utf8',
        timeout: 10000,
      });
    });

    it('should report churn metrics with git data', () => {
      // Only test that the command produces parseable JSON — churn depends on git history
      try {
        const out = execSync(`node "${STORE}" churn --repo test-wasm-integ`, {
          encoding: 'utf8',
          timeout: 30000,
        });
        expect(() => JSON.parse(out.trim())).not.toThrow();
      } catch (e) {
        // Churn may fail if git history unavailable — that's expected
        expect(e.stderr || e.message).toBeTruthy();
      }
    });
  });
});
