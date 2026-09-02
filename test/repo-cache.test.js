import { invalidateRepoCache, isRepoStale } from '../extensions/memory-layer/host/project-detector.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { state } from '../extensions/memory-layer/state.ts';

describe('repo-cache', () => {
  describe('isRepoStale', () => {
    it('should return false for recently indexed repo', () => {
      const repo = {
        name: 'test',
        path: '/nonexistent/path/that/will/not/stat',
        indexed_at: new Date().toISOString(),
        file_count: 10,
        symbol_count: 50,
      };
      expect(isRepoStale(repo)).toBe(false);
    });

    it('should return false when path does not exist', () => {
      const repo = {
        name: 'test',
        path: '/nonexistent/path',
        indexed_at: new Date().toISOString(),
        file_count: 0,
        symbol_count: 0,
      };
      expect(isRepoStale(repo)).toBe(false);
    });

    it('should return true when source files were modified after indexing', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-stale-'));
      try {
        const srcFile = path.join(tmpDir, 'index.js');
        fs.writeFileSync(srcFile, 'console.log("hello")');

        // Indexed 2 hours ago
        const indexedAt = new Date(Date.now() - 7200000).toISOString(),
          repo = {
            name: 'test-stale',
            path: tmpDir,
            indexed_at: indexedAt,
            file_count: 1,
            symbol_count: 1,
          };

        // File was just modified (newer than indexed_at + 1hr threshold)
        expect(isRepoStale(repo)).toBe(true);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should return false when source files are older than indexing', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-fresh-'));
      try {
        const srcFile = path.join(tmpDir, 'index.js');
        fs.writeFileSync(srcFile, 'console.log("hello")');

        // Indexed just now
        const indexedAt = new Date().toISOString(),
          repo = {
            name: 'test-fresh',
            path: tmpDir,
            indexed_at: indexedAt,
            file_count: 1,
            symbol_count: 1,
          };

        expect(isRepoStale(repo)).toBe(false);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('invalidateRepoCache', () => {
    it('should clear cached repos and reset cache time', () => {
      state.cachedRepos = [{ name: 'test', path: '/test', indexed_at: '2025-01-01', file_count: 1, symbol_count: 1 }];
      state.repoCacheTime = Date.now();

      invalidateRepoCache();

      expect(state.cachedRepos).toBeNull();
      expect(state.repoCacheTime).toBe(0);
    });
  });
});
