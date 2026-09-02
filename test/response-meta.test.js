// Tests for response-meta.js — metadata envelope, confidence, freshness
const responseMeta = require('../src/platform/protocol/envelope');

describe('response-meta.js', () => {
  beforeEach(() => {
    responseMeta.clearFreshnessCache();
  });

  describe('checkFreshness', () => {
    it('should return fresh for current git repo with matching head', () => {
      // The PiMemoryExtension repo itself should be a valid git repo
      const repoPath = require('path').resolve(__dirname, '..');
      const { execSync } = require('child_process');
      let head;
      try {
        head = execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf-8', timeout: 5000 }).trim();
      } catch {
        return; /* Skip if not in git repo */
      }

      const result = responseMeta.checkFreshness(repoPath, head);
      expect(['fresh', 'edited_uncommitted']).toContain(result);
    });

    it('should detect stale_index when head_commit differs', () => {
      const repoPath = require('path').resolve(__dirname, '..');
      // Only test if this is a git repo
      const fs = require('fs');
      if (!fs.existsSync(require('path').join(repoPath, '.git'))) {
        return;
      }

      const result = responseMeta.checkFreshness(repoPath, '0000000000000000000000000000000000000000');
      expect(result).toBe('stale_index');
    });

    it('should handle non-git repos gracefully', () => {
      const result = responseMeta.checkFreshness('/tmp/nonexistent-repo-for-test', null);
      expect(result).toBe('fresh');
    });

    it('should return stale_index for null head_commit', () => {
      const repoPath = require('path').resolve(__dirname, '..');
      const fs = require('fs');
      if (!fs.existsSync(require('path').join(repoPath, '.git'))) {
        return;
      }

      const result = responseMeta.checkFreshness(repoPath, null);
      expect(result).toBe('stale_index');
    });
  });

  describe('getFreshness (cached)', () => {
    it('should cache results for 60 seconds', () => {
      const repoPath = require('path').resolve(__dirname, '..');
      const fs = require('fs');
      if (!fs.existsSync(require('path').join(repoPath, '.git'))) {
        return;
      }

      const result1 = responseMeta.getFreshness(null, 1, repoPath, null),
        result2 = responseMeta.getFreshness(null, 1, repoPath, null);
      // Should return the same cached value
      expect(result1).toBe(result2);
    });

    it('should use different cache keys for different repos', () => {
      const result1 = responseMeta.getFreshness(null, 100, '/tmp/repo1', null),
        result2 = responseMeta.getFreshness(null, 200, '/tmp/repo2', null);
      // Different repos — both should return 'fresh' for non-git dirs
      expect(result1).toBe('fresh');
      expect(result2).toBe('fresh');
    });
  });

  describe('computeConfidence', () => {
    it('should return 1.0 for deterministic tools', () => {
      expect(responseMeta.computeConfidence('getCouplingMetrics')).toBe(1.0);
      expect(responseMeta.computeConfidence('getComplexity')).toBe(1.0);
      expect(responseMeta.computeConfidence('getLayerViolations')).toBe(1.0);
      expect(responseMeta.computeConfidence('getFileOutline')).toBe(1.0);
      expect(responseMeta.computeConfidence('getDependencyCycles')).toBe(1.0);
    });

    it('should compute confidence for getSymbolImportance', () => {
      const data = { nodes: [{ pagerank: 0.05 }, { pagerank: 0.03 }, { pagerank: 0.02 }] },
        conf = responseMeta.computeConfidence('getSymbolImportance', data);
      // Gap is 0.02, normalized: 0.5 + 0.02 * 20 = 0.9
      expect(conf).toBeCloseTo(0.9, 1);
    });

    it('should return 1.0 for single-symbol importance', () => {
      expect(responseMeta.computeConfidence('getSymbolImportance', { nodes: [{ pagerank: 0.1 }] })).toBe(1.0);
    });

    it('should return 0.0 for empty importance', () => {
      expect(responseMeta.computeConfidence('getSymbolImportance', { nodes: [] })).toBe(0.0);
    });

    it('should compute confidence for getDeadCode', () => {
      const data = { symbols: [{ confidence: 0.9 }, { confidence: 0.7 }, { confidence: 0.5 }] },
        conf = responseMeta.computeConfidence('getDeadCode', data);
      expect(conf).toBeCloseTo(0.7, 1);
    });

    it('should compute confidence for getHotspots', () => {
      const data = { files: [{ commits: 5 }, { commits: 0 }, { commits: 3 }] },
        conf = responseMeta.computeConfidence('getHotspots', data);
      // 2 of 3 have churn → 0.67
      expect(conf).toBeCloseTo(0.67, 1);
    });

    it('should return 0.5 for unknown tools', () => {
      expect(responseMeta.computeConfidence('unknownTool', {})).toBe(0.5);
    });
  });

  describe('extractResultCount', () => {
    it('should count nodes for getSymbolImportance', () => {
      expect(responseMeta.extractResultCount('getSymbolImportance', { nodes: [{}, {}, {}] })).toBe(3);
    });

    it('should count files for getHotspots', () => {
      expect(responseMeta.extractResultCount('getHotspots', { files: [{}, {}] })).toBe(2);
    });

    it('should count edges for getBlastRadius', () => {
      expect(responseMeta.extractResultCount('getBlastRadius', { edges: [{}, {}, {}] })).toBe(3);
    });

    it('should return 0 for null data', () => {
      expect(responseMeta.extractResultCount('any', null)).toBe(0);
    });
  });

  describe('buildEnvelope', () => {
    it('should wrap data in _meta envelope', () => {
      const repoPath = require('path').resolve(__dirname, '..'),
        result = responseMeta.buildEnvelope({
          toolName: 'getFileOutline',
          data: { classes: [{ name: 'MyClass', methods: [] }], standalone: [{ name: 'testFn' }] },
          db: null,
          repoId: 1,
          repoPath,
          storedHeadCommit: 'abc123',
          startTime: 1000,
        });

      expect(result._meta).toBeDefined();
      expect(result._meta.schema_version).toBe(1);
      expect(result._meta.freshness).toBeDefined();
      expect(result._meta.generated_at).toBeDefined();
      expect(result._meta.result_count).toBe(2);
      expect(result._meta.confidence).toBe(1.0);
      expect(result.data).toEqual({ classes: [{ name: 'MyClass', methods: [] }], standalone: [{ name: 'testFn' }] });
    });
  });
});
