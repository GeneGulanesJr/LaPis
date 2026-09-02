const { requireNativeDb } = require('../../utils');

class CodeIndexReadRepository {
  constructor(db) {
    this.db = db;
  }

  guard() {
    return requireNativeDb(this.db);
  }

  getRepo(repoId) {
    const guard = this.guard();
    if (guard) {
      return guard;
    }
    return this.db.prepare('SELECT * FROM code_repos WHERE id = ?').get(repoId) || null;
  }

  findSymbolId(repoId, name) {
    const guard = this.guard();
    if (guard) {
      return null;
    }
    {
const row = this.db.prepare('SELECT id FROM code_symbols WHERE repo_id = ? AND name = ?').get(repoId, name);
    return row?.id ?? null;
  }
}

  getSymbols(repoId, extraWhere = '', params = []) {
    const guard = this.guard();
    if (guard) {
      return [];
    }
    return this.db.prepare(`SELECT * FROM code_symbols WHERE repo_id = ? ${extraWhere}`).all(repoId, ...params);
  }

  getFiles(repoId, extraWhere = '', params = []) {
    const guard = this.guard();
    if (guard) {
      return [];
    }
    return this.db.prepare(`SELECT * FROM code_files WHERE repo_id = ? ${extraWhere}`).all(repoId, ...params);
  }
}

function createCodeIndexReadRepository(db) {
  return new CodeIndexReadRepository(db);
}

module.exports = { CodeIndexReadRepository, createCodeIndexReadRepository };
