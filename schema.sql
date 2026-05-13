-- @genegulanesjr/memory-layer — Unified Schema v4
-- Single database: ~/.pi/memory/memory.db
-- Zero external dependencies. FTS5 search, trust scoring, dedup, recall ranking.
PRAGMA user_version = 7;

-- ═══════════════════════════════════════════════════════════
-- WORKSPACES  (v4 — formal project isolation)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS workspaces (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ws_active ON workspaces(archived_at) WHERE archived_at IS NULL;

-- ═══════════════════════════════════════════════════════════
-- OBSERVATIONS
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
-- USER PROMPTS
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
-- SYMBOL LINKS  (existing bridge table)
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
-- TRUST ADJUSTMENTS  (existing bridge table)
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
-- PROCEDURAL MEMORY  (existing bridge table)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS procedural_memory (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  project    TEXT,
  status     TEXT NOT NULL DEFAULT 'active',
  success    REAL NOT NULL DEFAULT 0.0,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS procedural_steps (
  workflow   TEXT NOT NULL REFERENCES procedural_memory(id) ON DELETE CASCADE,
  step_num   INTEGER NOT NULL,
  command    TEXT NOT NULL,
  success    REAL NOT NULL DEFAULT 1.0,
  attempts   INTEGER NOT NULL DEFAULT 0,
  fail_workaround TEXT,
  PRIMARY KEY (workflow, step_num)
);

-- ═══════════════════════════════════════════════════════════
-- SESSION LOG
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
-- SESSION RECALLS  (existing bridge table)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS session_recalls (
  session_id  INTEGER NOT NULL REFERENCES session_log(id) ON DELETE CASCADE,
  memory_id   TEXT NOT NULL,
  confirmed   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, memory_id)
);

-- ═══════════════════════════════════════════════════════════
-- OBSERVATION RELATIONS  (v2 — dedup/merge tracking)
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
-- RECALL LOG  (v2 — tracks which memories were useful, for ranking)
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
-- CODE REPOS  (v3 — code indexing upgrade)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS code_repos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,
  path          TEXT NOT NULL UNIQUE,
  file_count    INTEGER DEFAULT 0,
  symbol_count  INTEGER DEFAULT 0,
  indexed_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  head_commit   TEXT
);

-- ═══════════════════════════════════════════════════════════
-- CODE FILES  (v3 — raw content + mtime tracking)
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
  UNIQUE(repo_id, path)
);

-- ═══════════════════════════════════════════════════════════
-- CODE SYMBOLS  (v3 — extracted by tree-sitter AST)
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
  indexed_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cs_repo ON code_symbols(repo_id);
CREATE INDEX IF NOT EXISTS idx_cs_name ON code_symbols(name);
CREATE INDEX IF NOT EXISTS idx_cs_file ON code_symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_cf_repo ON code_files(repo_id);

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
-- DOC REPOS
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
-- DOC FILES
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
-- DOC SECTIONS
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
-- DOC LINKS
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
-- DOC GLOSSARY TERMS
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
-- DOC CODE BLOCKS
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
-- CHURN METRICS
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
  UNIQUE(repo_id, file_path, window_days)
);
CREATE INDEX IF NOT EXISTS idx_cm_repo ON churn_metrics(repo_id);

-- ═══════════════════════════════════════════════════════════
-- SYMBOL COMPLEXITY
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
