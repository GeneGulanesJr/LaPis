-- @genegulanesjr/memory-layer — Unified Schema v4
-- Single database: ~/.pi/memory/memory.db
-- Zero external dependencies. FTS5 search, trust scoring, dedup, recall ranking.
--
-- Feature ownership map (Issue #77):
--   platform/storage: database lifecycle, PRAGMAs, migration user_version.
--   memory repository: workspaces, observations, observation FTS, prompts, sessions, relations, recall_log.
--   code-index repository: code_repos, code_files, code_symbols, code FTS, imports, calls, complexity.
--   doc-index repository: doc_repos, doc_files, doc_sections, doc FTS, links, terms, code blocks.
--   trust-sync repository: symbol_links and trust_adjustments because they bridge memories and code symbols.
--   analytics repository: read-only aggregate queries across feature-owned tables.
PRAGMA user_version = 11;

-- ═══════════════════════════════════════════════════════════
-- MEMORY REPOSITORY: WORKSPACES  (v4 — formal project isolation)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS workspaces (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ws_active ON workspaces(archived_at) WHERE archived_at IS NULL;

-- ═══════════════════════════════════════════════════════════
-- MEMORY REPOSITORY: OBSERVATIONS
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS observations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT    NOT NULL,
  type       TEXT    NOT NULL,
  title      TEXT    NOT NULL,
  content    TEXT    NOT NULL,
  project    TEXT,
  scope      TEXT    NOT NULL DEFAULT 'project',
  topic_key  TEXT,
  expires_at TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_obs_session  ON observations(session_id);
CREATE INDEX IF NOT EXISTS idx_obs_type     ON observations(type);
CREATE INDEX IF NOT EXISTS idx_obs_project  ON observations(project);
CREATE INDEX IF NOT EXISTS idx_obs_scope     ON observations(scope);
CREATE INDEX IF NOT EXISTS idx_obs_topic    ON observations(topic_key, project, scope, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_obs_created  ON observations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_obs_deleted  ON observations(deleted_at);
CREATE INDEX IF NOT EXISTS idx_obs_expires ON observations(expires_at) WHERE expires_at IS NOT NULL;

-- FTS5 for observations
CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
  title,
  content,
  type,
  project,
  topic_key,
  content='observations',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS obs_fts_insert AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, title, content, type, project, topic_key)
  VALUES (new.id, new.title, new.content, new.type, new.project, new.topic_key);
END;

CREATE TRIGGER IF NOT EXISTS obs_fts_delete AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, content, type, project, topic_key)
  VALUES ('delete', old.id, old.title, old.content, old.type, old.project, old.topic_key);
END;

CREATE TRIGGER IF NOT EXISTS obs_fts_update AFTER UPDATE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, content, type, project, topic_key)
  VALUES ('delete', old.id, old.title, old.content, old.type, old.project, old.topic_key);
  INSERT INTO observations_fts(rowid, title, content, type, project, topic_key)
  VALUES (new.id, new.title, new.content, new.type, new.project, new.topic_key);
END;

-- ═══════════════════════════════════════════════════════════
-- MEMORY REPOSITORY: USER PROMPTS
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS user_prompts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT    NOT NULL,
  content    TEXT    NOT NULL,
  project    TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_prompts_session ON user_prompts(session_id);
CREATE INDEX IF NOT EXISTS idx_prompts_project ON user_prompts(project);
CREATE INDEX IF NOT EXISTS idx_prompts_created ON user_prompts(created_at DESC);

-- FTS5 for prompts
CREATE VIRTUAL TABLE IF NOT EXISTS prompts_fts USING fts5(
  content,
  project,
  content='user_prompts',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS prompts_fts_insert AFTER INSERT ON user_prompts BEGIN
  INSERT INTO prompts_fts(rowid, content, project)
  VALUES (new.id, new.content, new.project);
END;

CREATE TRIGGER IF NOT EXISTS prompts_fts_delete AFTER DELETE ON user_prompts BEGIN
  INSERT INTO prompts_fts(prompts_fts, rowid, content, project)
  VALUES ('delete', old.id, old.content, old.project);
END;

CREATE TRIGGER IF NOT EXISTS prompts_fts_update AFTER UPDATE ON user_prompts BEGIN
  INSERT INTO prompts_fts(prompts_fts, rowid, content, project)
  VALUES ('delete', old.id, old.content, old.project);
  INSERT INTO prompts_fts(rowid, content, project)
  VALUES (new.id, new.content, new.project);
END;

-- ═══════════════════════════════════════════════════════════
-- TRUST-SYNC REPOSITORY: SYMBOL LINKS  (existing bridge table)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS symbol_links (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id     TEXT NOT NULL,
  symbol_id     TEXT,
  repo          TEXT NOT NULL,
  trust_score   REAL NOT NULL DEFAULT 1.0,
  last_verified TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(memory_id, symbol_id)
);
CREATE INDEX IF NOT EXISTS idx_symbol_links_repo    ON symbol_links(repo);
CREATE INDEX IF NOT EXISTS idx_symbol_links_memory  ON symbol_links(memory_id);

-- ═══════════════════════════════════════════════════════════
-- TRUST-SYNC REPOSITORY: TRUST ADJUSTMENTS  (existing bridge table)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS trust_adjustments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id  TEXT NOT NULL,
  reason     TEXT NOT NULL,
  delta      REAL NOT NULL,
  timestamp  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_trust_adj_memory ON trust_adjustments(memory_id);

-- ═══════════════════════════════════════════════════════════
-- ═══════════════════════════════════════════════════════════
-- MEMORY REPOSITORY: SESSION LOG
-- ═══════════════════════════════════════════════════════════
-- NOTE: procedural_memory and procedural_steps tables removed (Issue #167).
--       Existing tables are harmless if present in older DBs; new DBs skip them.
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS session_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project         TEXT NOT NULL,
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at        TEXT,
  memories_saved  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_session_log_project ON session_log(project);

-- ═══════════════════════════════════════════════════════════
-- MEMORY/TRUST-SYNC REPOSITORY: SESSION RECALLS  (existing bridge table)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS session_recalls (
  session_id  INTEGER NOT NULL REFERENCES session_log(id) ON DELETE CASCADE,
  memory_id   TEXT NOT NULL,
  confirmed   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, memory_id)
);

-- ═══════════════════════════════════════════════════════════
-- MEMORY REPOSITORY: OBSERVATION RELATIONS  (v2 — dedup/merge tracking)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS observation_relations (
  source_id     INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  target_id     INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  relation      TEXT NOT NULL,  -- 'duplicate', 'supersedes', 'related'
  confidence    REAL NOT NULL DEFAULT 0.8,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (source_id, target_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_obs_rel_source ON observation_relations(source_id);
CREATE INDEX IF NOT EXISTS idx_obs_rel_target ON observation_relations(target_id);

-- ═══════════════════════════════════════════════════════════
-- MEMORY/ANALYTICS REPOSITORY: RECALL LOG  (v2 — tracks which memories were useful, for ranking)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS recall_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id     INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  session_id    INTEGER NOT NULL,
  query         TEXT,          -- the search query that surfaced this memory
  was_useful    INTEGER,       -- 1 = user acted on it, 0 = ignored
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_recall_memory ON recall_log(memory_id);
CREATE INDEX IF NOT EXISTS idx_recall_session ON recall_log(session_id);

-- ═══════════════════════════════════════════════════════════
-- CODE-INDEX REPOSITORY: CODE REPOS  (v3 — code indexing upgrade)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS code_repos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,
  path          TEXT NOT NULL UNIQUE,
  file_count    INTEGER DEFAULT 0,
  symbol_count  INTEGER DEFAULT 0,
  indexed_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  head_commit   TEXT,
  current_branch TEXT,
  base_head     TEXT
);

CREATE TABLE IF NOT EXISTS index_jobs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_name           TEXT NOT NULL,
  mode                TEXT NOT NULL DEFAULT 'full',
  status              TEXT NOT NULL DEFAULT 'pending',
  files_total         INTEGER NOT NULL DEFAULT 0,
  files_done          INTEGER NOT NULL DEFAULT 0,
  current_file        TEXT,
  language_breakdown  TEXT NOT NULL DEFAULT '{}',
  started_at          TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at        TEXT,
  error               TEXT
);
CREATE INDEX IF NOT EXISTS idx_index_jobs_status ON index_jobs(status);
CREATE INDEX IF NOT EXISTS idx_index_jobs_repo ON index_jobs(repo_name, started_at DESC);

CREATE TABLE IF NOT EXISTS repo_index_locks (
  repo_name   TEXT PRIMARY KEY,
  holder_id   TEXT NOT NULL,
  host        TEXT NOT NULL DEFAULT '',
  acquired_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_repo_index_locks_acquired ON repo_index_locks(acquired_at);

-- ═══════════════════════════════════════════════════════════
-- CODE-INDEX REPOSITORY: CODE FILES  (v3 — raw content + mtime tracking)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS code_files (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id       INTEGER NOT NULL REFERENCES code_repos(id) ON DELETE CASCADE,
  path          TEXT NOT NULL,
  language      TEXT NOT NULL,
  content       TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  mtime         REAL,
  size_bytes    INTEGER DEFAULT 0,
  line_count    INTEGER DEFAULT 0,
  mtime_ns      INTEGER,
  UNIQUE(repo_id, path)
);

CREATE TABLE IF NOT EXISTS code_file_diagnostics (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id     INTEGER NOT NULL REFERENCES code_repos(id) ON DELETE CASCADE,
  file_path   TEXT NOT NULL,
  status      TEXT NOT NULL,
  message     TEXT DEFAULT '',
  symbol_count INTEGER DEFAULT 0,
  content_hash TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(repo_id, file_path)
);
CREATE INDEX IF NOT EXISTS idx_cfd_repo ON code_file_diagnostics(repo_id);
CREATE INDEX IF NOT EXISTS idx_cfd_status ON code_file_diagnostics(repo_id, status);

-- ═══════════════════════════════════════════════════════════
-- CODE-INDEX REPOSITORY: CODE SYMBOLS  (v3 — extracted by tree-sitter AST)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS code_symbols (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id         INTEGER NOT NULL REFERENCES code_repos(id) ON DELETE CASCADE,
  file_id         INTEGER NOT NULL REFERENCES code_files(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL,
  signature       TEXT,
  file_path       TEXT NOT NULL,
  start_line      INTEGER NOT NULL,
  end_line        INTEGER NOT NULL,
  start_byte      INTEGER NOT NULL,
  end_byte        INTEGER NOT NULL,
  docstring       TEXT DEFAULT '',
  body_preview    TEXT DEFAULT '',
  language        TEXT NOT NULL,
  parent_name     TEXT DEFAULT '',
  qualified_name  TEXT NOT NULL,
  stable_symbol_id TEXT DEFAULT '',
  content_hash    TEXT DEFAULT '',
  summary         TEXT DEFAULT '',
  decorators_json TEXT DEFAULT '[]',
  keywords_json   TEXT DEFAULT '[]',
  call_references_json TEXT DEFAULT '[]',
  ecosystem_context TEXT DEFAULT '',
  indexed_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cs_repo ON code_symbols(repo_id);
CREATE INDEX IF NOT EXISTS idx_cs_name ON code_symbols(name);
CREATE INDEX IF NOT EXISTS idx_cs_file ON code_symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_cs_stable ON code_symbols(repo_id, stable_symbol_id);
CREATE INDEX IF NOT EXISTS idx_cf_repo ON code_files(repo_id);
CREATE INDEX IF NOT EXISTS idx_cf_hash ON code_files(repo_id, content_hash);

-- FTS5 for code symbol search
CREATE VIRTUAL TABLE IF NOT EXISTS code_symbols_fts USING fts5(
  name,
  kind,
  signature,
  docstring,
  file_path,
  body_preview,
  content=code_symbols,
  content_rowid=id
);

CREATE TRIGGER IF NOT EXISTS cs_fts_insert AFTER INSERT ON code_symbols BEGIN
  INSERT INTO code_symbols_fts(rowid, name, kind, signature, docstring, file_path, body_preview)
  VALUES (new.id, new.name, new.kind, new.signature, new.docstring, new.file_path, new.body_preview);
END;

CREATE TRIGGER IF NOT EXISTS cs_fts_delete AFTER DELETE ON code_symbols BEGIN
  INSERT INTO code_symbols_fts(code_symbols_fts, rowid, name, kind, signature, docstring, file_path, body_preview)
  VALUES ('delete', old.id, old.name, old.kind, old.signature, old.docstring, old.file_path, old.body_preview);
END;

CREATE TRIGGER IF NOT EXISTS cs_fts_update AFTER UPDATE ON code_symbols BEGIN
  INSERT INTO code_symbols_fts(code_symbols_fts, rowid, name, kind, signature, docstring, file_path, body_preview)
  VALUES ('delete', old.id, old.name, old.kind, old.signature, old.docstring, old.file_path, old.body_preview);
  INSERT INTO code_symbols_fts(rowid, name, kind, signature, docstring, file_path, body_preview)
  VALUES (new.id, new.name, new.kind, new.signature, new.docstring, new.file_path, new.body_preview);
END;

-- ═══════════════════════════════════════════════════════════
-- IMPORT EDGES  (file→file dependency graph)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS code_imports (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id         INTEGER NOT NULL REFERENCES code_repos(id) ON DELETE CASCADE,
  source_file_id  INTEGER NOT NULL REFERENCES code_files(id) ON DELETE CASCADE,
  target_module   TEXT NOT NULL,
  target_file_id  INTEGER REFERENCES code_files(id) ON DELETE SET NULL,
  import_type     TEXT NOT NULL DEFAULT 'static',
  line_number     INTEGER,
  UNIQUE(repo_id, source_file_id, target_module)
);
CREATE INDEX IF NOT EXISTS idx_ci_source ON code_imports(source_file_id);
CREATE INDEX IF NOT EXISTS idx_ci_target ON code_imports(target_file_id);
CREATE INDEX IF NOT EXISTS idx_ci_repo ON code_imports(repo_id);

-- ═══════════════════════════════════════════════════════════
-- CALL EDGES  (symbol→symbol call graph)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS code_calls (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id           INTEGER NOT NULL REFERENCES code_repos(id) ON DELETE CASCADE,
  caller_symbol_id  INTEGER NOT NULL REFERENCES code_symbols(id) ON DELETE CASCADE,
  callee_name       TEXT NOT NULL,
  callee_symbol_id  INTEGER REFERENCES code_symbols(id) ON DELETE SET NULL,
  confidence        REAL NOT NULL DEFAULT 1.0,
  line_number       INTEGER,
  UNIQUE(repo_id, caller_symbol_id, callee_name)
);
CREATE INDEX IF NOT EXISTS idx_cc_caller ON code_calls(caller_symbol_id);
CREATE INDEX IF NOT EXISTS idx_cc_callee_name ON code_calls(repo_id, callee_name);
CREATE INDEX IF NOT EXISTS idx_cc_callee ON code_calls(callee_symbol_id);

-- ═══════════════════════════════════════════════════════════
-- CODE RELATIONS  (extends, implements, reexport, references)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS code_relations (
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
);
CREATE INDEX IF NOT EXISTS idx_cr_source_sym ON code_relations(source_symbol_id);
CREATE INDEX IF NOT EXISTS idx_cr_target_sym ON code_relations(target_symbol_id);
CREATE INDEX IF NOT EXISTS idx_cr_source_file ON code_relations(source_file_id);
CREATE INDEX IF NOT EXISTS idx_cr_target_file ON code_relations(target_file_id);
CREATE INDEX IF NOT EXISTS idx_cr_repo_kind ON code_relations(repo_id, kind);

-- ═══════════════════════════════════════════════════════════
-- FILE CO-CHANGE  (git co-occurrence frequency)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS file_cochange (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id         INTEGER NOT NULL REFERENCES code_repos(id) ON DELETE CASCADE,
  file_a_id       INTEGER NOT NULL REFERENCES code_files(id) ON DELETE CASCADE,
  file_b_id       INTEGER NOT NULL REFERENCES code_files(id) ON DELETE CASCADE,
  co_commit_count INTEGER NOT NULL DEFAULT 0,
  strength        REAL NOT NULL DEFAULT 0,
  window_days     INTEGER NOT NULL DEFAULT 90,
  UNIQUE(repo_id, file_a_id, file_b_id)
);
CREATE INDEX IF NOT EXISTS idx_fcc_a ON file_cochange(file_a_id);
CREATE INDEX IF NOT EXISTS idx_fcc_b ON file_cochange(file_b_id);
CREATE INDEX IF NOT EXISTS idx_fcc_repo ON file_cochange(repo_id);

-- ═══════════════════════════════════════════════════════════
-- DOC-INDEX REPOSITORY: DOC REPOS
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS doc_repos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,
  path          TEXT NOT NULL UNIQUE,
  file_count    INTEGER DEFAULT 0,
  section_count INTEGER DEFAULT 0,
  indexed_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ═══════════════════════════════════════════════════════════
-- DOC-INDEX REPOSITORY: DOC FILES
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS doc_files (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id       INTEGER NOT NULL REFERENCES doc_repos(id) ON DELETE CASCADE,
  path          TEXT NOT NULL,
  content       TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  mtime         REAL,
  UNIQUE(repo_id, path)
);

-- ═══════════════════════════════════════════════════════════
-- DOC-INDEX REPOSITORY: DOC SECTIONS
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS doc_sections (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id       INTEGER NOT NULL REFERENCES doc_repos(id) ON DELETE CASCADE,
  file_id       INTEGER NOT NULL REFERENCES doc_files(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  level         INTEGER NOT NULL,
  parent_id     INTEGER REFERENCES doc_sections(id) ON DELETE SET NULL,
  content       TEXT DEFAULT '',
  content_hash  TEXT NOT NULL,
  byte_start    INTEGER NOT NULL,
  byte_end      INTEGER NOT NULL,
  role          TEXT DEFAULT 'other',
  tags          TEXT DEFAULT '',
  UNIQUE(repo_id, file_id, byte_start)
);
CREATE INDEX IF NOT EXISTS idx_ds_file ON doc_sections(file_id);
CREATE INDEX IF NOT EXISTS idx_ds_parent ON doc_sections(parent_id);
CREATE INDEX IF NOT EXISTS idx_ds_repo ON doc_sections(repo_id);
CREATE INDEX IF NOT EXISTS idx_ds_level ON doc_sections(level);

CREATE VIRTUAL TABLE IF NOT EXISTS doc_sections_fts USING fts5(
  title,
  content,
  tags,
  content=doc_sections,
  content_rowid=id
);

CREATE TRIGGER IF NOT EXISTS ds_fts_insert AFTER INSERT ON doc_sections BEGIN
  INSERT INTO doc_sections_fts(rowid, title, content, tags)
  VALUES (new.id, new.title, new.content, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS ds_fts_delete AFTER DELETE ON doc_sections BEGIN
  INSERT INTO doc_sections_fts(doc_sections_fts, rowid, title, content, tags)
  VALUES ('delete', old.id, old.title, old.content, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS ds_fts_update AFTER UPDATE ON doc_sections BEGIN
  INSERT INTO doc_sections_fts(doc_sections_fts, rowid, title, content, tags)
  VALUES ('delete', old.id, old.title, old.content, old.tags);
  INSERT INTO doc_sections_fts(rowid, title, content, tags)
  VALUES (new.id, new.title, new.content, new.tags);
END;

-- ═══════════════════════════════════════════════════════════
-- DOC-INDEX REPOSITORY: DOC LINKS
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS doc_links (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  source_section_id INTEGER NOT NULL REFERENCES doc_sections(id) ON DELETE CASCADE,
  target_path       TEXT NOT NULL,
  target_section_id INTEGER REFERENCES doc_sections(id) ON DELETE SET NULL,
  link_text         TEXT DEFAULT '',
  is_broken         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_dl_source ON doc_links(source_section_id);
CREATE INDEX IF NOT EXISTS idx_dl_target ON doc_links(target_section_id);
CREATE INDEX IF NOT EXISTS idx_dl_broken ON doc_links(is_broken);

-- ═══════════════════════════════════════════════════════════
-- DOC-INDEX REPOSITORY: DOC GLOSSARY TERMS
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS doc_terms (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id     INTEGER NOT NULL REFERENCES doc_repos(id) ON DELETE CASCADE,
  term        TEXT NOT NULL,
  definition  TEXT NOT NULL,
  section_id  INTEGER REFERENCES doc_sections(id) ON DELETE SET NULL,
  UNIQUE(repo_id, term)
);
CREATE INDEX IF NOT EXISTS idx_dt_term ON doc_terms(term);
CREATE INDEX IF NOT EXISTS idx_dt_repo ON doc_terms(repo_id);

-- ═══════════════════════════════════════════════════════════
-- DOC-INDEX REPOSITORY: DOC CODE BLOCKS
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS doc_code_blocks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  section_id  INTEGER NOT NULL REFERENCES doc_sections(id) ON DELETE CASCADE,
  lang        TEXT DEFAULT '',
  content     TEXT NOT NULL,
  byte_start  INTEGER NOT NULL,
  byte_end    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dcb_section ON doc_code_blocks(section_id);
CREATE INDEX IF NOT EXISTS idx_dcb_lang ON doc_code_blocks(lang);

-- ═══════════════════════════════════════════════════════════
-- CODE-INDEX/ANALYTICS REPOSITORY: CHURN METRICS
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS churn_metrics (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id       INTEGER NOT NULL REFERENCES code_repos(id) ON DELETE CASCADE,
  file_path     TEXT NOT NULL,
  commits       INTEGER NOT NULL DEFAULT 0,
  unique_authors INTEGER NOT NULL DEFAULT 0,
  first_seen    TEXT,
  last_modified TEXT,
  churn_per_week REAL DEFAULT 0.0,
  window_days   INTEGER NOT NULL DEFAULT 90,
  total_files_changed INTEGER NOT NULL DEFAULT 0,
  top_files_json TEXT DEFAULT '[]',
  UNIQUE(repo_id, file_path, window_days)
);
CREATE INDEX IF NOT EXISTS idx_cm_repo ON churn_metrics(repo_id);

-- ═══════════════════════════════════════════════════════════
-- CODE-INDEX/ANALYTICS REPOSITORY: SYMBOL COMPLEXITY
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS symbol_complexity (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol_id         INTEGER NOT NULL UNIQUE REFERENCES code_symbols(id) ON DELETE CASCADE,
  cyclomatic        INTEGER NOT NULL DEFAULT 1,
  nesting_depth     INTEGER NOT NULL DEFAULT 0,
  param_count       INTEGER NOT NULL DEFAULT 0,
  lines_of_code     INTEGER NOT NULL DEFAULT 0,
  assessment        TEXT NOT NULL DEFAULT 'low'
);
CREATE INDEX IF NOT EXISTS idx_sc_symbol ON symbol_complexity(symbol_id);

-- ═══════════════════════════════════════════════════════════
-- CODE-INDEX REPOSITORY: FILE SCOPE BINDINGS  (parse artifact — immutable after parse)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS file_scope_bindings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id         INTEGER NOT NULL REFERENCES code_repos(id) ON DELETE CASCADE,
  file_id         INTEGER NOT NULL REFERENCES code_files(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL,
  origin          TEXT NOT NULL,
  source_file_id  INTEGER NULL REFERENCES code_files(id) ON DELETE SET NULL,
  source_name     TEXT NULL,
  source_module   TEXT NULL,
  line_start      INTEGER NOT NULL,
  line_end        INTEGER NOT NULL,
  scope_depth     INTEGER NOT NULL DEFAULT 0,
  byte_start      INTEGER NULL,
  byte_end        INTEGER NULL,
  first_seen_pass INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_fsb_file_name ON file_scope_bindings(repo_id, file_id, name, line_start);
CREATE INDEX IF NOT EXISTS idx_fsb_file_range ON file_scope_bindings(repo_id, file_id, line_start, line_end);
CREATE INDEX IF NOT EXISTS idx_fsb_file_depth ON file_scope_bindings(file_id, scope_depth);

-- ═══════════════════════════════════════════════════════════
-- CODE-INDEX REPOSITORY: SCOPE RESOLUTION  (resolution pass — mutable, rebuildable)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS scope_resolution (
  binding_id          INTEGER PRIMARY KEY REFERENCES file_scope_bindings(id) ON DELETE CASCADE,
  resolved_symbol_id  INTEGER NULL REFERENCES code_symbols(id) ON DELETE SET NULL,
  resolved_file_id    INTEGER NULL REFERENCES code_files(id) ON DELETE SET NULL,
  status              TEXT NOT NULL,
  resolved_at_pass    INTEGER NOT NULL,
  confidence          REAL NOT NULL DEFAULT 1.0
);
CREATE INDEX IF NOT EXISTS idx_sr_binding ON scope_resolution(binding_id);
CREATE INDEX IF NOT EXISTS idx_sr_symbol ON scope_resolution(resolved_symbol_id);
CREATE INDEX IF NOT EXISTS idx_sr_status ON scope_resolution(status);
CREATE INDEX IF NOT EXISTS idx_sr_pass ON scope_resolution(resolved_at_pass);

-- ═══════════════════════════════════════════════════════════
-- MEMORY REPOSITORY: OBSERVATION VERSIONS  (edit history trail)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS observation_versions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id   INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  field       TEXT NOT NULL,
  old_value   TEXT NOT NULL DEFAULT '',
  new_value   TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ov_memory ON observation_versions(memory_id);
CREATE INDEX IF NOT EXISTS idx_ov_created ON observation_versions(created_at DESC);

-- ═══════════════════════════════════════════════════════════
-- ═══════════════════════════════════════════════════════════
-- AGENT-INTEL REPOSITORY: SYMBOL METADATA  (enriched per-symbol data)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS symbol_metadata (
  symbol_id         INTEGER PRIMARY KEY REFERENCES code_symbols(id) ON DELETE CASCADE,
  intent            TEXT NOT NULL DEFAULT '',
  behavior_summary  TEXT NOT NULL DEFAULT '',
  constraints       TEXT NOT NULL DEFAULT '[]',    -- JSON array of strings
  failure_history   TEXT NOT NULL DEFAULT '[]',    -- JSON array of {date, description}
  replacement_of    TEXT NOT NULL DEFAULT '',       -- stable_symbol_id of superseded symbol
  enriched_at       TEXT NOT NULL DEFAULT (datetime('now')),
  enrichment_source TEXT NOT NULL DEFAULT ''        -- 'auto' | 'manual'
);
CREATE INDEX IF NOT EXISTS idx_sm_symbol ON symbol_metadata(symbol_id);

-- ═══════════════════════════════════════════════════════════
-- AGENT-INTEL REPOSITORY: DUPLICATE DETECTION  (clone families)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS duplicate_groups (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id         INTEGER NOT NULL REFERENCES code_repos(id) ON DELETE CASCADE,
  intent          TEXT NOT NULL DEFAULT '',
  risk            TEXT NOT NULL DEFAULT 'low',        -- low | medium | high
  detection_type  TEXT NOT NULL DEFAULT 'structural',  -- name | structural | intent
  recommendation  TEXT NOT NULL DEFAULT '',
  fingerprint_hash TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dg_repo ON duplicate_groups(repo_id);
CREATE INDEX IF NOT EXISTS idx_dg_hash ON duplicate_groups(repo_id, fingerprint_hash);

CREATE TABLE IF NOT EXISTS duplicate_instances (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id        INTEGER NOT NULL REFERENCES duplicate_groups(id) ON DELETE CASCADE,
  symbol_id       INTEGER NOT NULL REFERENCES code_symbols(id) ON DELETE CASCADE,
  file_path       TEXT NOT NULL,
  symbol_name     TEXT NOT NULL,
  line_start      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_di_group ON duplicate_instances(group_id);
CREATE INDEX IF NOT EXISTS idx_di_symbol ON duplicate_instances(symbol_id);

-- ═══════════════════════════════════════════════════════════
-- AGENT-INTEL REPOSITORY: AUDIT RUNS  (post-edit diff audit trail)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS audit_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id         INTEGER NOT NULL REFERENCES code_repos(id) ON DELETE CASCADE,
  task            TEXT NOT NULL DEFAULT '',
  files_changed   TEXT NOT NULL DEFAULT '[]',       -- JSON array of file paths
  violations      TEXT NOT NULL DEFAULT '[]',       -- JSON array of violation objects
  risk            TEXT NOT NULL DEFAULT 'low',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ar_repo ON audit_runs(repo_id);
CREATE INDEX IF NOT EXISTS idx_ar_created ON audit_runs(created_at DESC);

-- ═══════════════════════════════════════════════════════════
-- SETTINGS (KV store for integration tokens, config)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ═══════════════════════════════════════════════════════════
-- RUNTIME REALITY: Symbol hotness and stale flag detection
-- ═══════════════════════════════════════════════════════════

-- Runtime hotness per symbol (from Istanbul coverage)
CREATE TABLE IF NOT EXISTS runtime_symbols (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id           INTEGER NOT NULL REFERENCES code_repos(id) ON DELETE CASCADE,
  symbol_id         INTEGER REFERENCES code_symbols(id) ON DELETE CASCADE,
  file_path         TEXT NOT NULL,
  function_name     TEXT NOT NULL DEFAULT '',
  hit_count         INTEGER NOT NULL DEFAULT 0,
  line_start        INTEGER,
  line_end          INTEGER,
  traffic           TEXT NOT NULL DEFAULT 'unknown',  -- hot | warm | cold | unknown
  last_seen         TEXT,                              -- ISO date
  ingested_at       TEXT NOT NULL DEFAULT (datetime('now')),
  source_file       TEXT NOT NULL DEFAULT '',          -- coverage JSON path
  UNIQUE(repo_id, file_path, function_name)
);

CREATE INDEX IF NOT EXISTS idx_rs_repo ON runtime_symbols(repo_id);
CREATE INDEX IF NOT EXISTS idx_rs_traffic ON runtime_symbols(traffic);

-- Stale feature flags (one-sided branches detected in source)
CREATE TABLE IF NOT EXISTS stale_flags (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id         INTEGER NOT NULL REFERENCES code_repos(id) ON DELETE CASCADE,
  file_path       TEXT NOT NULL,
  line_number     INTEGER NOT NULL,
  flag_name       TEXT NOT NULL,
  branch_type     TEXT NOT NULL,  -- always-true | always-false
  context         TEXT NOT NULL DEFAULT '',
  detected_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sf_repo ON stale_flags(repo_id);
CREATE INDEX IF NOT EXISTS idx_sf_traffic ON stale_flags(file_path);

-- ═══════════════════════════════════════════════════════════
-- AUREX TODO LEDGER REPOSITORY
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS todo_ledgers (
  mission_id          TEXT PRIMARY KEY,
  mission_title       TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL DEFAULT 'planning',
  source_mission      TEXT NOT NULL DEFAULT '',
  planner_summary     TEXT NOT NULL DEFAULT '',
  acceptance_criteria TEXT NOT NULL DEFAULT '[]',
  constraints_json    TEXT NOT NULL DEFAULT '[]',
  assumptions         TEXT NOT NULL DEFAULT '[]',
  human_questions     TEXT NOT NULL DEFAULT '[]',
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_todo_ledgers_status ON todo_ledgers(status);

CREATE TABLE IF NOT EXISTS todo_items (
  id                     TEXT PRIMARY KEY,
  mission_id             TEXT NOT NULL REFERENCES todo_ledgers(mission_id) ON DELETE CASCADE,
  title                  TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'pending',
  type                   TEXT NOT NULL DEFAULT 'implementation',
  priority               TEXT NOT NULL DEFAULT 'medium',
  depends_on             TEXT NOT NULL DEFAULT '[]',
  goal                   TEXT NOT NULL DEFAULT '',
  scope_json             TEXT NOT NULL DEFAULT '{"in":[],"out":[]}',
  likely_files           TEXT NOT NULL DEFAULT '[]',
  lapis_context_query    TEXT NOT NULL DEFAULT '',
  acceptance_criteria    TEXT NOT NULL DEFAULT '[]',
  validation_criteria    TEXT NOT NULL DEFAULT '[]',
  test_commands          TEXT NOT NULL DEFAULT '[]',
  risk_level             TEXT NOT NULL DEFAULT 'medium',
  worker_instructions    TEXT NOT NULL DEFAULT '[]',
  validator_instructions TEXT NOT NULL DEFAULT '[]',
  escalation_rules       TEXT NOT NULL DEFAULT '[]',
  evidence_json          TEXT NOT NULL DEFAULT '{"branch":null,"commits":[],"changedFiles":[],"testsRun":[],"testResults":[],"validatorVerdict":null,"notes":[]}',
  confidence             TEXT NOT NULL DEFAULT 'medium',
  assigned_worker_id     TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_todo_items_mission ON todo_items(mission_id);
CREATE INDEX IF NOT EXISTS idx_todo_items_status ON todo_items(status);
CREATE INDEX IF NOT EXISTS idx_todo_items_context ON todo_items(lapis_context_query);

CREATE TABLE IF NOT EXISTS todo_events (
  id           TEXT PRIMARY KEY,
  mission_id   TEXT NOT NULL REFERENCES todo_ledgers(mission_id) ON DELETE CASCADE,
  todo_id      TEXT REFERENCES todo_items(id) ON DELETE CASCADE,
  event_type   TEXT NOT NULL,
  actor_id     TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_todo_events_mission ON todo_events(mission_id);
CREATE INDEX IF NOT EXISTS idx_todo_events_todo ON todo_events(todo_id);

-- ═══════════════════════════════════════════════════════════
-- AUREX DOMAIN  (mission orchestration)
-- ═══════════════════════════════════════════════════════════
-- These tables are the source of truth for the Aurex mission domain.
-- The same DDL is also emitted by runMigrationV11 for legacy upgrade
-- paths; the canonical definition lives here so a fresh `createDb`
-- produces a complete schema without depending on the migration loop.
CREATE TABLE IF NOT EXISTS missions (
  id           TEXT PRIMARY KEY,
  description  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'planning',
  config_json  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS milestones (
  id                       TEXT PRIMARY KEY,
  mission_id               TEXT NOT NULL REFERENCES missions(id),
  title                    TEXT NOT NULL,
  description              TEXT NOT NULL DEFAULT '',
  order_index              INTEGER NOT NULL DEFAULT 0,
  status                   TEXT NOT NULL DEFAULT 'planned',
  validation_contract_id   TEXT,
  retries                  INTEGER NOT NULL DEFAULT 0,
  rescopes                 INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS working_units (
  id                TEXT PRIMARY KEY,
  milestone_id      TEXT NOT NULL REFERENCES milestones(id),
  description       TEXT NOT NULL DEFAULT '',
  declared_paths    TEXT NOT NULL DEFAULT '[]',
  declared_modules  TEXT NOT NULL DEFAULT '[]',
  status            TEXT NOT NULL DEFAULT 'spawned',
  task_branch       TEXT NOT NULL DEFAULT '',
  worktree_path     TEXT NOT NULL DEFAULT '',
  session_id        TEXT
);
CREATE TABLE IF NOT EXISTS validation_contracts (
  id                  TEXT PRIMARY KEY,
  milestone_id        TEXT NOT NULL REFERENCES milestones(id),
  version             INTEGER NOT NULL DEFAULT 1,
  content             TEXT NOT NULL DEFAULT '{}',
  supersedes          TEXT,
  superseded_by       TEXT,
  rescope_event_id    TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS validation_verdicts (
  id                TEXT PRIMARY KEY,
  milestone_id      TEXT NOT NULL REFERENCES milestones(id),
  contract_id       TEXT NOT NULL REFERENCES validation_contracts(id),
  validator_type    TEXT NOT NULL,
  session_id        TEXT NOT NULL,
  verdict           TEXT NOT NULL,
  classification    TEXT,
  findings          TEXT NOT NULL DEFAULT '',
  failed_unit_ids   TEXT NOT NULL DEFAULT '[]',
  timestamp         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS broadcasts (
  id            TEXT PRIMARY KEY,
  mission_id    TEXT NOT NULL REFERENCES missions(id),
  author_id     TEXT NOT NULL,
  author_type   TEXT NOT NULL,
  category      TEXT NOT NULL DEFAULT 'info',
  title         TEXT NOT NULL DEFAULT '',
  content       TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'active',
  ttl           INTEGER,
  expires_at    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS research_findings (
  id                TEXT PRIMARY KEY,
  mission_id        TEXT NOT NULL REFERENCES missions(id),
  author_id         TEXT NOT NULL,
  domain            TEXT NOT NULL DEFAULT '[]',
  title             TEXT NOT NULL DEFAULT '',
  content           TEXT NOT NULL DEFAULT '',
  relevance         TEXT NOT NULL DEFAULT 'medium',
  status            TEXT NOT NULL DEFAULT 'unverified',
  verified_task_id  TEXT,
  ttl               INTEGER,
  expires_at        TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS agent_sessions (
  session_id      TEXT PRIMARY KEY,
  agent_type      TEXT NOT NULL,
  mission_id      TEXT NOT NULL REFERENCES missions(id),
  milestone_id    TEXT REFERENCES milestones(id),
  unit_id         TEXT REFERENCES working_units(id),
  spawned_at      TEXT NOT NULL DEFAULT (datetime('now')),
  terminated_at   TEXT
);
CREATE TABLE IF NOT EXISTS cost_entries (
  id                  TEXT PRIMARY KEY,
  mission_id          TEXT NOT NULL REFERENCES missions(id),
  agent_session_id    TEXT NOT NULL,
  model               TEXT NOT NULL,
  prompt_tokens       INTEGER NOT NULL DEFAULT 0,
  completion_tokens   INTEGER NOT NULL DEFAULT 0,
  cost                REAL NOT NULL DEFAULT 0,
  timestamp           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS rescope_events (
  id              TEXT PRIMARY KEY,
  milestone_id    TEXT NOT NULL REFERENCES milestones(id),
  contract_id     TEXT NOT NULL REFERENCES validation_contracts(id),
  reason          TEXT NOT NULL DEFAULT '',
  previous_scope  TEXT NOT NULL DEFAULT '',
  new_scope       TEXT NOT NULL DEFAULT '',
  timestamp       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_aurex_milestones_mission  ON milestones(mission_id);
CREATE INDEX IF NOT EXISTS idx_aurex_units_milestone    ON working_units(milestone_id);
CREATE INDEX IF NOT EXISTS idx_aurex_contracts_milestone ON validation_contracts(milestone_id);
CREATE INDEX IF NOT EXISTS idx_aurex_verdicts_milestone  ON validation_verdicts(milestone_id);
CREATE INDEX IF NOT EXISTS idx_aurex_broadcasts_mission  ON broadcasts(mission_id);
CREATE INDEX IF NOT EXISTS idx_aurex_findings_mission    ON research_findings(mission_id);
CREATE INDEX IF NOT EXISTS idx_aurex_sessions_mission    ON agent_sessions(mission_id);
CREATE INDEX IF NOT EXISTS idx_aurex_sessions_milestone  ON agent_sessions(milestone_id);
CREATE INDEX IF NOT EXISTS idx_aurex_costs_mission       ON cost_entries(mission_id);
CREATE INDEX IF NOT EXISTS idx_aurex_rescope_milestone   ON rescope_events(milestone_id);

-- ═══════════════════════════════════════════════════════════
-- AUREX HANDOFFS  (worker → orchestrator structured completion)
-- ═══════════════════════════════════════════════════════════
-- Worker agents call write_handoff to signal completed work. The
-- milestone-loop reads getHandoffsForMilestone to validate that each
-- completed worker session produced a structured handoff. Without
-- this table, handoffs cannot be persisted and the orchestrator
-- treats all workers as missing-handoff failures.
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
);
CREATE INDEX IF NOT EXISTS idx_handoffs_unit      ON handoffs(unit_id);
CREATE INDEX IF NOT EXISTS idx_handoffs_milestone ON handoffs(milestone_id);
CREATE INDEX IF NOT EXISTS idx_handoffs_mission   ON handoffs(mission_id);
