import { isRepoStale } from '../extensions/memory-layer/host/project-detector.ts';

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
  });
});
