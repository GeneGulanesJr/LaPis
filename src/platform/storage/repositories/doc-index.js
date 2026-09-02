function createDocIndexRepository(deps) {
  const { sqlJson, sqlRun } = deps,
    findRepoByName = (name) => sqlJson('SELECT * FROM doc_repos WHERE name = ? LIMIT 1', [name]);
  return Object.freeze({
    findRepoByName,
    findRepoByPath(path) {
      return sqlJson('SELECT * FROM doc_repos WHERE path = ? LIMIT 1', [path]);
    },
    clearRepoIndex(repoId) {
      sqlRun('DELETE FROM doc_sections WHERE repo_id = ?', [repoId]);
      sqlRun('DELETE FROM doc_files WHERE repo_id = ?', [repoId]);
      sqlRun('DELETE FROM doc_terms WHERE repo_id = ?', [repoId]);
    },
    insertFile(params) {
      sqlRun('INSERT INTO doc_files (repo_id, path, content, content_hash, mtime) VALUES (?, ?, ?, ?, ?)', [
        params.repoId,
        params.path,
        params.content,
        params.contentHash,
        params.mtime,
      ]);
      return sqlJson('SELECT id FROM doc_files WHERE repo_id = ? AND path = ?', [params.repoId, params.path])[0].id;
    },
    insertSection(params) {
      sqlRun(
        'INSERT INTO doc_sections (repo_id, file_id, title, level, parent_id, content, content_hash, byte_start, byte_end, role, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          params.repoId,
          params.fileId,
          params.title,
          params.level,
          params.parentId || null,
          params.content || '',
          params.contentHash,
          params.byteStart,
          params.byteEnd,
          params.role || 'other',
          params.tags || '',
        ],
      );
      return sqlJson('SELECT last_insert_rowid() as id')[0].id;
    },
    insertLink(params) {
      sqlRun(
        'INSERT INTO doc_links (source_section_id, target_path, target_section_id, link_text, is_broken) VALUES (?, ?, ?, ?, ?)',
        [
          params.sourceSectionId,
          params.targetPath,
          params.targetSectionId || null,
          params.linkText || '',
          params.isBroken ? 1 : 0,
        ],
      );
    },
    insertTerm(params) {
      sqlRun('INSERT OR REPLACE INTO doc_terms (repo_id, term, definition, section_id) VALUES (?, ?, ?, ?)', [
        params.repoId,
        params.term,
        params.definition,
        params.sectionId || null,
      ]);
    },
    listRepos() {
      return sqlJson('SELECT * FROM doc_repos ORDER BY updated_at DESC');
    },
  });
}

module.exports = { createDocIndexRepository };
