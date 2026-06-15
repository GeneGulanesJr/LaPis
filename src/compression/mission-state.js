const { compressGeneric } = require('../token-saver/rules/generic');
const { estimateTokens } = require('../token-saver/estimate-tokens');

/**
 * Aggregate a mission's recent state into a single text blob, then run
 * it through the existing generic compressor. Returns a structured
 * CompressionResult that the HTTP handler persists and returns.
 *
 * @param {object} deps
 * @param {(sql: string, params?: any[]) => any[]} deps.sqlJson - SELECT helper
 * @param {string} deps.missionId
 * @param {number} [deps.windowSize=50] - max recent records per source
 * @returns {{ summary: string, tokensSaved: number, error?: string }}
 */
function compressMissionState({ sqlJson, missionId, windowSize = 50 }) {
  if (!missionId) {
    return { summary: '', tokensSaved: 0, error: 'missionId is required' };
  }

  const sections = [];

  // 1. Recent research findings (high-signal: domain knowledge)
  const findings = sqlJson(
    `SELECT title, content, relevance, status
     FROM research_findings
     WHERE mission_id = ?
     ORDER BY created_at DESC
     LIMIT ?`,
    [missionId, windowSize],
  );
  if (findings.length > 0) {
    sections.push(
      `## Research findings (${findings.length})\n` +
        findings
          .map(
            (f) =>
              `- [${f.relevance}/${f.status}] ${f.title}: ${f.content.slice(0, 200)}`,
          )
          .join('\n'),
    );
  }

  // 2. Recent worker handoffs (what was done vs. what remains)
  // The handoffs table was added in the V22 migration (see db.js:runMigrationV22)
  // and is persisted by src/platform/storage/repositories/aurex.js:createHandoff.
  const handoffs = sqlJson(
    `SELECT feature_name, description, remaining, status
     FROM handoffs
     WHERE mission_id = ?
     ORDER BY created_at DESC
     LIMIT ?`,
    [missionId, windowSize],
  );
  if (handoffs.length > 0) {
    sections.push(
      `## Worker handoffs (${handoffs.length})\n` +
        handoffs
          .map(
            (h) =>
              `- [${h.status}] ${h.feature_name}: ${h.description?.slice(0, 200) ?? ''}` +
              (h.remaining ? ` — remaining: ${String(h.remaining).slice(0, 160)}` : ''),
          )
          .join('\n'),
    );
  }

  // 3. Failed validation verdicts (what went wrong)
  // Schema note: validation_verdicts uses `timestamp`, not `created_at`.
  const verdicts = sqlJson(
    `SELECT vv.verdict, vv.findings, vv.failed_unit_ids
     FROM validation_verdicts vv
     JOIN validation_contracts vc ON vc.id = vv.contract_id
     JOIN milestones m ON m.id = vc.milestone_id
     WHERE m.mission_id = ? AND vv.verdict = 'fail'
     ORDER BY vv.timestamp DESC
     LIMIT ?`,
    [missionId, windowSize],
  );
  if (verdicts.length > 0) {
    sections.push(
      `## Failed verdicts (${verdicts.length})\n` +
        verdicts.map((v) => `- ${v.verdict}: ${v.findings?.slice(0, 200) ?? ''}`).join('\n'),
    );
  }

  // 3. Cost summary (cumulative)
  const costRows = sqlJson(
    `SELECT
       COALESCE(SUM(cost), 0) AS total_cost,
       COALESCE(SUM(prompt_tokens), 0) AS total_prompt_tokens,
       COALESCE(SUM(completion_tokens), 0) AS total_completion_tokens,
       COUNT(*) AS entry_count
     FROM cost_entries
     WHERE mission_id = ?`,
    [missionId],
  );
  if (costRows.length > 0 && costRows[0].entry_count > 0) {
    const c = costRows[0];
    sections.push(
      `## Cost summary\n${c.entry_count} entries, $${c.total_cost.toFixed(2)} total, ${c.total_prompt_tokens + c.total_completion_tokens} tokens`,
    );
  }

  if (sections.length === 0) {
    return {
      summary: 'Mission has no compressible state yet (no findings, handoffs, verdicts, or cost entries).',
      tokensSaved: 0,
    };
  }

  const combined = sections.join('\n\n');
  const originalTokens = estimateTokens(combined);

  const compressed = compressGeneric({
    stdout: combined,
    stderr: '',
    exitCode: 0,
  });

  const compressedTokens = estimateTokens(compressed.importantOutput || '');
  const tokensSaved = Math.max(0, originalTokens - compressedTokens);

  return {
    summary: compressed.summary,
    tokensSaved,
  };
}

module.exports = { compressMissionState };
