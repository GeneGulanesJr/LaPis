function createAnalyticsRepository(deps) {
  const { sqlJson } = deps;
  return Object.freeze({
    getStorageStats() {
      const one = (query) => sqlJson(query)[0].cnt;
      return {
        observations: one('SELECT COUNT(*) as cnt FROM observations WHERE deleted_at IS NULL'),
        prompts: one('SELECT COUNT(*) as cnt FROM user_prompts'),
        sessions: one('SELECT COUNT(*) as cnt FROM session_log'),
        symbolLinks: one('SELECT COUNT(*) as cnt FROM symbol_links'),
        codeRepos: one('SELECT COUNT(*) as cnt FROM code_repos'),
        docRepos: one('SELECT COUNT(*) as cnt FROM doc_repos'),
      };
    },
    getRecallCountsByMemory(limit = 50) {
      return sqlJson(
        `SELECT memory_id, COUNT(*) as recall_count
         FROM recall_log
         GROUP BY memory_id
         ORDER BY recall_count DESC
         LIMIT ?`,
        [limit],
      );
    },
  });
}

module.exports = { createAnalyticsRepository };
