const utils = require('../utils');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('utils.js', () => {
  describe('requireNativeDb', () => {
    it('should return error object when db is null', () => {
      const result = utils.requireNativeDb(null, 'feature-x');
      expect(result).toEqual({ error: expect.stringContaining('native SQLite') });
      expect(result.error).toContain('feature-x');
    });

    it('should return error object when db lacks prepare method', () => {
      const result = utils.requireNativeDb({}, 'test-op');
      expect(result).toEqual({ error: expect.stringContaining('test-op') });
    });

    it('should return null for valid db handle', () => {
      const db = { prepare: vi.fn() },
        result = utils.requireNativeDb(db, 'feature-x');
      expect(result).toBeNull();
    });
  });

  describe('withDb', () => {
    it('should return error when db is null', () => {
      const fn = vi.fn(),
        guarded = utils.withDb(fn, 'my-feature'),
        result = guarded(null, 'arg1');
      expect(result).toEqual({ error: expect.stringContaining('my-feature') });
      expect(fn).not.toHaveBeenCalled();
    });

    it('should call the wrapped function with valid db', () => {
      const fn = vi.fn(() => 'result'),
        guarded = utils.withDb(fn, 'my-feature'),
        db = { prepare: vi.fn() },
        result = guarded(db, 'arg1', 'arg2');
      expect(result).toBe('result');
      expect(fn).toHaveBeenCalledWith(db, 'arg1', 'arg2');
    });
  });

  describe('hashContent', () => {
    it('should return a 16-character hex string', () => {
      const hash = utils.hashContent('hello world');
      expect(hash).toMatch(/^[a-f0-9]{16}$/);
    });

    it('should produce consistent hashes for identical content', () => {
      const hash1 = utils.hashContent('test content'),
        hash2 = utils.hashContent('test content');
      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different content', () => {
      const hash1 = utils.hashContent('content A'),
        hash2 = utils.hashContent('content B');
      expect(hash1).not.toBe(hash2);
    });

    it('should handle empty string', () => {
      const hash = utils.hashContent('');
      expect(hash).toMatch(/^[a-f0-9]{16}$/);
    });
  });

  describe('estimateTokens', () => {
    it('should estimate tokens for a string', () => {
      const tokens = utils.estimateTokens('hello world test');
      expect(tokens).toBeGreaterThan(0);
      expect(tokens).toBe(Math.ceil('hello world test'.length / 3.5));
    });

    it('should estimate tokens for an object (serializes to JSON)', () => {
      const tokens = utils.estimateTokens({ key: 'value' });
      expect(tokens).toBeGreaterThan(0);
    });

    it('should use 3.5 chars per token ratio', () => {
      const str = 'a'.repeat(35);
      expect(utils.estimateTokens(str)).toBe(10);
    });
  });

  describe('walkDirForCode', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = path.join(os.tmpdir(), `walk-code-test-${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'node_modules', 'pkg'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'src', 'index.js'), 'console.log("hi")');
      fs.writeFileSync(path.join(tmpDir, 'src', 'app.ts'), 'export {}');
      fs.writeFileSync(path.join(tmpDir, 'src', 'style.css'), '.x{}');
      fs.writeFileSync(path.join(tmpDir, 'node_modules', 'pkg', 'index.js'), '// vendor');
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should find code files in src but skip node_modules', () => {
      const files = utils.walkDirForCode(tmpDir);
      expect(files.length).toBe(3);
      const basenames = files.map((f) => path.basename(f)).sort();
      expect(basenames).toEqual(['app.ts', 'index.js', 'style.css']);
    });

    it('should skip hidden directories', () => {
      fs.mkdirSync(path.join(tmpDir, '.hidden'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.hidden', 'secret.js'), '// hidden');
      const files = utils.walkDirForCode(tmpDir);
      expect(files.every((f) => !f.includes('.hidden'))).toBe(true);
    });

    it('should find .py, .go, .rs files', () => {
      const pyDir = path.join(tmpDir, 'scripts');
      fs.mkdirSync(pyDir, { recursive: true });
      fs.writeFileSync(path.join(pyDir, 'run.py'), 'print("hi")');
      fs.writeFileSync(path.join(pyDir, 'main.go'), 'package main');
      fs.writeFileSync(path.join(pyDir, 'lib.rs'), 'fn main(){}');
      const files = utils.walkDirForCode(tmpDir);
      expect(files.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('walkDirForDocs', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = path.join(os.tmpdir(), `walk-docs-test-${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'docs', 'guide.md'), '# Guide');
      fs.writeFileSync(path.join(tmpDir, 'docs', 'api.mdx'), '# API');
      fs.writeFileSync(path.join(tmpDir, 'docs', 'data.json'), '{}');
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should find .md and .mdx files', () => {
      const files = utils.walkDirForDocs(tmpDir);
      expect(files.length).toBe(2);
    });

    it('should respect ignore glob', () => {
      const files = utils.walkDirForDocs(tmpDir, 'docs/guide*'),
        basenames = files.map((f) => path.basename(f));
      expect(basenames).not.toContain('guide.md');
    });
  });

  describe('SKIP_CALLEE_NAMES', () => {
    it('should contain common JS keywords', () => {
      expect(utils.SKIP_CALLEE_NAMES.has('if')).toBe(true);
      expect(utils.SKIP_CALLEE_NAMES.has('return')).toBe(true);
      expect(utils.SKIP_CALLEE_NAMES.has('class')).toBe(true);
      expect(utils.SKIP_CALLEE_NAMES.has('function')).toBe(true);
    });

    it('should be a Set', () => {
      expect(utils.SKIP_CALLEE_NAMES).toBeInstanceOf(Set);
    });
  });

  describe('CODE_EXTENSIONS', () => {
    it('should include common code extensions', () => {
      expect(utils.CODE_EXTENSIONS.has('.js')).toBe(true);
      expect(utils.CODE_EXTENSIONS.has('.jsx')).toBe(true);
      expect(utils.CODE_EXTENSIONS.has('.ts')).toBe(true);
      expect(utils.CODE_EXTENSIONS.has('.py')).toBe(true);
      expect(utils.CODE_EXTENSIONS.has('.go')).toBe(true);
      expect(utils.CODE_EXTENSIONS.has('.rs')).toBe(true);
    });
  });

  describe('MD_EXTENSIONS', () => {
    it('should include .md and .mdx', () => {
      expect(utils.MD_EXTENSIONS.has('.md')).toBe(true);
      expect(utils.MD_EXTENSIONS.has('.mdx')).toBe(true);
    });
  });

  describe('IGNORE_DIRS_*', () => {
    it('should include node_modules in common set', () => {
      expect(utils.IGNORE_DIRS_COMMON.has('node_modules')).toBe(true);
      expect(utils.IGNORE_DIRS_COMMON.has('.git')).toBe(true);
    });

    it('CODE should extend COMMON', () => {
      for (const dir of utils.IGNORE_DIRS_COMMON) {
        expect(utils.IGNORE_DIRS_CODE.has(dir)).toBe(true);
      }
    });

    it('DOCS should extend COMMON', () => {
      for (const dir of utils.IGNORE_DIRS_COMMON) {
        expect(utils.IGNORE_DIRS_DOCS.has(dir)).toBe(true);
      }
      expect(utils.IGNORE_DIRS_DOCS.has('.cache')).toBe(true);
    });
  });
});
