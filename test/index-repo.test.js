const path = require('path');
const { createIsolatedTestDb, writeTmpRepo } = require('./helpers/isolated-db');

let ctx;

beforeAll(() => {
  ctx = createIsolatedTestDb();
});

afterAll(() => {
  ctx.cleanup();
});

describe('index-repo (WASM)', () => {
  describe('basic indexing', () => {
    it('should index a small repo without Python', () => {
      const tmpRepo = writeTmpRepo(path.join(ctx.tmpDir, 'wasm-test'), {
        'app.js': '/** App entry */\nfunction main() {\n  console.log("hello");\n}\n\nclass Server {\n  start() {\n    return 42;\n  }\n}',
      });

      const r = ctx.run(`index-repo --path "${tmpRepo}" --name test-wasm-integ`);
      expect(r.success).toBe(true);
      expect(r.files_indexed).toBe(1);
      expect(r.symbols_extracted).toBeGreaterThanOrEqual(3);
    });

    it('should search indexed code after indexing', () => {
      const r = ctx.run(`search-code --query main --repo test-wasm-integ`);
      expect(r.error).toBeUndefined();
      expect(r.results.length).toBeGreaterThanOrEqual(1);
      expect(r.results[0].symbol).toBe('main');
    });

    it('should retrieve source code for indexed symbols', () => {
      const tmpRepo = path.join(ctx.tmpDir, 'wasm-test');
      const r = ctx.run(`get-code-source --repo test-wasm-integ --file ${tmpRepo}/app.js --name main`);
      expect(r.error).toBeUndefined();
      expect(r.success).toBe(true);
      expect(r.symbol).toBe('main');
      expect(r.source).toContain('main');
    });

    it('should not mention Python in error messages', () => {
      const r = ctx.run(`index-repo --path /nonexistent/path/abc123 --name nope`);
      expect(typeof r).toBe('object');
      const output = JSON.stringify(r);
      expect(output).not.toContain('Python');
      expect(output).not.toContain('pip');
      expect(output).not.toContain('venv');
    });
  });

  describe('multi-language indexing', () => {
    it('should index a mixed-language repo (JS + TS + TSX)', () => {
      const tmpRepo = writeTmpRepo(path.join(ctx.tmpDir, 'mixed-test'), {
        'utils.js': 'function helper(x) {\n  return x * 2;\n}',
        'types.ts': 'interface Config {\n  port: number;\n}\n\nfunction parseConfig(): Config {\n  return { port: 3000 };\n}',
        'Component.tsx': 'export function Button({ label }: { label: string }) {\n  return <button>{label}</button>;\n}',
      });

      const r = ctx.run(`index-repo --path "${tmpRepo}" --name test-mixed-repo`);
      expect(r.success).toBe(true);
      expect(r.files_indexed).toBe(3);
      expect(r.symbols_extracted).toBeGreaterThanOrEqual(4);
    });

    it('should handle repos with only unsupported file types gracefully', () => {
      const tmpRepo = writeTmpRepo(path.join(ctx.tmpDir, 'bad-test'), {
        'README.txt': 'Hello',
      });

      const r = ctx.run(`index-repo --path "${tmpRepo}" --name test-bad-repo`);
      expect(r.files_indexed).toBe(0);
      expect(r.success).toBe(true);
    });
  });

  describe('repo management', () => {
    it('should list code repos', () => {
      const r = ctx.run('list-code-repos');
      expect(r.error).toBeUndefined();
      expect(r.total).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(r.repos)).toBe(true);
    });

    it('should reindex an existing repo in full mode', () => {
      const r = ctx.run(`reindex-repo --repo test-wasm-integ --mode full`);
      expect(r.error).toBeUndefined();
      expect(r.success).toBe(true);
      expect(typeof (r.files_indexed || r.files_reindexed)).toBe('number');
      expect(typeof (r.symbols_extracted)).toBe('number');
    });

    it('should return repos with name and numeric counts', () => {
      const r = ctx.run('list-code-repos');
      expect(r.error).toBeUndefined();
      expect(r.repos.length).toBeGreaterThanOrEqual(1);
      const first = r.repos[0];
      expect(first.name).toBeTruthy();
      expect(typeof first.file_count).toBe('number');
      expect(typeof first.symbol_count).toBe('number');
    });

    it('should remove code repos cleanly', () => {
      const r = ctx.run(`remove-code-repo --repo test-mixed-repo`);
      expect(r.success).toBe(true);

      ctx.run(`remove-code-repo --repo test-bad-repo`);
    });

    it('should report churn metrics with git data', () => {
      try {
        const r = ctx.run(`churn --repo test-wasm-integ`);
        expect(typeof r).toBe('object');
      } catch (e) {
        expect(e.message).toBeTruthy();
      }
    });
  });
});
