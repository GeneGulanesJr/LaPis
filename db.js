/**
 * Db.js — Database layer for Pi Memory Layer
 *
 * SQLite backend via node:sqlite (Node ≥ 22.5) or better-sqlite3.
 * Zero external Python deps. Zero MCP servers.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { getConfig } = require('./config');

/* ── paths ────────────────────────────────────────────────── */
const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const SCHEMA_PATH = path.resolve(__dirname, 'schema.sql');

/* ── module state ─────────────────────────────────────────── */
let _db = null;
let _engine = null; // 'node-sqlite' | 'better-sqlite3'

function getDb() { return _db; }
function getEngine() { return _engine; }
function getDbPath() { return getConfig().db_path; }

/* ── backend detection ────────────────────────────────────── */

function tryNodeSqlite() {
  try {
    const cfg = getConfig();
    const mod = require('node:sqlite');
    const d = new mod.DatabaseSync(cfg.db_path);
    d.exec('PRAGMA journal_mode=WAL;');
    d.exec(`PRAGMA busy_timeout=${cfg.busy_timeout_ms};`);
    d.exec(`PRAGMA wal_autocheckpoint=${cfg.wal_autocheckpoint};`);
    return d;
  } catch (_) { return null; }
}

function tryBetterSqlite3() {
  try {
    const cfg = getConfig();
    const Database = require('better-sqlite3');
    const d = new Database(cfg.db_path);
    d.pragma('journal_mode = WAL');
    d.pragma(`busy_timeout = ${cfg.busy_timeout_ms}`);
    d.pragma(`wal_autocheckpoint = ${cfg.wal_autocheckpoint}`);
    return d;
  } catch (_) { return null; }
}

function openDb() {
  const nodeDb = tryNodeSqlite();
  if (nodeDb) { _engine = 'node-sqlite'; _db = nodeDb; return nodeDb; }
  const betterDb = tryBetterSqlite3();
  if (betterDb) { _engine = 'better-sqlite3'; _db = betterDb; return betterDb; }
  const msg = `No SQLite backend found.\n` +
    `  Option 1: Use Node.js ≥ 22.5 (built-in node:sqlite)\n` +
    `  Option 2: cd ${  __dirname  } && npm install better-sqlite3`;
  throw new Error(msg);
}

/* ── native SQL layer ─────────────────────────────────────── */

function _sqlJson(query, params = []) {
  try {
    const stmt = _db.prepare(query);
    return stmt.all(...params);
  } catch (e) {
    throw new Error(`SQL error: ${e.message}\nQuery: ${query}`, { cause: e });
  }
}

function _sqlRun(query, params = []) {
  try {
    const stmt = _db.prepare(query);
    stmt.run(...params);
  } catch (e) {
    throw new Error(`SQL error: ${e.message}\nQuery: ${query}`, { cause: e });
  }
}

function _sqlExec(sql) {
  try {
    _db.exec(sql);
  } catch (e) {
    throw new Error(`SQL exec error: ${e.message}`, { cause: e });
  }
}

// Public aliases
const sqlJson = _sqlJson;
const sqlRun = _sqlRun;
const sqlRaw = _sqlExec;

/* ── transaction helper ───────────────────────────────────── */

function withTransaction(fn) {
  if (!_db) {throw new Error('Database not initialized. Call ensureDb() first.');}
  if (typeof _db.transaction === 'function') {
    return _db.transaction(fn)();
  }
  _db.exec('BEGIN');
  try {
    const result = fn();
    _db.exec('COMMIT');
    return result;
  } catch (e) {
    try { _db.exec('ROLLBACK'); } catch (_) {}
    throw e;
  }
}

/* ── ensureDb ─────────────────────────────────────────────── */

function ensureDb() {
  const dbPath = getDbPath();
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {fs.mkdirSync(dir, { recursive: true });}

  if (!_db) {openDb();}

  if (!fs.existsSync(dbPath) || fs.statSync(dbPath).size === 0) {
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    const statements = schema
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--') && !s.startsWith('PRAGMA'));
    for (const stmt of statements) {
      try { _sqlExec(stmt); } catch (_) {}
    }
  }

  runMigrations();

  ensureCriticalTables();

  return { ok: true, db: dbPath, engine: _engine };
}

// Critical tables that must exist for code analysis + doc indexing
const _CRITICAL_TABLES = [
  // V3: code indexing
  ['code_repos', 'CREATE TABLE IF NOT EXISTS code_repos (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, path TEXT NOT NULL UNIQUE, file_count INTEGER DEFAULT 0, symbol_count INTEGER DEFAULT 0, indexed_at TEXT NOT NULL DEFAULT (datetime(\'now\')), updated_at TEXT NOT NULL DEFAULT (datetime(\'now\')), head_commit TEXT)'],
  ['code_files', 'CREATE TABLE IF NOT EXISTS code_files (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES code_repos(id) ON DELETE CASCADE, path TEXT NOT NULL, language TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL, mtime REAL, size_bytes INTEGER DEFAULT 0, line_count INTEGER DEFAULT 0, UNIQUE(repo_id, path))'],
  ['code_symbols', 'CREATE TABLE IF NOT EXISTS code_symbols (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES code_repos(id) ON DELETE CASCADE, file_id INTEGER NOT NULL REFERENCES code_files(id) ON DELETE CASCADE, name TEXT NOT NULL, kind TEXT NOT NULL, signature TEXT, file_path TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, start_byte INTEGER NOT NULL, end_byte INTEGER NOT NULL, docstring TEXT DEFAULT \'\', body_preview TEXT DEFAULT \'\', language TEXT NOT NULL, parent_name TEXT DEFAULT \'\', qualified_name TEXT NOT NULL, indexed_at TEXT NOT NULL DEFAULT (datetime(\'now\')))'],
  // V5: code analysis
  ['code_imports', 'CREATE TABLE IF NOT EXISTS code_imports (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES code_repos(id) ON DELETE CASCADE, source_file_id INTEGER NOT NULL REFERENCES code_files(id) ON DELETE CASCADE, target_module TEXT NOT NULL, target_file_id INTEGER REFERENCES code_files(id) ON DELETE SET NULL, import_type TEXT NOT NULL DEFAULT \'static\', line_number INTEGER, UNIQUE(repo_id, source_file_id, target_module))'],
  ['code_calls', 'CREATE TABLE IF NOT EXISTS code_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES code_repos(id) ON DELETE CASCADE, caller_symbol_id INTEGER NOT NULL REFERENCES code_symbols(id) ON DELETE CASCADE, callee_name TEXT NOT NULL, callee_symbol_id INTEGER REFERENCES code_symbols(id) ON DELETE SET NULL, confidence REAL NOT NULL DEFAULT 1.0, line_number INTEGER, UNIQUE(repo_id, caller_symbol_id, callee_name))'],
  ['symbol_complexity', 'CREATE TABLE IF NOT EXISTS symbol_complexity (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol_id INTEGER NOT NULL UNIQUE REFERENCES code_symbols(id) ON DELETE CASCADE, cyclomatic INTEGER NOT NULL DEFAULT 1, nesting_depth INTEGER NOT NULL DEFAULT 0, param_count INTEGER NOT NULL DEFAULT 0, lines_of_code INTEGER NOT NULL DEFAULT 0, assessment TEXT NOT NULL DEFAULT \'low\')'],
  ['churn_metrics', 'CREATE TABLE IF NOT EXISTS churn_metrics (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES code_repos(id) ON DELETE CASCADE, file_path TEXT NOT NULL, commits INTEGER NOT NULL DEFAULT 0, unique_authors INTEGER NOT NULL DEFAULT 0, first_seen TEXT, last_modified TEXT, churn_per_week REAL DEFAULT 0.0, window_days INTEGER NOT NULL DEFAULT 90, UNIQUE(repo_id, file_path, window_days))'],
  // V5: doc indexing
  ['doc_repos', 'CREATE TABLE IF NOT EXISTS doc_repos (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, path TEXT NOT NULL UNIQUE, file_count INTEGER DEFAULT 0, section_count INTEGER DEFAULT 0, indexed_at TEXT NOT NULL DEFAULT (datetime(\'now\')), updated_at TEXT NOT NULL DEFAULT (datetime(\'now\')))'],
  ['doc_files', 'CREATE TABLE IF NOT EXISTS doc_files (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES doc_repos(id) ON DELETE CASCADE, path TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL, mtime REAL, UNIQUE(repo_id, path))'],
  ['doc_sections', 'CREATE TABLE IF NOT EXISTS doc_sections (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES doc_repos(id) ON DELETE CASCADE, file_id INTEGER NOT NULL REFERENCES doc_files(id) ON DELETE CASCADE, title TEXT NOT NULL, level INTEGER NOT NULL, parent_id INTEGER REFERENCES doc_sections(id) ON DELETE SET NULL, content TEXT DEFAULT \'\', content_hash TEXT NOT NULL, byte_start INTEGER NOT NULL, byte_end INTEGER NOT NULL, role TEXT DEFAULT \'other\', tags TEXT DEFAULT \'\', UNIQUE(repo_id, file_id, byte_start))'],
  ['doc_links', 'CREATE TABLE IF NOT EXISTS doc_links (id INTEGER PRIMARY KEY AUTOINCREMENT, source_section_id INTEGER NOT NULL REFERENCES doc_sections(id) ON DELETE CASCADE, target_path TEXT NOT NULL, target_section_id INTEGER REFERENCES doc_sections(id) ON DELETE SET NULL, link_text TEXT DEFAULT \'\', is_broken INTEGER NOT NULL DEFAULT 0)'],
  ['doc_terms', 'CREATE TABLE IF NOT EXISTS doc_terms (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES doc_repos(id) ON DELETE CASCADE, term TEXT NOT NULL, definition TEXT NOT NULL, section_id INTEGER REFERENCES doc_sections(id) ON DELETE SET NULL, UNIQUE(repo_id, term))'],
  ['doc_code_blocks', 'CREATE TABLE IF NOT EXISTS doc_code_blocks (id INTEGER PRIMARY KEY AUTOINCREMENT, section_id INTEGER NOT NULL REFERENCES doc_sections(id) ON DELETE CASCADE, lang TEXT DEFAULT \'\', content TEXT NOT NULL, byte_start INTEGER NOT NULL, byte_end INTEGER NOT NULL)'],
];

function ensureCriticalTables() {
  for (const [name, createSql] of _CRITICAL_TABLES) {
    try {
      const exists = _db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").all(name);
      if (!exists.length) {
        _db.exec(createSql);
        // Create indexes
        _createTableIndexes(name, _db);
      }
    } catch (_) {}
  }
}

function _createTableIndexes(name, db) {
  const indexMap = {
    code_repos: [],
    code_files: ['CREATE INDEX IF NOT EXISTS idx_cf_repo ON code_files(repo_id)'],
    code_symbols: ['CREATE INDEX IF NOT EXISTS idx_cs_repo ON code_symbols(repo_id)', 'CREATE INDEX IF NOT EXISTS idx_cs_name ON code_symbols(name)', 'CREATE INDEX IF NOT EXISTS idx_cs_file ON code_symbols(file_id)'],
    code_imports: ['CREATE INDEX IF NOT EXISTS idx_ci_source ON code_imports(source_file_id)', 'CREATE INDEX IF NOT EXISTS idx_ci_target ON code_imports(target_file_id)', 'CREATE INDEX IF NOT EXISTS idx_ci_repo ON code_imports(repo_id)'],
    code_calls: ['CREATE INDEX IF NOT EXISTS idx_cc_caller ON code_calls(caller_symbol_id)', 'CREATE INDEX IF NOT EXISTS idx_cc_callee_name ON code_calls(repo_id, callee_name)', 'CREATE INDEX IF NOT EXISTS idx_cc_callee ON code_calls(callee_symbol_id)'],
    symbol_complexity: ['CREATE INDEX IF NOT EXISTS idx_sc_symbol ON symbol_complexity(symbol_id)'],
    churn_metrics: ['CREATE INDEX IF NOT EXISTS idx_cm_repo ON churn_metrics(repo_id)'],
    doc_sections: ['CREATE INDEX IF NOT EXISTS idx_ds_file ON doc_sections(file_id)', 'CREATE INDEX IF NOT EXISTS idx_ds_parent ON doc_sections(parent_id)', 'CREATE INDEX IF NOT EXISTS idx_ds_repo ON doc_sections(repo_id)', 'CREATE INDEX IF NOT EXISTS idx_ds_level ON doc_sections(level)'],
    doc_links: ['CREATE INDEX IF NOT EXISTS idx_dl_source ON doc_links(source_section_id)', 'CREATE INDEX IF NOT EXISTS idx_dl_target ON doc_links(target_section_id)', 'CREATE INDEX IF NOT EXISTS idx_dl_broken ON doc_links(is_broken)'],
    doc_terms: ['CREATE INDEX IF NOT EXISTS idx_dt_term ON doc_terms(term)', 'CREATE INDEX IF NOT EXISTS idx_dt_repo ON doc_terms(repo_id)'],
    doc_code_blocks: ['CREATE INDEX IF NOT EXISTS idx_dcb_section ON doc_code_blocks(section_id)', 'CREATE INDEX IF NOT EXISTS idx_dcb_lang ON doc_code_blocks(lang)'],
  };
  for (const sql of (indexMap[name] || [])) {
    try { db.exec(sql); } catch (_) {}
  }
}

/* ── migrations ───────────────────────────────────────────── */

function runMigrations() {
  let version = 0;
  try {
    const rows = sqlJson('PRAGMA user_version');
    version = rows.length > 0 ? (rows[0].user_version || 0) : 0;
  } catch (_) {}

  if (version >= 6) {return { migrated: false, version };}

  // V2: observation_relations, recall_log
  if (version < 2) {
    const v2 = [
      `CREATE TABLE IF NOT EXISTS observation_relations (
        source_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
        target_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
        relation TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0.8,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (source_id, target_id, relation))`,
      'CREATE INDEX IF NOT EXISTS idx_obs_rel_source ON observation_relations(source_id)',
      'CREATE INDEX IF NOT EXISTS idx_obs_rel_target ON observation_relations(target_id)',
      `CREATE TABLE IF NOT EXISTS recall_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
        session_id INTEGER NOT NULL, query TEXT, was_useful INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
      'CREATE INDEX IF NOT EXISTS idx_recall_memory ON recall_log(memory_id)',
      'CREATE INDEX IF NOT EXISTS idx_recall_session ON recall_log(session_id)',
    ];
    for (const s of v2) { try { sqlRaw(s); } catch (_) {} }
    try { sqlRaw('PRAGMA user_version = 2'); } catch (_) {}
  }

  // V3: code_repos, code_files, code_symbols, code_symbols_fts
  if (version < 3) {
    const v3 = [
      `CREATE TABLE IF NOT EXISTS code_repos (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
        path TEXT NOT NULL UNIQUE, file_count INTEGER DEFAULT 0, symbol_count INTEGER DEFAULT 0,
        indexed_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
      `CREATE TABLE IF NOT EXISTS code_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES code_repos(id) ON DELETE CASCADE,
        path TEXT NOT NULL, language TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL,
        mtime REAL, size_bytes INTEGER DEFAULT 0, line_count INTEGER DEFAULT 0, UNIQUE(repo_id, path))`,
      `CREATE TABLE IF NOT EXISTS code_symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES code_repos(id) ON DELETE CASCADE,
        file_id INTEGER NOT NULL REFERENCES code_files(id) ON DELETE CASCADE, name TEXT NOT NULL, kind TEXT NOT NULL,
        signature TEXT, file_path TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
        start_byte INTEGER NOT NULL, end_byte INTEGER NOT NULL, docstring TEXT DEFAULT '',
        body_preview TEXT DEFAULT '', language TEXT NOT NULL, parent_name TEXT DEFAULT '',
        qualified_name TEXT NOT NULL, indexed_at TEXT NOT NULL DEFAULT (datetime('now')))`,
      'CREATE INDEX IF NOT EXISTS idx_cs_repo ON code_symbols(repo_id)',
      'CREATE INDEX IF NOT EXISTS idx_cs_name ON code_symbols(name)',
      'CREATE INDEX IF NOT EXISTS idx_cs_file ON code_symbols(file_id)',
      'CREATE INDEX IF NOT EXISTS idx_cf_repo ON code_files(repo_id)',
    ];
    for (const s of v3) { try { sqlRaw(s); } catch (_) {} }
    try {
      sqlRaw(`CREATE VIRTUAL TABLE IF NOT EXISTS code_symbols_fts USING fts5(
        name, kind, signature, docstring, file_path, body_preview, content=code_symbols, content_rowid=id)`);
    } catch (_) {}
    try { sqlRaw('PRAGMA user_version = 3'); } catch (_) {}
  }

  // V4: workspaces
  if (version < 4) {
    try {
      sqlRaw(`CREATE TABLE IF NOT EXISTS workspaces (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), archived_at TEXT)`);
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_ws_active ON workspaces(archived_at) WHERE archived_at IS NULL');
    } catch (_) {}
    try {
      const projects = sqlJson(
        "SELECT DISTINCT project FROM observations WHERE project IS NOT NULL AND project != '' AND deleted_at IS NULL");
      for (const r of projects) { try { sqlRun('INSERT OR IGNORE INTO workspaces (name) VALUES (?)', [r.project]); } catch (_) {} }
      const sp = sqlJson("SELECT DISTINCT project FROM session_log WHERE project IS NOT NULL AND project != ''");
      for (const r of sp) { try { sqlRun('INSERT OR IGNORE INTO workspaces (name) VALUES (?)', [r.project]); } catch (_) {} }
    } catch (_) {}
    try { sqlRaw('PRAGMA user_version = 4'); } catch (_) {}
  }

  // V5: code analysis + doc indexing tables (CREATE IF NOT EXISTS from schema.sql)
  if (version < 5) {
    try {
      const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
      _db.exec(schema);
    } catch (e) {
      const stmts = schema.split(/;\s*\n/).map(s => s.trim()).filter(s => s.length > 0);
      for (const s of stmts) { try { sqlRaw(s); } catch (_) {} }
    }
    try { sqlRaw('PRAGMA user_version = 5'); } catch (_) {}
  }

  // V6: head_commit column for freshness checks + PageRank cache invalidation
  if (version < 6) {
    try {
      sqlRaw('ALTER TABLE code_repos ADD COLUMN head_commit TEXT');
    } catch (_) { /* Column may already exist */ }
    try { sqlRaw('PRAGMA user_version = 6'); } catch (_) {}
  }

  return { migrated: true, fromVersion: version, toVersion: 6 };
}

/* ── utilities ────────────────────────────────────────────── */

function jsonOut(obj) { console.log(JSON.stringify(obj, null, 2)); }
function jsonErr(msg) { process.stderr.write(`${JSON.stringify({ error: msg })  }\n`); process.exit(1); }

function parseArgs(argv) {
  const args = {};
  let key = null;
  for (const arg of argv.slice(3)) {
    if (arg.startsWith('--')) { key = arg.slice(2); args[key] = true; }
    else if (key) { args[key] = arg; key = null; }
  }
  return args;
}

/* ── exports ───────────────────────────────────────────────── */
module.exports = {
  get DB_PATH() { return getConfig().db_path; },
  SCHEMA_PATH, HOME,
  getDb, getEngine, getDbPath,
  sqlJson, sqlRun, sqlRaw,
  ensureDb, withTransaction,
  jsonOut, jsonErr, parseArgs,
};