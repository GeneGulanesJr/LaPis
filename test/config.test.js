const fs = require('fs');
const path = require('path');
const {
  stripJsoncComments,
  expandTilde,
  deepMerge,
  loadConfig,
  resetConfigCache,
  DEFAULTS,
  _CONFIG_PATH,
} = require('../config');

describe('config.js', () => {
  const ORIGINAL_READ = fs.readFileSync,
    ORIGINAL_EXISTS = fs.existsSync;

  afterEach(() => {
    fs.readFileSync = ORIGINAL_READ;
    fs.existsSync = ORIGINAL_EXISTS;
    resetConfigCache();
  });

  describe('stripJsoncComments', () => {
    it('removes single-line comments', () => {
      const input = '{\n  // comment\n  "key": "value"\n}';
      expect(stripJsoncComments(input)).toBe('{\n  \n  "key": "value"\n}');
    });

    it('removes multi-line comments', () => {
      const input = '{/* block */\n  "key": "value"\n}';
      expect(stripJsoncComments(input)).toBe('{\n  "key": "value"\n}');
    });

    it('preserves // inside string values', () => {
      const input = '{"url": "https://example.com/path", "key": "value"}',
        result = stripJsoncComments(input);
      expect(() => JSON.parse(result)).not.toThrow();
      expect(JSON.parse(result).url).toBe('https://example.com/path');
    });

    it('preserves /* inside string values', () => {
      const input = '{"regex": "/** find *\\/ me */", "key": "value"}',
        result = stripJsoncComments(input);
      expect(() => JSON.parse(result)).not.toThrow();
      expect(JSON.parse(result).regex).toBe('/** find */ me */');
    });

    it('handles escaped quotes in strings before //', () => {
      const input = '{"msg": "say \\"hello\\"", // comment\n"other": true}',
        result = stripJsoncComments(input),
        parsed = JSON.parse(result);
      expect(parsed.msg).toBe('say "hello"');
      expect(parsed.other).toBe(true);
    });

    it('returns empty string for comment-only input', () => {
      expect(stripJsoncComments('// only comment\n/* block */')).toBe('\n');
    });

    it('handles empty string', () => {
      expect(stripJsoncComments('')).toBe('');
    });
  });

  describe('expandTilde', () => {
    it('expands ~/ to HOME', async () => {
      vi.resetModules();
      vi.stubEnv('LAPIS_HOME', '/tmp/lapis-tilde-test');
      try {
        const { expandTilde: expand } = await import('../config'),
          result = expand('~/foo/bar');
        expect(result).toBe(path.join('/tmp/lapis-tilde-test', 'foo', 'bar'));
      } finally {
        vi.unstubAllEnvs();
        vi.resetModules();
      }
    });

    it('expands bare ~ to HOME', async () => {
      vi.resetModules();
      vi.stubEnv('LAPIS_HOME', '/tmp/lapis-tilde-test');
      try {
        const { expandTilde: expand } = await import('../config'),
          result = expand('~');
        expect(result).toBe('/tmp/lapis-tilde-test');
      } finally {
        vi.unstubAllEnvs();
        vi.resetModules();
      }
    });

    it('leaves absolute paths unchanged', () => {
      const result = expandTilde('/usr/local/bin');
      expect(result).toBe('/usr/local/bin');
    });

    it('leaves relative paths unchanged', () => {
      const result = expandTilde('foo/bar');
      expect(result).toBe('foo/bar');
    });

    it('leaves non-strings unchanged', () => {
      expect(expandTilde(42)).toBe(42);
      expect(expandTilde(null)).toBe(null);
    });

    it('leaves paths with ~ in the middle unchanged', () => {
      const result = expandTilde('/path/~user/file');
      expect(result).toBe('/path/~user/file');
    });
  });

  describe('deepMerge', () => {
    it('merges shallow properties', () => {
      expect(deepMerge({ a: 1, b: 2 }, { b: 3, c: 4 })).toEqual({ a: 1, b: 3, c: 4 });
    });

    it('merges nested objects recursively', () => {
      const target = { a: { x: 1, y: 2 }, b: 3 },
        source = { a: { y: 10, z: 20 } };
      expect(deepMerge(target, source)).toEqual({ a: { x: 1, y: 10, z: 20 }, b: 3 });
    });

    it('replaces arrays with source arrays', () => {
      expect(deepMerge({ items: [1, 2] }, { items: [3, 4] })).toEqual({ items: [3, 4] });
    });

    it('replaces null values', () => {
      expect(deepMerge({ key: 'val' }, { key: null })).toEqual({ key: null });
    });

    it('does not mutate target', () => {
      const target = { a: { x: 1 } };
      deepMerge(target, { a: { y: 2 } });
      expect(target.a).toEqual({ x: 1 });
    });

    it('returns new object', () => {
      const target = {},
        result = deepMerge(target, { a: 1 });
      expect(result).not.toBe(target);
    });
  });

  describe('loadConfig', () => {
    it('returns defaults when config file does not exist', () => {
      fs.readFileSync = () => {
        const e = new Error('ENOENT');
        e.code = 'ENOENT';
        throw e;
      };
      const cfg = loadConfig();
      expect(cfg).toEqual(DEFAULTS);
    });

    it('merges user config over defaults', () => {
      fs.readFileSync = () => '{"db_path": "/tmp/test.db", "busy_timeout_ms": 9999}';
      const cfg = loadConfig();
      expect(cfg.db_path).toBe('/tmp/test.db');
      expect(cfg.busy_timeout_ms).toBe(9999);
      expect(cfg.ranking).toEqual(DEFAULTS.ranking);
      expect(cfg.compact_every_n_sessions).toBe(DEFAULTS.compact_every_n_sessions);
    });

    it('strips JSONC comments before parsing', () => {
      fs.readFileSync = () => '{// comment\n"db_path": "/tmp/cleaned.db"\n}';
      const cfg = loadConfig();
      expect(cfg.db_path).toBe('/tmp/cleaned.db');
    });

    it('expands tilde in db_path and tier_config_path', async () => {
      // Config.js captures HOME from process.env at import time, so these
      // Tests must reload the module under a controlled LAPIS_HOME (hermetic
      // Against an ambient LAPIS_HOME export in the shell running the suite).
      vi.resetModules();
      vi.stubEnv('LAPIS_HOME', '/tmp/lapis-tilde-test');
      try {
        const { loadConfig: load, resetConfigCache: reset } = await import('../config');
        reset();
        fs.readFileSync = () => '{"db_path": "~/my/db.db", "tier_config_path": "~/my/tier.jsonc"}';
        const cfg = load();
        expect(cfg.db_path).toBe(path.join('/tmp/lapis-tilde-test', 'my', 'db.db'));
        expect(cfg.tier_config_path).toBe(path.join('/tmp/lapis-tilde-test', 'my', 'tier.jsonc'));
      } finally {
        vi.unstubAllEnvs();
        vi.resetModules();
      }
    });

    it('returns defaults on invalid JSON (with console.error)', () => {
      fs.readFileSync = () => '{invalid json!!!}';
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {}),
        cfg = loadConfig();
      expect(cfg).toEqual(DEFAULTS);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('Invalid JSON'));
      spy.mockRestore();
    });

    it('returns defaults on non-ENOENT read errors (with console.error)', () => {
      const err = new Error('permission denied');
      err.code = 'EACCES';
      fs.readFileSync = () => {
        throw err;
      };
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {}),
        cfg = loadConfig();
      expect(cfg).toEqual(DEFAULTS);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('Error reading'));
      spy.mockRestore();
    });

    it('silently returns defaults for ENOENT without console.error', () => {
      const err = new Error('not found');
      err.code = 'ENOENT';
      fs.readFileSync = () => {
        throw err;
      };
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {}),
        cfg = loadConfig();
      expect(cfg).toEqual(DEFAULTS);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('merges nested ranking config', () => {
      fs.readFileSync = () => '{"ranking": {"fts_relevance": 0.9}}';
      const cfg = loadConfig();
      expect(cfg.ranking.fts_relevance).toBe(0.9);
      expect(cfg.ranking.recency).toBe(DEFAULTS.ranking.recency);
      expect(cfg.ranking.trust).toBe(DEFAULTS.ranking.trust);
      expect(cfg.ranking.recall).toBe(DEFAULTS.ranking.recall);
    });
  });

  describe('LAPIS_HOME env override', () => {
    const CONFIG_REAL = require.resolve('../config'),
      ORIGINAL_LAPIS = process.env.LAPIS_HOME,
      ORIGINAL_HOME = process.env.HOME;

    afterEach(() => {
      if (ORIGINAL_LAPIS === undefined) {
        delete process.env.LAPIS_HOME;
      } else {
        process.env.LAPIS_HOME = ORIGINAL_LAPIS;
      }
      if (ORIGINAL_HOME === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = ORIGINAL_HOME;
      }
      delete require.cache[CONFIG_REAL];
      resetConfigCache();
    });

    it('resolves the memory dir from LAPIS_HOME before HOME (db_path follows)', () => {
      process.env.LAPIS_HOME = '/opt/lapis-home';
      process.env.HOME = '/tmp/other-home';
      delete require.cache[CONFIG_REAL];
      const fresh = require('../config');
      expect(fresh.DEFAULTS.db_path).toBe(path.join('/opt/lapis-home', '.pi', 'memory', 'memory.db'));
      expect(fresh.DEFAULTS.tier_config_path).toBe(path.join('/opt/lapis-home', '.pi', 'memory', 'tier.jsonc'));
    });

    it('falls back to HOME when LAPIS_HOME is unset', () => {
      delete process.env.LAPIS_HOME;
      process.env.HOME = '/tmp/plain-home';
      delete require.cache[CONFIG_REAL];
      const fresh = require('../config');
      expect(fresh.DEFAULTS.db_path).toBe(path.join('/tmp/plain-home', '.pi', 'memory', 'memory.db'));
    });
  });
});
