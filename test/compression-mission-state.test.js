// Test coverage for src/compression/mission-state.js
// Uses vitest globals (no explicit require of vitest) per the existing test convention.
const { compressMissionState } = require('../src/compression/mission-state');

function makeSqlJson(rowsByQuery) {
  return (sql, params) => {
    // Match by FROM clause to dispatch to the right canned response
    if (/FROM research_findings/.test(sql)) return rowsByQuery.findings ?? [];
    if (/FROM handoffs/.test(sql)) return rowsByQuery.handoffs ?? [];
    if (/FROM validation_verdicts/.test(sql)) return rowsByQuery.verdicts ?? [];
    if (/FROM cost_entries/.test(sql)) return rowsByQuery.costs ?? [];
    return [];
  };
}

describe('compressMissionState', () => {
  it('returns an error when missionId is missing', () => {
    const result = compressMissionState({ sqlJson: makeSqlJson({}), missionId: '' });
    expect(result.error).toBeDefined();
    expect(result.tokensSaved).toBe(0);
  });

  it('returns a friendly empty-state summary when there is nothing to compress', () => {
    const result = compressMissionState({ sqlJson: makeSqlJson({}), missionId: 'm-1' });
    expect(result.summary).toMatch(/no compressible state/i);
    expect(result.tokensSaved).toBe(0);
  });

  it('aggregates findings, verdicts, and costs into a single summary', () => {
    const sqlJson = makeSqlJson({
      findings: [
        {
          title: 'Auth uses JWT',
          content: 'JWT signed with HS256, validated in middleware.ts',
          relevance: 'high',
          status: 'verified',
        },
      ],
      verdicts: [{ verdict: 'fail', findings: 'missing error handling on 401', failed_unit_ids: 'u-1' }],
      costs: [{ total_cost: 1.5, total_prompt_tokens: 1000, total_completion_tokens: 500, entry_count: 3 }],
    });
    const result = compressMissionState({ sqlJson, missionId: 'm-1' });
    expect(result.summary).toBeDefined();
    expect(result.summary.length).toBeGreaterThan(0);
    expect(result.tokensSaved).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it('aggregates worker handoffs into the summary', () => {
    const queries = [];
    const baseSqlJson = makeSqlJson({
      handoffs: [
        {
          feature_name: 'Login flow',
          description: 'Implemented OAuth callback',
          remaining: 'Add rate limiting',
          status: 'accepted',
        },
      ],
    });
    const sqlJson = (sql, params) => {
      queries.push({ sql, params });
      return baseSqlJson(sql, params);
    };
    const result = compressMissionState({ sqlJson, missionId: 'm-1' });

    // The handoffs table is queried for this mission, bounded by windowSize.
    const handoffQuery = queries.find((q) => /FROM handoffs/.test(q.sql));
    expect(handoffQuery).toBeDefined();
    expect(handoffQuery.params).toEqual(['m-1', 50]);

    // The handoff content flows into the compressor (non-empty summary produced).
    expect(result.summary).toBeDefined();
    expect(result.summary.length).toBeGreaterThan(0);
    expect(result.tokensSaved).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it('returns tokensSaved >= 0 even when compression does not shrink input', () => {
    const sqlJson = makeSqlJson({
      findings: [{ title: 'a', content: 'b', relevance: 'low', status: 'unverified' }],
    });
    const result = compressMissionState({ sqlJson, missionId: 'm-1' });
    expect(result.tokensSaved).toBeGreaterThanOrEqual(0);
  });
});
