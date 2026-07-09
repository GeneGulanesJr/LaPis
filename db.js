/**
 * Db.js — Database layer for Pi Memory Layer
 *
 * SQLite backend via better-sqlite3.
 * Zero external Python deps. Zero MCP servers.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { getConfig } = require('./config');

/* ── custom error ─────────────────────────────────────────── */
// MemoryError is used by memory-store.js CLI dispatch for typed error handling.
// Do NOT replace with generic Error (PR22 deferred) — downstream catches instanceof.
class MemoryError extends Error {
  constructor(message, context = {}) {
    super(message);
    this.name = 'MemoryError';
    this.context = context;
  }
}

/* ── paths ────────────────────────────────────────────────── */
const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const SCHEMA_PATH = path.resolve(__dirname, 'schema.sql');

/* ── module state ─────────────────────────────────────────── */
let _db = null;
let _engine = null; // 'better-sqlite3'

function getDb() {
  return _db;
}
function getEngine() {
  return _engine;
}
function getDbPath() {
  return getConfig().db_path;
}

// ResetDb/createDb are public API needed for test isolation (Issue #36).
// Do NOT remove — PR22 deferred this change incorrectly.
function resetDb() {
  if (_db) {
    try {
      _db.close();
    } catch {}
  }
  _db = null;
  _engine = null;
}

function createDb(configOverride = {}) {
  const mergedConfig = { ...getConfig(), ...configOverride };
  const savedConfig = getConfig._cached;
  const savedDb = _db;
  const savedEngine = _engine;

  getConfig._cached = mergedConfig;
  try {
    _db = null;
    _engine = null;
    const result = ensureDb();
    return result;
  } catch (e) {
    // Restore on failure
    _db = savedDb;
    _engine = savedEngine;
    getConfig._cached = savedConfig;
    throw e;
  }
  // NOTE: After successful createDb, the global _db/_engine point to the isolated DB.
  // To restore the global singleton, call resetDb() then ensureDb().
  // Config is NOT auto-restored so callers can continue using the isolated DB.
}

/* ── backend detection ────────────────────────────────────── */

function safeInt(val, fallback) {
  const n = Number(val);
  return Number.isFinite(n) && n === Math.floor(n) ? n : fallback;
}

function findLapisRoot() {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
      if (pkg.name === '@genegulanesjr/lapis' || pkg.name === 'lapis') {
        return dir;
      }
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return __dirname;
}

function openBetterSqlite3() {
  try {
    const cfg = getConfig();
    const Database = require('better-sqlite3');
    const d = new Database(cfg.db_path);
    d.pragma('journal_mode = WAL');
    d.pragma('synchronous = NORMAL');
    d.pragma('temp_store = MEMORY');
    d.pragma(`busy_timeout = ${safeInt(cfg.busy_timeout_ms, 30000)}`);
    d.pragma(`wal_autocheckpoint = ${safeInt(cfg.wal_autocheckpoint, 1000)}`);
    d.pragma('foreign_keys = ON');
    return d;
  } catch (e) {
    console.error(`[db] better-sqlite3 failed: ${e.message}`);
    return null;
  }
}

function openDb() {
  const db = openBetterSqlite3();
  if (db) {
    _engine = 'better-sqlite3';
    _db = db;
    return db;
  }
  const lapisRoot = findLapisRoot();
  const msg =
    `No SQLite backend found. LaPis does not install dependencies at runtime.\n` +
    `  Run: cd ${lapisRoot} && npm install\n`;
  throw new Error(msg);
}

/* ── SQLITE_BUSY retry ─────────────────────────────────────── */

function isBusyError(e) {
  if (e && e.code === 'SQLITE_BUSY') {
    return true;
  }
  const msg = (e && e.message) || '';
  return /database is locked|SQLITE_BUSY/i.test(msg);
}

function sleepMs(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* Spin */
  }
}

function retryOnBusy(fn, label) {
  const maxRetries = safeInt(getConfig().busy_retry_max, 5);
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return fn();
    } catch (e) {
      lastError = e;
      if (!isBusyError(e) || attempt >= maxRetries) {
        break;
      }
      const delay = 100 * 2 ** attempt;
      if (label) {
        console.warn(`[db] SQLITE_BUSY on ${label}, retry ${attempt + 1}/${maxRetries} in ${delay}ms`);
      }
      sleepMs(delay);
    }
  }
  throw lastError;
}

/* ── native SQL layer ─────────────────────────────────────── */

function _sqlJson(query, params = []) {
  return retryOnBusy(() => {
    try {
      const stmt = _db.prepare(query);
      return stmt.all(...params);
    } catch (e) {
      throw new Error(`SQL error: ${e.message}\nQuery: ${query}`, { cause: e });
    }
  }, 'sqlJson');
}

function _sqlRun(query, params = []) {
  return retryOnBusy(() => {
    try {
      const stmt = _db.prepare(query);
      return stmt.run(...params);
    } catch (e) {
      throw new Error(`SQL error: ${e.message}\nQuery: ${query}`, { cause: e });
    }
  }, 'sqlRun');
}

function _sqlExec(sql) {
  return retryOnBusy(() => {
    try {
      _db.exec(sql);
    } catch (e) {
      throw new Error(`SQL exec error: ${e.message}`, { cause: e });
    }
  }, 'sqlExec');
}

// Public aliases
const sqlJson = _sqlJson;
const sqlRun = _sqlRun;
const sqlRaw = _sqlExec;

/* ── transaction helper ───────────────────────────────────── */

function withTransaction(fn, onRollbackError) {
  if (!_db) {
    throw new MemoryError('Database not initialized. Call ensureDb() first.');
  }
  if (typeof _db.transaction === 'function') {
    return _db.transaction(fn)();
  }
  _db.exec('BEGIN');
  try {
    const result = fn();
    _db.exec('COMMIT');
    return result;
  } catch (e) {
    try {
      _db.exec('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[db] ROLLBACK failed:', rollbackErr.message);
      try {
        if (typeof onRollbackError === 'function') {
          onRollbackError(rollbackErr);
        }
      } catch {}
    }
    throw e;
  }
}

/* ── ensureDb ─────────────────────────────────────────────── */

function ensureDb() {
  const dbPath = getDbPath();
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (!_db) {
    openDb();
  }

  if (!fs.existsSync(dbPath) || fs.statSync(dbPath).size === 0) {
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    try {
      _db.exec(schema);
    } catch {
      const stmts = schema
        .split(/;\s*\n/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !s.startsWith('--') && !/^\s*PRAGMA/i.test(s));
      for (const stmt of stmts) {
        try {
          _sqlExec(stmt);
        } catch (inner) {
          if (!/already exists|duplicate column/i.test(inner.message)) {
            console.error(`[db] Schema statement error: ${inner.message}`);
          }
        }
      }
    }
  }

  runMigrations();

  ensureCriticalTables();

  return { ok: true, db: dbPath, engine: _engine };
}

// Critical tables that must exist for code analysis + doc indexing
const _CRITICAL_TABLES = [
  // KV store — used by HTTP /api/settings, dashboard dream stats, integrations
  [
    'settings',
    `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  ],
  // V3: code indexing
  [
    'code_repos',
    "CREATE TABLE IF NOT EXISTS code_repos (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, path TEXT NOT NULL UNIQUE, file_count INTEGER DEFAULT 0, symbol_count INTEGER DEFAULT 0, indexed_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), head_commit TEXT, current_branch TEXT, base_head TEXT)",
  ],
  [
    'code_files',
    'CREATE TABLE IF NOT EXISTS code_files (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES code_repos(id) ON DELETE CASCADE, path TEXT NOT NULL, language TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL, mtime REAL, size_bytes INTEGER DEFAULT 0, line_count INTEGER DEFAULT 0, mtime_ns INTEGER, UNIQUE(repo_id, path))',
  ],
  [
    'code_file_diagnostics',
    "CREATE TABLE IF NOT EXISTS code_file_diagnostics (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES code_repos(id) ON DELETE CASCADE, file_path TEXT NOT NULL, status TEXT NOT NULL, message TEXT DEFAULT '', symbol_count INTEGER DEFAULT 0, content_hash TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(repo_id, file_path))",
  ],
  [
    'code_symbols',
    "CREATE TABLE IF NOT EXISTS code_symbols (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES code_repos(id) ON DELETE CASCADE, file_id INTEGER NOT NULL REFERENCES code_files(id) ON DELETE CASCADE, name TEXT NOT NULL, kind TEXT NOT NULL, signature TEXT, file_path TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, start_byte INTEGER NOT NULL, end_byte INTEGER NOT NULL, docstring TEXT DEFAULT '', body_preview TEXT DEFAULT '', language TEXT NOT NULL, parent_name TEXT DEFAULT '', qualified_name TEXT NOT NULL, stable_symbol_id TEXT DEFAULT '', content_hash TEXT DEFAULT '', summary TEXT DEFAULT '', decorators_json TEXT DEFAULT '[]', keywords_json TEXT DEFAULT '[]', call_references_json TEXT DEFAULT '[]', ecosystem_context TEXT DEFAULT '', indexed_at TEXT NOT NULL DEFAULT (datetime('now')))",
  ],
  // V5: code analysis
  [
    'code_imports',
    "CREATE TABLE IF NOT EXISTS code_imports (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES code_repos(id) ON DELETE CASCADE, source_file_id INTEGER NOT NULL REFERENCES code_files(id) ON DELETE CASCADE, target_module TEXT NOT NULL, target_file_id INTEGER REFERENCES code_files(id) ON DELETE SET NULL, import_type TEXT NOT NULL DEFAULT 'static', line_number INTEGER, UNIQUE(repo_id, source_file_id, target_module))",
  ],
  [
    'code_calls',
    'CREATE TABLE IF NOT EXISTS code_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES code_repos(id) ON DELETE CASCADE, caller_symbol_id INTEGER NOT NULL REFERENCES code_symbols(id) ON DELETE CASCADE, callee_name TEXT NOT NULL, callee_symbol_id INTEGER REFERENCES code_symbols(id) ON DELETE SET NULL, confidence REAL NOT NULL DEFAULT 1.0, line_number INTEGER, UNIQUE(repo_id, caller_symbol_id, callee_name))',
  ],
  [
    'symbol_complexity',
    "CREATE TABLE IF NOT EXISTS symbol_complexity (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol_id INTEGER NOT NULL UNIQUE REFERENCES code_symbols(id) ON DELETE CASCADE, cyclomatic INTEGER NOT NULL DEFAULT 1, nesting_depth INTEGER NOT NULL DEFAULT 0, param_count INTEGER NOT NULL DEFAULT 0, lines_of_code INTEGER NOT NULL DEFAULT 0, assessment TEXT NOT NULL DEFAULT 'low')",
  ],
  [
    'churn_metrics',
    'CREATE TABLE IF NOT EXISTS churn_metrics (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES code_repos(id) ON DELETE CASCADE, file_path TEXT NOT NULL, commits INTEGER NOT NULL DEFAULT 0, unique_authors INTEGER NOT NULL DEFAULT 0, first_seen TEXT, last_modified TEXT, churn_per_week REAL DEFAULT 0.0, window_days INTEGER NOT NULL DEFAULT 90, UNIQUE(repo_id, file_path, window_days))',
  ],
  // V5: doc indexing
  [
    'doc_repos',
    "CREATE TABLE IF NOT EXISTS doc_repos (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, path TEXT NOT NULL UNIQUE, file_count INTEGER DEFAULT 0, section_count INTEGER DEFAULT 0, indexed_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))",
  ],
  [
    'doc_files',
    'CREATE TABLE IF NOT EXISTS doc_files (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES doc_repos(id) ON DELETE CASCADE, path TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL, mtime REAL, UNIQUE(repo_id, path))',
  ],
  [
    'doc_sections',
    "CREATE TABLE IF NOT EXISTS doc_sections (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES doc_repos(id) ON DELETE CASCADE, file_id INTEGER NOT NULL REFERENCES doc_files(id) ON DELETE CASCADE, title TEXT NOT NULL, level INTEGER NOT NULL, parent_id INTEGER REFERENCES doc_sections(id) ON DELETE SET NULL, content TEXT DEFAULT '', content_hash TEXT NOT NULL, byte_start INTEGER NOT NULL, byte_end INTEGER NOT NULL, role TEXT DEFAULT 'other', tags TEXT DEFAULT '', UNIQUE(repo_id, file_id, byte_start))",
  ],
  [
    'doc_links',
    "CREATE TABLE IF NOT EXISTS doc_links (id INTEGER PRIMARY KEY AUTOINCREMENT, source_section_id INTEGER NOT NULL REFERENCES doc_sections(id) ON DELETE CASCADE, target_path TEXT NOT NULL, target_section_id INTEGER REFERENCES doc_sections(id) ON DELETE SET NULL, link_text TEXT DEFAULT '', is_broken INTEGER NOT NULL DEFAULT 0)",
  ],
  [
    'doc_terms',
    'CREATE TABLE IF NOT EXISTS doc_terms (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES doc_repos(id) ON DELETE CASCADE, term TEXT NOT NULL, definition TEXT NOT NULL, section_id INTEGER REFERENCES doc_sections(id) ON DELETE SET NULL, UNIQUE(repo_id, term))',
  ],
  [
    'doc_code_blocks',
    "CREATE TABLE IF NOT EXISTS doc_code_blocks (id INTEGER PRIMARY KEY AUTOINCREMENT, section_id INTEGER NOT NULL REFERENCES doc_sections(id) ON DELETE CASCADE, lang TEXT DEFAULT '', content TEXT NOT NULL, byte_start INTEGER NOT NULL, byte_end INTEGER NOT NULL)",
  ],
  // V10: scope-aware edge extraction
  [
    'file_scope_bindings',
    `CREATE TABLE IF NOT EXISTS file_scope_bindings (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES code_repos(id) ON DELETE CASCADE, file_id INTEGER NOT NULL REFERENCES code_files(id) ON DELETE CASCADE, name TEXT NOT NULL, kind TEXT NOT NULL, origin TEXT NOT NULL, source_file_id INTEGER NULL, source_name TEXT NULL, source_module TEXT NULL, line_start INTEGER NOT NULL, line_end INTEGER NOT NULL, scope_depth INTEGER NOT NULL DEFAULT 0, byte_start INTEGER NULL, byte_end INTEGER NULL, first_seen_pass INTEGER NOT NULL DEFAULT 0)`,
  ],
  [
    'scope_resolution',
    `CREATE TABLE IF NOT EXISTS scope_resolution (binding_id INTEGER PRIMARY KEY REFERENCES file_scope_bindings(id) ON DELETE CASCADE, resolved_symbol_id INTEGER NULL, resolved_file_id INTEGER NULL, status TEXT NOT NULL, resolved_at_pass INTEGER NOT NULL, confidence REAL NOT NULL DEFAULT 1.0)`,
  ],
  [
    'repo_index_locks',
    `CREATE TABLE IF NOT EXISTS repo_index_locks (repo_name TEXT PRIMARY KEY, holder_id TEXT NOT NULL, host TEXT NOT NULL DEFAULT '', acquired_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  ],
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
    } catch (e) {
      console.error(`[db] Failed to ensure critical table ${name}: ${e.message}`);
    }
  }
}

function _createTableIndexes(name, db) {
  const indexMap = {
    code_repos: ['CREATE INDEX IF NOT EXISTS idx_cr_branch ON code_repos(current_branch)'],
    code_files: [
      'CREATE INDEX IF NOT EXISTS idx_cf_repo ON code_files(repo_id)',
      'CREATE INDEX IF NOT EXISTS idx_cf_hash ON code_files(repo_id, content_hash)',
    ],
    code_file_diagnostics: [
      'CREATE INDEX IF NOT EXISTS idx_cfd_repo ON code_file_diagnostics(repo_id)',
      'CREATE INDEX IF NOT EXISTS idx_cfd_status ON code_file_diagnostics(repo_id, status)',
    ],
    code_symbols: [
      'CREATE INDEX IF NOT EXISTS idx_cs_repo ON code_symbols(repo_id)',
      'CREATE INDEX IF NOT EXISTS idx_cs_name ON code_symbols(name)',
      'CREATE INDEX IF NOT EXISTS idx_cs_file ON code_symbols(file_id)',
      'CREATE INDEX IF NOT EXISTS idx_cs_stable ON code_symbols(repo_id, stable_symbol_id)',
    ],
    code_imports: [
      'CREATE INDEX IF NOT EXISTS idx_ci_source ON code_imports(source_file_id)',
      'CREATE INDEX IF NOT EXISTS idx_ci_target ON code_imports(target_file_id)',
      'CREATE INDEX IF NOT EXISTS idx_ci_repo ON code_imports(repo_id)',
    ],
    code_calls: [
      'CREATE INDEX IF NOT EXISTS idx_cc_caller ON code_calls(caller_symbol_id)',
      'CREATE INDEX IF NOT EXISTS idx_cc_callee_name ON code_calls(repo_id, callee_name)',
      'CREATE INDEX IF NOT EXISTS idx_cc_callee ON code_calls(callee_symbol_id)',
    ],
    symbol_complexity: ['CREATE INDEX IF NOT EXISTS idx_sc_symbol ON symbol_complexity(symbol_id)'],
    churn_metrics: ['CREATE INDEX IF NOT EXISTS idx_cm_repo ON churn_metrics(repo_id)'],
    file_scope_bindings: [
      'CREATE INDEX IF NOT EXISTS idx_fsb_file_name ON file_scope_bindings(repo_id, file_id, name, line_start)',
      'CREATE INDEX IF NOT EXISTS idx_fsb_file_range ON file_scope_bindings(repo_id, file_id, line_start, line_end)',
      'CREATE INDEX IF NOT EXISTS idx_fsb_file_depth ON file_scope_bindings(file_id, scope_depth)',
    ],
    scope_resolution: [
      'CREATE INDEX IF NOT EXISTS idx_sr_binding ON scope_resolution(binding_id)',
      'CREATE INDEX IF NOT EXISTS idx_sr_symbol ON scope_resolution(resolved_symbol_id)',
      'CREATE INDEX IF NOT EXISTS idx_sr_status ON scope_resolution(status)',
      'CREATE INDEX IF NOT EXISTS idx_sr_pass ON scope_resolution(resolved_at_pass)',
    ],
    repo_index_locks: ['CREATE INDEX IF NOT EXISTS idx_repo_index_locks_acquired ON repo_index_locks(acquired_at)'],
    doc_sections: [
      'CREATE INDEX IF NOT EXISTS idx_ds_file ON doc_sections(file_id)',
      'CREATE INDEX IF NOT EXISTS idx_ds_parent ON doc_sections(parent_id)',
      'CREATE INDEX IF NOT EXISTS idx_ds_repo ON doc_sections(repo_id)',
      'CREATE INDEX IF NOT EXISTS idx_ds_level ON doc_sections(level)',
    ],
    doc_links: [
      'CREATE INDEX IF NOT EXISTS idx_dl_source ON doc_links(source_section_id)',
      'CREATE INDEX IF NOT EXISTS idx_dl_target ON doc_links(target_section_id)',
      'CREATE INDEX IF NOT EXISTS idx_dl_broken ON doc_links(is_broken)',
    ],
    doc_terms: [
      'CREATE INDEX IF NOT EXISTS idx_dt_term ON doc_terms(term)',
      'CREATE INDEX IF NOT EXISTS idx_dt_repo ON doc_terms(repo_id)',
    ],
    doc_code_blocks: [
      'CREATE INDEX IF NOT EXISTS idx_dcb_section ON doc_code_blocks(section_id)',
      'CREATE INDEX IF NOT EXISTS idx_dcb_lang ON doc_code_blocks(lang)',
    ],
  };
  for (const sql of indexMap[name] || []) {
    try {
      db.exec(sql);
    } catch {}
  }
}

/* ── migrations ───────────────────────────────────────────── */

function runMigrations() {
  let version = 0;
  try {
    const rows = sqlJson('PRAGMA user_version');
    version = rows.length > 0 ? rows[0].user_version || 0 : 0;
  } catch (e) {
    console.error('[db] Failed to read user_version:', e.message);
  }

  if (version >= 24) {
    return { migrated: false, version };
  }

  const migrations = [
    { to: 2, run: runMigrationV2 },
    { to: 3, run: runMigrationV3 },
    { to: 4, run: runMigrationV4 },
    { to: 5, run: runMigrationV5 },
    { to: 6, run: runMigrationV6 },
    { to: 7, run: runMigrationV7 },
    { to: 8, run: runMigrationV8 },
    { to: 9, run: runMigrationV9 },
    { to: 10, run: runMigrationV10 },
    { to: 11, run: runMigrationV11 },
    { to: 12, run: runMigrationV12 },
    { to: 13, run: runMigrationV13 },
    { to: 14, run: runMigrationV14 },
    { to: 15, run: runMigrationV15 },
    { to: 16, run: runMigrationV16 },
    { to: 17, run: runMigrationV17 },
    { to: 18, run: runMigrationV18 },
    { to: 19, run: runMigrationV19 },
    { to: 20, run: runMigrationV20 },
    { to: 21, run: runMigrationV21 },
    { to: 22, run: runMigrationV22 },
    { to: 23, run: runMigrationV23 },
    { to: 24, run: runMigrationV24 },
  ];

  const fromVersion = version;
  const pending = migrations.filter((m) => version < m.to);
  for (const migration of pending) {
    const errors = migration.run();
    if (errors.length > 0) {
      console.error(`[db] Migration to V${migration.to} failed (${errors.length} errors):`);
      for (const e of errors) {
        console.error(`  - ${e}`);
      }
      // Don't advance version — stop here
      return { migrated: false, fromVersion, toVersion: version, errors };
    }
    // Verify version bump succeeded
    const rows = sqlJson('PRAGMA user_version');
    version = rows.length > 0 ? rows[0].user_version || 0 : 0;
    if (version < migration.to) {
      console.error(`[db] Migration V${migration.to} did not advance user_version (still ${version})`);
      return {
        migrated: false,
        fromVersion,
        toVersion: version,
        errors: [`V${migration.to}: user_version not advanced`],
      };
    }
  }

  return { migrated: true, fromVersion, toVersion: version };
}

function runMigrationV2() {
  const errors = [];
  try {
    withTransaction(() => {
      const stmts = [
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
      for (const s of stmts) {
        sqlRaw(s);
      }
      sqlRaw('PRAGMA user_version = 2');
    });
  } catch (e) {
    errors.push(`V2: ${e.message}`);
  }
  return errors;
}

function runMigrationV3() {
  const errors = [];
  try {
    withTransaction(() => {
      const stmts = [
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
      for (const s of stmts) {
        sqlRaw(s);
      }
      sqlRaw(`CREATE VIRTUAL TABLE IF NOT EXISTS code_symbols_fts USING fts5(
        name, kind, signature, docstring, file_path, body_preview, content=code_symbols, content_rowid=id)`);
      sqlRaw('PRAGMA user_version = 3');
    });
  } catch (e) {
    errors.push(`V3: ${e.message}`);
  }
  return errors;
}

function runMigrationV4() {
  const errors = [];
  try {
    // Check table existence BEFORE transaction — SQLite fails inside tx after error
    const hasObs = sqlJson("SELECT name FROM sqlite_master WHERE type='table' AND name='observations'").length > 0;
    const hasSession = sqlJson("SELECT name FROM sqlite_master WHERE type='table' AND name='session_log'").length > 0;

    withTransaction(() => {
      sqlRaw(`CREATE TABLE IF NOT EXISTS workspaces (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), archived_at TEXT)`);
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_ws_active ON workspaces(archived_at) WHERE archived_at IS NULL');
      // Migrate existing projects only if source tables exist
      if (hasObs) {
        const projects = sqlJson(
          "SELECT DISTINCT project FROM observations WHERE project IS NOT NULL AND project != '' AND deleted_at IS NULL",
        );
        for (const r of projects) {
          sqlRun('INSERT OR IGNORE INTO workspaces (name) VALUES (?)', [r.project]);
        }
      }
      if (hasSession) {
        const sp = sqlJson("SELECT DISTINCT project FROM session_log WHERE project IS NOT NULL AND project != ''");
        for (const r of sp) {
          sqlRun('INSERT OR IGNORE INTO workspaces (name) VALUES (?)', [r.project]);
        }
      }
      sqlRaw('PRAGMA user_version = 4');
    });
  } catch (e) {
    errors.push(`V4: ${e.message}`);
  }
  return errors;
}

function runMigrationV5() {
  const errors = [];
  try {
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    // Newer schema indexes may reference columns added after V5. Add them first
    // When migrating an older database so the schema replay remains idempotent.
    for (const [table, column, definition] of [
      ['code_repos', 'current_branch', 'TEXT'],
      ['code_repos', 'base_head', 'TEXT'],
      ['code_files', 'mtime_ns', 'INTEGER'],
      ['code_symbols', 'stable_symbol_id', "TEXT DEFAULT ''"],
      ['code_symbols', 'content_hash', "TEXT DEFAULT ''"],
      ['code_symbols', 'summary', "TEXT DEFAULT ''"],
      ['code_symbols', 'decorators_json', "TEXT DEFAULT '[]'"],
      ['code_symbols', 'keywords_json', "TEXT DEFAULT '[]'"],
      ['code_symbols', 'call_references_json', "TEXT DEFAULT '[]'"],
      ['code_symbols', 'ecosystem_context', "TEXT DEFAULT ''"],
    ]) {
      try {
        sqlRaw(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      } catch (err) {
        if (!/duplicate column|no such table/i.test(err.message)) {
          throw err;
        }
      }
    }
    let schemaExecOk = true;
    try {
      _db.exec(schema);
    } catch {
      schemaExecOk = false;
      const stmts = schema
        .split(/;\s*\n/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !/^\s*PRAGMA/i.test(s));
      for (const s of stmts) {
        try {
          sqlRaw(s);
        } catch (inner) {
          if (!/already exists|duplicate column/i.test(inner.message)) {
            errors.push(`V5 statement: ${inner.message}`);
          }
        }
      }
      if (errors.length === 0) {
        schemaExecOk = true;
      }
    }
    if (schemaExecOk) {
      sqlRaw('PRAGMA user_version = 5');
    } else {
      errors.push('V5: schema exec failed, not advancing user_version');
    }
  } catch (e) {
    errors.push(`V5: ${e.message}`);
  }
  return errors;
}

function runMigrationV6() {
  const errors = [];
  try {
    withTransaction(() => {
      try {
        sqlRaw('ALTER TABLE code_repos ADD COLUMN head_commit TEXT');
      } catch (e) {
        // Column may already exist — that's fine
        if (!/duplicate column/i.test(e.message)) {
          throw e;
        }
      }
      sqlRaw('PRAGMA user_version = 6');
    });
  } catch (e) {
    errors.push(`V6: ${e.message}`);
  }
  return errors;
}

function runMigrationV7() {
  const errors = [];
  try {
    const hasTable = sqlJson("SELECT name FROM sqlite_master WHERE type='table' AND name='code_calls'").length > 0;
    if (!hasTable) {
      sqlRaw('PRAGMA user_version = 7');
      return errors;
    }
    withTransaction(() => {
      sqlRaw('ALTER TABLE code_calls RENAME TO code_calls_old');
      sqlRaw(`CREATE TABLE code_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id INTEGER NOT NULL REFERENCES code_repos(id) ON DELETE CASCADE,
        caller_symbol_id INTEGER NOT NULL REFERENCES code_symbols(id) ON DELETE CASCADE,
        callee_name TEXT NOT NULL,
        callee_symbol_id INTEGER REFERENCES code_symbols(id) ON DELETE SET NULL,
        confidence REAL NOT NULL DEFAULT 1.0,
        line_number INTEGER,
        UNIQUE(repo_id, caller_symbol_id, callee_name)
      )`);
      sqlRaw(`INSERT OR IGNORE INTO code_calls (repo_id, caller_symbol_id, callee_name, callee_symbol_id, confidence, line_number)
        SELECT repo_id, caller_symbol_id, callee_name, callee_symbol_id, confidence, MIN(line_number)
        FROM code_calls_old GROUP BY repo_id, caller_symbol_id, callee_name`);
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_cc_caller ON code_calls(caller_symbol_id)');
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_cc_callee_name ON code_calls(repo_id, callee_name)');
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_cc_callee ON code_calls(callee_symbol_id)');
      sqlRaw('DROP TABLE code_calls_old');
      sqlRaw('PRAGMA user_version = 7');
    });
  } catch (e) {
    errors.push(`V7: ${e.message}`);
  }
  return errors;
}

function runMigrationV9() {
  const errors = [];
  const addColumn = (table, column, definition) => {
    try {
      sqlRaw(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } catch (e) {
      if (!/duplicate column/i.test(e.message)) {
        throw e;
      }
    }
  };
  try {
    withTransaction(() => {
      addColumn('code_repos', 'current_branch', 'TEXT');
      addColumn('code_repos', 'base_head', 'TEXT');
      addColumn('code_files', 'mtime_ns', 'INTEGER');
      addColumn('code_symbols', 'stable_symbol_id', "TEXT DEFAULT ''");
      addColumn('code_symbols', 'content_hash', "TEXT DEFAULT ''");
      addColumn('code_symbols', 'summary', "TEXT DEFAULT ''");
      addColumn('code_symbols', 'decorators_json', "TEXT DEFAULT '[]'");
      addColumn('code_symbols', 'keywords_json', "TEXT DEFAULT '[]'");
      addColumn('code_symbols', 'call_references_json', "TEXT DEFAULT '[]'");
      addColumn('code_symbols', 'ecosystem_context', "TEXT DEFAULT ''");
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_cr_branch ON code_repos(current_branch)');
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_cf_hash ON code_files(repo_id, content_hash)');
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_cs_stable ON code_symbols(repo_id, stable_symbol_id)');
      sqlRaw('PRAGMA user_version = 9');
    });
  } catch (e) {
    errors.push(`V9: ${e.message}`);
  }
  return errors;
}

function runMigrationV10() {
  const errors = [];
  try {
    withTransaction(() => {
      sqlRaw(`CREATE TABLE IF NOT EXISTS file_scope_bindings (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id         INTEGER NOT NULL REFERENCES code_repos(id) ON DELETE CASCADE,
        file_id         INTEGER NOT NULL REFERENCES code_files(id) ON DELETE CASCADE,
        name            TEXT NOT NULL,
        kind            TEXT NOT NULL,
        origin          TEXT NOT NULL,
        source_file_id  INTEGER NULL REFERENCES code_files(id) ON DELETE SET NULL,
        source_name     TEXT NULL,
        line_start      INTEGER NOT NULL,
        line_end        INTEGER NOT NULL,
        scope_depth     INTEGER NOT NULL DEFAULT 0,
        byte_start      INTEGER NULL,
        byte_end        INTEGER NULL,
        first_seen_pass INTEGER NOT NULL DEFAULT 0
      )`);
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_fsb_file_name ON file_scope_bindings(repo_id, file_id, name, line_start)');
      sqlRaw(
        'CREATE INDEX IF NOT EXISTS idx_fsb_file_range ON file_scope_bindings(repo_id, file_id, line_start, line_end)',
      );
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_fsb_file_depth ON file_scope_bindings(file_id, scope_depth)');

      sqlRaw(`CREATE TABLE IF NOT EXISTS scope_resolution (
        binding_id          INTEGER PRIMARY KEY REFERENCES file_scope_bindings(id) ON DELETE CASCADE,
        resolved_symbol_id  INTEGER NULL REFERENCES code_symbols(id) ON DELETE SET NULL,
        resolved_file_id    INTEGER NULL REFERENCES code_files(id) ON DELETE SET NULL,
        status              TEXT NOT NULL,
        resolved_at_pass    INTEGER NOT NULL,
        confidence          REAL NOT NULL DEFAULT 1.0
      )`);
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_sr_binding ON scope_resolution(binding_id)');
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_sr_symbol ON scope_resolution(resolved_symbol_id)');
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_sr_status ON scope_resolution(status)');
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_sr_pass ON scope_resolution(resolved_at_pass)');
      sqlRaw('PRAGMA user_version = 10');
    });
  } catch (e) {
    errors.push(`V10: ${e.message}`);
  }
  return errors;
}

function runMigrationV11() {
  const errors = [];
  try {
    withTransaction(() => {
      const stmts = [
        `CREATE TABLE IF NOT EXISTS missions (
          id TEXT PRIMARY KEY,
          description TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'planning',
          config_json TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`,
        `CREATE TABLE IF NOT EXISTS milestones (
          id TEXT PRIMARY KEY,
          mission_id TEXT NOT NULL REFERENCES missions(id),
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          order_index INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'planned',
          validation_contract_id TEXT,
          retries INTEGER NOT NULL DEFAULT 0,
          rescopes INTEGER NOT NULL DEFAULT 0
        )`,
        `CREATE TABLE IF NOT EXISTS working_units (
          id TEXT PRIMARY KEY,
          milestone_id TEXT NOT NULL REFERENCES milestones(id),
          description TEXT NOT NULL DEFAULT '',
          declared_paths TEXT NOT NULL DEFAULT '[]',
          declared_modules TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'spawned',
          task_branch TEXT NOT NULL DEFAULT '',
          worktree_path TEXT NOT NULL DEFAULT '',
          session_id TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS validation_contracts (
          id TEXT PRIMARY KEY,
          milestone_id TEXT NOT NULL REFERENCES milestones(id),
          version INTEGER NOT NULL DEFAULT 1,
          content TEXT NOT NULL DEFAULT '{}',
          supersedes TEXT,
          superseded_by TEXT,
          rescope_event_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`,
        `CREATE TABLE IF NOT EXISTS validation_verdicts (
          id TEXT PRIMARY KEY,
          milestone_id TEXT NOT NULL REFERENCES milestones(id),
          contract_id TEXT NOT NULL REFERENCES validation_contracts(id),
          validator_type TEXT NOT NULL,
          session_id TEXT NOT NULL,
          verdict TEXT NOT NULL,
          classification TEXT,
          findings TEXT NOT NULL DEFAULT '',
          failed_unit_ids TEXT NOT NULL DEFAULT '[]',
          timestamp TEXT NOT NULL DEFAULT (datetime('now'))
        )`,
        `CREATE TABLE IF NOT EXISTS broadcasts (
          id TEXT PRIMARY KEY,
          mission_id TEXT NOT NULL REFERENCES missions(id),
          author_id TEXT NOT NULL,
          author_type TEXT NOT NULL,
          category TEXT NOT NULL DEFAULT 'info',
          title TEXT NOT NULL DEFAULT '',
          content TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'active',
          ttl INTEGER,
          expires_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`,
        `CREATE TABLE IF NOT EXISTS research_findings (
          id TEXT PRIMARY KEY,
          mission_id TEXT NOT NULL REFERENCES missions(id),
          author_id TEXT NOT NULL,
          domain TEXT NOT NULL DEFAULT '[]',
          title TEXT NOT NULL DEFAULT '',
          content TEXT NOT NULL DEFAULT '',
          relevance TEXT NOT NULL DEFAULT 'medium',
          status TEXT NOT NULL DEFAULT 'unverified',
          verified_task_id TEXT,
          ttl INTEGER,
          expires_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`,
        `CREATE TABLE IF NOT EXISTS agent_sessions (
          session_id TEXT PRIMARY KEY,
          agent_type TEXT NOT NULL,
          mission_id TEXT NOT NULL REFERENCES missions(id),
          milestone_id TEXT REFERENCES milestones(id),
          unit_id TEXT REFERENCES working_units(id),
          spawned_at TEXT NOT NULL DEFAULT (datetime('now')),
          terminated_at TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS cost_entries (
          id TEXT PRIMARY KEY,
          mission_id TEXT NOT NULL REFERENCES missions(id),
          agent_session_id TEXT NOT NULL,
          model TEXT NOT NULL,
          prompt_tokens INTEGER NOT NULL DEFAULT 0,
          completion_tokens INTEGER NOT NULL DEFAULT 0,
          cost REAL NOT NULL DEFAULT 0,
          timestamp TEXT NOT NULL DEFAULT (datetime('now'))
        )`,
        `CREATE TABLE IF NOT EXISTS rescope_events (
          id TEXT PRIMARY KEY,
          milestone_id TEXT NOT NULL REFERENCES milestones(id),
          contract_id TEXT NOT NULL REFERENCES validation_contracts(id),
          reason TEXT NOT NULL DEFAULT '',
          previous_scope TEXT NOT NULL DEFAULT '',
          new_scope TEXT NOT NULL DEFAULT '',
          timestamp TEXT NOT NULL DEFAULT (datetime('now'))
        )`,
        'CREATE INDEX IF NOT EXISTS idx_aurex_milestones_mission ON milestones(mission_id)',
        'CREATE INDEX IF NOT EXISTS idx_aurex_units_milestone ON working_units(milestone_id)',
        'CREATE INDEX IF NOT EXISTS idx_aurex_contracts_milestone ON validation_contracts(milestone_id)',
        'CREATE INDEX IF NOT EXISTS idx_aurex_verdicts_milestone ON validation_verdicts(milestone_id)',
        'CREATE INDEX IF NOT EXISTS idx_aurex_broadcasts_mission ON broadcasts(mission_id)',
        'CREATE INDEX IF NOT EXISTS idx_aurex_findings_mission ON research_findings(mission_id)',
        'CREATE INDEX IF NOT EXISTS idx_aurex_sessions_mission ON agent_sessions(mission_id)',
        'CREATE INDEX IF NOT EXISTS idx_aurex_sessions_milestone ON agent_sessions(milestone_id)',
        'CREATE INDEX IF NOT EXISTS idx_aurex_costs_mission ON cost_entries(mission_id)',
        'CREATE INDEX IF NOT EXISTS idx_aurex_rescope_milestone ON rescope_events(milestone_id)',
      ];
      for (const s of stmts) {
        sqlRaw(s);
      }
      sqlRaw('PRAGMA user_version = 11');
    });
  } catch (e) {
    errors.push(`V11: ${e.message}`);
  }
  return errors;
}

function runMigrationV12() {
  const errors = [];
  try {
    withTransaction(() => {
      sqlRaw(`CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id),
        trigger TEXT NOT NULL,
        milestone_id TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        decision TEXT,
        guidance TEXT,
        reason TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT
      )`);
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_checkpoints_mission ON checkpoints(mission_id)');
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_checkpoints_status ON checkpoints(status)');
      sqlRaw('PRAGMA user_version = 12');
    });
  } catch (e) {
    errors.push(`V12: ${e.message}`);
  }
  return errors;
}

function runMigrationV8() {
  const errors = [];
  try {
    withTransaction(() => {
      sqlRaw(`CREATE TABLE IF NOT EXISTS code_file_diagnostics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id INTEGER NOT NULL REFERENCES code_repos(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT DEFAULT '',
        symbol_count INTEGER DEFAULT 0,
        content_hash TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(repo_id, file_path)
      )`);
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_cfd_repo ON code_file_diagnostics(repo_id)');
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_cfd_status ON code_file_diagnostics(repo_id, status)');
      sqlRaw('PRAGMA user_version = 8');
    });
  } catch (e) {
    errors.push(`V8: ${e.message}`);
  }
  return errors;
}
function runMigrationV13() {
  const errors = [];
  try {
    withTransaction(() => {
      sqlRaw(`CREATE TABLE IF NOT EXISTS code_relations (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id             INTEGER NOT NULL REFERENCES code_repos(id) ON DELETE CASCADE,
        source_symbol_id    INTEGER REFERENCES code_symbols(id) ON DELETE CASCADE,
        target_symbol_id    INTEGER REFERENCES code_symbols(id) ON DELETE CASCADE,
        source_file_id      INTEGER REFERENCES code_files(id) ON DELETE CASCADE,
        target_file_id      INTEGER REFERENCES code_files(id) ON DELETE CASCADE,
        kind                TEXT NOT NULL,
        weight              REAL NOT NULL DEFAULT 1.0,
        line_number         INTEGER,
        UNIQUE(repo_id, source_symbol_id, target_symbol_id, source_file_id, target_file_id, kind)
      )`);
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_cr_source_sym ON code_relations(source_symbol_id)');
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_cr_target_sym ON code_relations(target_symbol_id)');
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_cr_source_file ON code_relations(source_file_id)');
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_cr_target_file ON code_relations(target_file_id)');
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_cr_repo_kind ON code_relations(repo_id, kind)');
      sqlRaw(`CREATE TABLE IF NOT EXISTS file_cochange (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id         INTEGER NOT NULL REFERENCES code_repos(id) ON DELETE CASCADE,
        file_a_id       INTEGER NOT NULL REFERENCES code_files(id) ON DELETE CASCADE,
        file_b_id       INTEGER NOT NULL REFERENCES code_files(id) ON DELETE CASCADE,
        co_commit_count INTEGER NOT NULL DEFAULT 0,
        strength        REAL NOT NULL DEFAULT 0,
        window_days     INTEGER NOT NULL DEFAULT 90,
        UNIQUE(repo_id, file_a_id, file_b_id)
      )`);
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_fcc_a ON file_cochange(file_a_id)');
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_fcc_b ON file_cochange(file_b_id)');
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_fcc_repo ON file_cochange(repo_id)');
      sqlRaw('PRAGMA user_version = 13');
    });
  } catch (e) {
    errors.push(`V13: ${e.message}`);
  }
  return errors;
}

function runMigrationV14() {
  const errors = [];
  try {
    withTransaction(() => {
      sqlRaw(`CREATE TABLE IF NOT EXISTS observation_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
        field TEXT NOT NULL,
        old_value TEXT NOT NULL DEFAULT '',
        new_value TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_ov_memory ON observation_versions(memory_id)');
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_ov_created ON observation_versions(created_at DESC)');
      sqlRaw('PRAGMA user_version = 14');
    });
  } catch (e) {
    errors.push(`V14: ${e.message}`);
  }
  return errors;
}

function runMigrationV15() {
  const errors = [];
  try {
    withTransaction(() => {
      sqlRaw(`CREATE TABLE IF NOT EXISTS symbol_metadata (
        symbol_id INTEGER PRIMARY KEY REFERENCES code_symbols(id) ON DELETE CASCADE,
        intent TEXT NOT NULL DEFAULT '',
        behavior_summary TEXT NOT NULL DEFAULT '',
        constraints TEXT NOT NULL DEFAULT '[]',
        failure_history TEXT NOT NULL DEFAULT '[]',
        replacement_of TEXT NOT NULL DEFAULT '',
        enriched_at TEXT NOT NULL DEFAULT (datetime('now')),
        enrichment_source TEXT NOT NULL DEFAULT ''
      )`);
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_sm_symbol ON symbol_metadata(symbol_id)');

      sqlRaw(`CREATE TABLE IF NOT EXISTS duplicate_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id INTEGER NOT NULL REFERENCES code_repos(id) ON DELETE CASCADE,
        intent TEXT NOT NULL DEFAULT '',
        risk TEXT NOT NULL DEFAULT 'low',
        detection_type TEXT NOT NULL DEFAULT 'structural',
        recommendation TEXT NOT NULL DEFAULT '',
        fingerprint_hash TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_dg_repo ON duplicate_groups(repo_id)');
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_dg_hash ON duplicate_groups(repo_id, fingerprint_hash)');

      sqlRaw(`CREATE TABLE IF NOT EXISTS duplicate_instances (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER NOT NULL REFERENCES duplicate_groups(id) ON DELETE CASCADE,
        symbol_id INTEGER NOT NULL REFERENCES code_symbols(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        symbol_name TEXT NOT NULL,
        line_start INTEGER NOT NULL DEFAULT 0
      )`);
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_di_group ON duplicate_instances(group_id)');
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_di_symbol ON duplicate_instances(symbol_id)');

      sqlRaw(`CREATE TABLE IF NOT EXISTS audit_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id INTEGER NOT NULL REFERENCES code_repos(id) ON DELETE CASCADE,
        task TEXT NOT NULL DEFAULT '',
        files_changed TEXT NOT NULL DEFAULT '[]',
        violations TEXT NOT NULL DEFAULT '[]',
        risk TEXT NOT NULL DEFAULT 'low',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_ar_repo ON audit_runs(repo_id)');
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_ar_created ON audit_runs(created_at DESC)');

      sqlRaw('PRAGMA user_version = 15');
    });
  } catch (e) {
    errors.push(`V15: ${e.message}`);
  }
  return errors;
}

function runMigrationV16() {
  const errors = [];
  try {
    withTransaction(() => {
      // Runtime hotness per symbol (from Istanbul coverage)
      sqlRaw(`CREATE TABLE IF NOT EXISTS runtime_symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id INTEGER NOT NULL REFERENCES code_repos(id) ON DELETE CASCADE,
        symbol_id INTEGER REFERENCES code_symbols(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        function_name TEXT NOT NULL DEFAULT '',
        hit_count INTEGER NOT NULL DEFAULT 0,
        line_start INTEGER,
        line_end INTEGER,
        traffic TEXT NOT NULL DEFAULT 'unknown',
        last_seen TEXT,
        ingested_at TEXT NOT NULL DEFAULT (datetime('now')),
        source_file TEXT NOT NULL DEFAULT '',
        UNIQUE(repo_id, file_path, function_name)
      )`);
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_rs_repo ON runtime_symbols(repo_id)');
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_rs_traffic ON runtime_symbols(traffic)');

      // Stale feature flags (one-sided branches detected in source)
      sqlRaw(`CREATE TABLE IF NOT EXISTS stale_flags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id INTEGER NOT NULL REFERENCES code_repos(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        line_number INTEGER NOT NULL,
        flag_name TEXT NOT NULL,
        branch_type TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '',
        detected_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_sf_repo ON stale_flags(repo_id)');
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_sf_traffic ON stale_flags(file_path)');

      sqlRaw('PRAGMA user_version = 16');
    });
  } catch (e) {
    errors.push(`V16: ${e.message}`);
  }
  return errors;
}

function runMigrationV17() {
  const errors = [];
  try {
    withTransaction(() => {
      // ALTER TABLE ADD COLUMN is not idempotent in SQLite — swallow the
      // "duplicate column" error so re-running V17 against a DB that already
      // got the column via schema.sql is a no-op (mirrors V5/V6 pattern).
      try {
        sqlRaw('ALTER TABLE observations ADD COLUMN expires_at TEXT DEFAULT NULL');
      } catch (e) {
        if (!/duplicate column/i.test(e.message)) throw e;
      }
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_obs_expires ON observations(expires_at) WHERE expires_at IS NOT NULL');
      sqlRaw('PRAGMA user_version = 17');
    });
  } catch (e) {
    errors.push(`V17: ${e.message}`);
  }
  return errors;
}

function runMigrationV18() {
  const errors = [];
  try {
    withTransaction(() => {
      // index_jobs backs the async code-indexing feature. The worker writes
      // progress here while the CLI/extension tool reads status from the
      // same table; WAL mode (already enabled) lets both proceed in parallel.
      sqlRaw(`CREATE TABLE IF NOT EXISTS index_jobs (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         repo_name TEXT NOT NULL,
         mode TEXT NOT NULL DEFAULT 'full',
         status TEXT NOT NULL DEFAULT 'pending',
         files_total INTEGER NOT NULL DEFAULT 0,
         files_done INTEGER NOT NULL DEFAULT 0,
         current_file TEXT,
         language_breakdown TEXT NOT NULL DEFAULT '{}',
         started_at TEXT NOT NULL DEFAULT (datetime('now')),
         completed_at TEXT,
         error TEXT
       )`);
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_index_jobs_status ON index_jobs(status)');
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_index_jobs_repo ON index_jobs(repo_name, started_at DESC)');
      sqlRaw('PRAGMA user_version = 18');
    });
  } catch (e) {
    errors.push(`V18: ${e.message}`);
  }
  return errors;
}

function runMigrationV19() {
  const errors = [];
  try {
    withTransaction(() => {
      sqlRaw(`CREATE TABLE IF NOT EXISTS todo_ledgers (
        mission_id TEXT PRIMARY KEY,
        mission_title TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'planning',
        source_mission TEXT NOT NULL DEFAULT '',
        planner_summary TEXT NOT NULL DEFAULT '',
        acceptance_criteria TEXT NOT NULL DEFAULT '[]',
        constraints_json TEXT NOT NULL DEFAULT '[]',
        assumptions TEXT NOT NULL DEFAULT '[]',
        human_questions TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      sqlRaw(`CREATE TABLE IF NOT EXISTS todo_items (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES todo_ledgers(mission_id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        type TEXT NOT NULL DEFAULT 'implementation',
        priority TEXT NOT NULL DEFAULT 'medium',
        depends_on TEXT NOT NULL DEFAULT '[]',
        goal TEXT NOT NULL DEFAULT '',
        scope_json TEXT NOT NULL DEFAULT '{"in":[],"out":[]}',
        likely_files TEXT NOT NULL DEFAULT '[]',
        lapis_context_query TEXT NOT NULL DEFAULT '',
        acceptance_criteria TEXT NOT NULL DEFAULT '[]',
        validation_criteria TEXT NOT NULL DEFAULT '[]',
        test_commands TEXT NOT NULL DEFAULT '[]',
        risk_level TEXT NOT NULL DEFAULT 'medium',
        worker_instructions TEXT NOT NULL DEFAULT '[]',
        validator_instructions TEXT NOT NULL DEFAULT '[]',
        escalation_rules TEXT NOT NULL DEFAULT '[]',
        evidence_json TEXT NOT NULL DEFAULT '{"branch":null,"commits":[],"changedFiles":[],"testsRun":[],"testResults":[],"validatorVerdict":null,"notes":[]}',
        confidence TEXT NOT NULL DEFAULT 'medium',
        assigned_worker_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      sqlRaw(`CREATE TABLE IF NOT EXISTS todo_events (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES todo_ledgers(mission_id) ON DELETE CASCADE,
        todo_id TEXT REFERENCES todo_items(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        actor_id TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_todo_ledgers_status ON todo_ledgers(status)');
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_todo_items_mission ON todo_items(mission_id)');
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_todo_items_status ON todo_items(status)');
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_todo_items_context ON todo_items(lapis_context_query)');
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_todo_events_mission ON todo_events(mission_id)');
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_todo_events_todo ON todo_events(todo_id)');
      sqlRaw('PRAGMA user_version = 19');
    });
  } catch (e) {
    errors.push(`V19: ${e.message}`);
  }
  return errors;
}

function runMigrationV20() {
  const errors = [];
  try {
    withTransaction(() => {
      // Add rescope_guidance to checkpoints so user-initiated re-plan
      // requests can be persisted and read back by the polling runner.
      // Nullable; old rows get NULL.
      try {
        sqlRaw('ALTER TABLE checkpoints ADD COLUMN rescope_guidance TEXT');
      } catch (e) {
        if (!/duplicate column/i.test(e.message)) throw e;
      }
      sqlRaw('PRAGMA user_version = 20');
    });
  } catch (e) {
    errors.push(`V20: ${e.message}`);
  }
  return errors;
}

function runMigrationV21() {
  const errors = [];
  try {
    withTransaction(() => {
      sqlRaw(`
        CREATE TABLE IF NOT EXISTS mission_compression_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
          trigger TEXT NOT NULL,
          summary TEXT NOT NULL DEFAULT '',
          tokens_saved INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_compression_log_mission ON mission_compression_log(mission_id)');
      sqlRaw('PRAGMA user_version = 21');
    });
  } catch (e) {
    errors.push(`V21: ${e.message}`);
  }
  return errors;
}

function runMigrationV22() {
  const errors = [];
  try {
    withTransaction(() => {
      sqlRaw(`
        CREATE TABLE IF NOT EXISTS handoffs (
          id                         TEXT PRIMARY KEY,
          unit_id                    TEXT NOT NULL,
          mission_id                 TEXT NOT NULL DEFAULT '',
          milestone_id               TEXT NOT NULL DEFAULT '',
          feature_name               TEXT NOT NULL DEFAULT '',
          description                TEXT NOT NULL DEFAULT '',
          implemented                TEXT NOT NULL DEFAULT '',
          remaining                  TEXT NOT NULL DEFAULT '',
          rationale                  TEXT NOT NULL DEFAULT '',
          assumptions                TEXT NOT NULL DEFAULT '',
          unresolved_uncertainties   TEXT NOT NULL DEFAULT '',
          errors_encountered         TEXT NOT NULL DEFAULT '',
          commands_run               TEXT NOT NULL DEFAULT '[]',
          git_commit_hash            TEXT NOT NULL DEFAULT '',
          status                     TEXT NOT NULL DEFAULT 'accepted',
          created_at                 TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at                 TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_handoffs_unit      ON handoffs(unit_id)');
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_handoffs_milestone ON handoffs(milestone_id)');
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_handoffs_mission   ON handoffs(mission_id)');
      sqlRaw('PRAGMA user_version = 22');
    });
  } catch (e) {
    errors.push(`V22: ${e.message}`);
  }
  return errors;
}

function runMigrationV23() {
  const errors = [];
  try {
    withTransaction(() => {
      sqlRaw(`CREATE TABLE IF NOT EXISTS repo_index_locks (
        repo_name   TEXT PRIMARY KEY,
        holder_id   TEXT NOT NULL,
        host        TEXT NOT NULL DEFAULT '',
        acquired_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      sqlRaw('CREATE INDEX IF NOT EXISTS idx_repo_index_locks_acquired ON repo_index_locks(acquired_at)');
      sqlRaw('PRAGMA user_version = 23');
    });
  } catch (e) {
    errors.push(`V23: ${e.message}`);
  }
  return errors;
}

function runMigrationV24() {
  const errors = [];
  try {
    withTransaction(() => {
      const cols = sqlJson('PRAGMA table_info(file_scope_bindings)');
      const hasSourceModule = cols.some((c) => c.name === 'source_module');
      if (!hasSourceModule) {
        sqlRaw('ALTER TABLE file_scope_bindings ADD COLUMN source_module TEXT NULL');
      }
      sqlRaw('PRAGMA user_version = 24');
    });
  } catch (e) {
    errors.push(`V24: ${e.message}`);
  }
  return errors;
}

/* ── utilities ────────────────────────────────────────────── */

function jsonOut(obj) {
  console.log(JSON.stringify(obj, null, 2));
}
function jsonErrNoExit(msg) {
  return { error: msg };
}
function jsonErr(msg) {
  throw new MemoryError(msg);
}

function parseArgs(argv) {
  const args = { _: [] };
  let key = null;
  for (const arg of argv.slice(3)) {
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        args[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
        key = null;
      } else {
        key = arg.slice(2);
        args[key] = true;
      }
    } else if (key) {
      args[key] = arg;
      key = null;
    } else {
      args._.push(arg);
    }
  }
  return args;
}

/* ── exports ───────────────────────────────────────────────── */
module.exports = {
  get DB_PATH() {
    return getConfig().db_path;
  },
  SCHEMA_PATH,
  HOME,
  getDb,
  getEngine,
  getDbPath,
  resetDb,
  createDb,
  sqlJson,
  sqlRun,
  sqlRaw,
  ensureDb,
  withTransaction,
  retryOnBusy,
  jsonOut,
  jsonErr,
  jsonErrNoExit,
  parseArgs,
  MemoryError,
};
