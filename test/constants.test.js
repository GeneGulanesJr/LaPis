const constants = require('../constants');

describe('constants.js', () => {
  describe('TRUST_DELTA', () => {
    it('should have numeric values for all fields', () => {
      for (const [_key, val] of Object.entries(constants.TRUST_DELTA)) {
        expect(typeof val).toBe('number');
      }
    });

    it('should have SYMBOL_CHANGED as negative', () => {
      expect(constants.TRUST_DELTA.SYMBOL_CHANGED).toBeLessThan(0);
    });

    it('should have SURVIVED_UNCHANGED as positive', () => {
      expect(constants.TRUST_DELTA.SURVIVED_UNCHANGED).toBeGreaterThan(0);
    });

    it('should have TRUST_FLOOR as 0 and TRUST_CEILING as 1', () => {
      expect(constants.TRUST_DELTA.TRUST_FLOOR).toBe(0);
      expect(constants.TRUST_DELTA.TRUST_CEILING).toBe(1);
    });

    it('should have STEP_SUCCESS positive and STEP_FAILURE negative', () => {
      expect(constants.TRUST_DELTA.STEP_SUCCESS).toBeGreaterThan(0);
      expect(constants.TRUST_DELTA.STEP_FAILURE).toBeLessThan(0);
    });
  });

  describe('DEDUP', () => {
    it('should have AUTO_MERGE_THRESHOLD greater than WARNING_THRESHOLD', () => {
      expect(constants.DEDUP.AUTO_MERGE_THRESHOLD).toBeGreaterThan(constants.DEDUP.WARNING_THRESHOLD);
    });

    it('should have threshold values between 0 and 1', () => {
      expect(constants.DEDUP.AUTO_MERGE_THRESHOLD).toBeGreaterThan(0);
      expect(constants.DEDUP.AUTO_MERGE_THRESHOLD).toBeLessThanOrEqual(1);
      expect(constants.DEDUP.WARNING_THRESHOLD).toBeGreaterThan(0);
      expect(constants.DEDUP.WARNING_THRESHOLD).toBeLessThanOrEqual(1);
    });
  });

  describe('TIME_WINDOWS', () => {
    it('should have positive day values', () => {
      expect(constants.TIME_WINDOWS.ARCHIVE_INACTIVE_DAYS).toBeGreaterThan(0);
      expect(constants.TIME_WINDOWS.PURGE_SOFT_DELETED_DAYS).toBeGreaterThan(0);
      expect(constants.TIME_WINDOWS.DREAM_AUTO_DETECTED_MIN_AGE_DAYS).toBeGreaterThan(0);
      expect(constants.TIME_WINDOWS.CHURN_DEFAULT_WINDOW_DAYS).toBeGreaterThan(0);
    });

    it('should have RECENCY_HALF_LIFE_MS as milliseconds', () => {
      expect(constants.TIME_WINDOWS.RECENCY_HALF_LIFE_MS).toBeGreaterThan(0);
      const days = constants.TIME_WINDOWS.RECENCY_HALF_LIFE_MS / (1000 * 60 * 60 * 24);
      expect(days).toBeGreaterThanOrEqual(1);
    });
  });

  describe('RESULT_LIMITS', () => {
    it('should have positive integer values for all limits', () => {
      for (const [_key, val] of Object.entries(constants.RESULT_LIMITS)) {
        expect(Number.isInteger(val)).toBe(true);
        expect(val).toBeGreaterThan(0);
      }
    });

    it('should have DEFAULT_SEARCH_LIMIT of 10', () => {
      expect(constants.RESULT_LIMITS.DEFAULT_SEARCH_LIMIT).toBe(10);
    });

    it('should have SEARCH_MULTIPLIER >= 1', () => {
      expect(constants.RESULT_LIMITS.SEARCH_MULTIPLIER).toBeGreaterThanOrEqual(1);
    });
  });

  describe('RANKING', () => {
    it('should have DEFAULT_TRUST_SCORE between 0 and 1', () => {
      expect(constants.RANKING.DEFAULT_TRUST_SCORE).toBeGreaterThan(0);
      expect(constants.RANKING.DEFAULT_TRUST_SCORE).toBeLessThanOrEqual(1);
    });

    it('should have TYPE_PRIORITY with numeric values', () => {
      for (const [_key, val] of Object.entries(constants.RANKING.TYPE_PRIORITY)) {
        expect(typeof val).toBe('number');
      }
    });

    it('should have TYPE_BOOST with values >= 0', () => {
      for (const [_key, val] of Object.entries(constants.RANKING.TYPE_BOOST)) {
        expect(val).toBeGreaterThanOrEqual(0);
      }
    });

    it('should give decision and architecture highest priority', () => {
      const maxPriority = Math.max(...Object.values(constants.RANKING.TYPE_PRIORITY));
      expect(constants.RANKING.TYPE_PRIORITY.decision).toBe(maxPriority);
      expect(constants.RANKING.TYPE_PRIORITY.architecture).toBe(maxPriority);
    });
  });

  describe('CONTEXT', () => {
    it('should have RELEVANCE_WEIGHTS that sum to 1.0', () => {
      const weights = constants.CONTEXT.RELEVANCE_WEIGHTS,
        sum = Object.values(weights).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1.0, 2);
    });

    it('should have positive CROSS_PROJECT_DEEP_MULTIPLIER', () => {
      expect(constants.CONTEXT.CROSS_PROJECT_DEEP_MULTIPLIER).toBeGreaterThan(0);
    });

    it('should have positive TOPIC_MATCH_BOOST', () => {
      expect(constants.CONTEXT.TOPIC_MATCH_BOOST).toBeGreaterThan(0);
    });
  });

  describe('PAGERANK', () => {
    it('should have DAMPING_FACTOR between 0 and 1', () => {
      expect(constants.PAGERANK.DAMPING_FACTOR).toBeGreaterThan(0);
      expect(constants.PAGERANK.DAMPING_FACTOR).toBeLessThan(1);
    });

    it('should have positive ITERATIONS', () => {
      expect(constants.PAGERANK.ITERATIONS).toBeGreaterThan(0);
    });
  });

  describe('PR_RISK', () => {
    it('should have WEIGHTS that sum to 1.0', () => {
      const weights = constants.PR_RISK.WEIGHTS,
        sum = Object.values(weights).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1.0, 2);
    });

    it('should have RISK_LEVELS in ascending order', () => {
      expect(constants.PR_RISK.RISK_LEVELS.LOW).toBeLessThan(constants.PR_RISK.RISK_LEVELS.MEDIUM);
      expect(constants.PR_RISK.RISK_LEVELS.MEDIUM).toBeLessThan(constants.PR_RISK.RISK_LEVELS.HIGH);
    });
  });

  describe('DEAD_CODE', () => {
    it('should have weights in valid range', () => {
      expect(constants.DEAD_CODE.NO_CALLERS_WEIGHT).toBeGreaterThan(0);
      expect(constants.DEAD_CODE.UNREACHABLE_FILE_WEIGHT).toBeGreaterThan(0);
      expect(constants.DEAD_CODE.RE_EXPORTED_PENALTY).toBeGreaterThan(0);
    });

    it('should have DEFAULT_MIN_CONFIDENCE between 0 and 1', () => {
      expect(constants.DEAD_CODE.DEFAULT_MIN_CONFIDENCE).toBeGreaterThan(0);
      expect(constants.DEAD_CODE.DEFAULT_MIN_CONFIDENCE).toBeLessThanOrEqual(1);
    });
  });

  describe('COMPLEXITY', () => {
    it('should have LOW_THRESHOLD < MEDIUM_THRESHOLD', () => {
      expect(constants.COMPLEXITY.LOW_THRESHOLD).toBeLessThan(constants.COMPLEXITY.MEDIUM_THRESHOLD);
    });
  });

  describe('COUPLING', () => {
    it('should have STABLE_THRESHOLD < UNSTABLE_THRESHOLD', () => {
      expect(constants.COUPLING.STABLE_THRESHOLD).toBeLessThan(constants.COUPLING.UNSTABLE_THRESHOLD);
    });
  });

  describe('FRESHNESS_CACHE_TTL_MS', () => {
    it('should be 60000 (60 seconds)', () => {
      expect(constants.FRESHNESS_CACHE_TTL_MS).toBe(60000);
    });
  });

  describe('CONFIDENCE_DEFAULTS', () => {
    it('should have UNKNOWN_TOOL between 0 and 1', () => {
      expect(constants.CONFIDENCE_DEFAULTS.UNKNOWN_TOOL).toBeGreaterThanOrEqual(0);
      expect(constants.CONFIDENCE_DEFAULTS.UNKNOWN_TOOL).toBeLessThanOrEqual(1);
    });

    it('should have DETERMINISTIC_TOOL equal to 1.0', () => {
      expect(constants.CONFIDENCE_DEFAULTS.DETERMINISTIC_TOOL).toBe(1.0);
    });
  });
});
