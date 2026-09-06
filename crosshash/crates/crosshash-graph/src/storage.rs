use crosshash_core::{CoreError, Edge, Entity, EntityVersion, Repo, Result};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use uuid::Uuid;

mod embedded {
    use refinery::embed_migrations;
    embed_migrations!("db/migrations");
}

pub struct GraphStorage {
    conn: Connection,
}

impl GraphStorage {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path).map_err(|e| CoreError::StorageError(e.to_string()))?;

        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
            .map_err(|e| CoreError::StorageError(e.to_string()))?;

        let mut storage = Self { conn };
        storage.run_migrations()?;
        Ok(storage)
    }

    pub fn open_in_memory() -> Result<Self> {
        let conn =
            Connection::open_in_memory().map_err(|e| CoreError::StorageError(e.to_string()))?;

        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
            .map_err(|e| CoreError::StorageError(e.to_string()))?;

        let mut storage = Self { conn };
        storage.run_migrations()?;
        Ok(storage)
    }

    fn run_migrations(&mut self) -> Result<()> {
        embedded::migrations::runner()
            .run(&mut self.conn)
            .map_err(|e| CoreError::MigrationError(e.to_string()))?;
        Ok(())
    }

    pub fn insert_repo(&self, repo: &Repo) -> Result<()> {
        let languages_json = serde_json::to_string(&repo.languages)
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        let ws_type = serde_json::to_string(&repo.workspace_type)
            .map_err(|e| CoreError::StorageError(e.to_string()))?;

        self.conn
            .execute(
                "INSERT OR REPLACE INTO repos (id, name, root_path, git_remote, default_branch, languages, workspace_type, last_indexed_at, commit_hash)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    repo.id.to_string(),
                    repo.name,
                    repo.root_path,
                    repo.git_remote,
                    repo.default_branch,
                    languages_json,
                    ws_type,
                    repo.last_indexed_at.to_rfc3339(),
                    repo.commit_hash,
                ],
            )
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        Ok(())
    }

    pub fn get_repo(&self, id: Uuid) -> Result<Option<Repo>> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM repos WHERE id = ?1")
            .map_err(|e| CoreError::StorageError(e.to_string()))?;

        let result = stmt
            .query_row(params![id.to_string()], |row| {
                let languages_str: String = row.get("languages")?;
                let ws_type_str: String = row.get("workspace_type")?;
                let last_indexed_str: String = row.get("last_indexed_at")?;

                Ok(Repo {
                    id: db_parse(Uuid::parse_str(&row.get::<_, String>("id")?))?,
                    name: row.get("name")?,
                    root_path: row.get("root_path")?,
                    git_remote: row.get("git_remote")?,
                    default_branch: row.get("default_branch")?,
                    languages: db_parse(serde_json::from_str(&languages_str))?,
                    workspace_type: db_parse(serde_json::from_str(&ws_type_str))?,
                    last_indexed_at: db_parse(chrono::DateTime::parse_from_rfc3339(
                        &last_indexed_str,
                    ))?
                    .with_timezone(&chrono::Utc),
                    commit_hash: row.get("commit_hash")?,
                })
            })
            .optional()
            .map_err(|e| CoreError::StorageError(e.to_string()))?;

        Ok(result)
    }

    pub fn list_repos(&self) -> Result<Vec<Repo>> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM repos ORDER BY name")
            .map_err(|e| CoreError::StorageError(e.to_string()))?;

        let repos = stmt
            .query_map([], |row| {
                let languages_str: String = row.get("languages")?;
                let ws_type_str: String = row.get("workspace_type")?;
                let last_indexed_str: String = row.get("last_indexed_at")?;

                Ok(Repo {
                    id: db_parse(Uuid::parse_str(&row.get::<_, String>("id")?))?,
                    name: row.get("name")?,
                    root_path: row.get("root_path")?,
                    git_remote: row.get("git_remote")?,
                    default_branch: row.get("default_branch")?,
                    languages: db_parse(serde_json::from_str(&languages_str))?,
                    workspace_type: db_parse(serde_json::from_str(&ws_type_str))?,
                    last_indexed_at: db_parse(chrono::DateTime::parse_from_rfc3339(
                        &last_indexed_str,
                    ))?
                    .with_timezone(&chrono::Utc),
                    commit_hash: row.get("commit_hash")?,
                })
            })
            .map_err(|e| CoreError::StorageError(e.to_string()))?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| CoreError::StorageError(e.to_string()))?;

        Ok(repos)
    }

    pub fn insert_entity(&self, entity: &Entity) -> Result<()> {
        self.conn
            .execute(
                "INSERT OR REPLACE INTO entities (
                    id, repo_id, file_path, language, kind, name, qualified_name, signature,
                    start_line, end_line, start_byte, end_byte,
                    signature_hash, content_hash, structural_hash, identity_hash, context_hash,
                    visibility, is_exported, is_async, is_test,
                    first_seen_commit, last_seen_commit, deleted_at_commit
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24)",
                params![
                    entity.id.to_string(),
                    entity.repo_id.to_string(),
                    entity.file_path,
                    serde_json::to_string(&entity.language).unwrap(),
                    serde_json::to_string(&entity.kind).unwrap(),
                    entity.name,
                    entity.qualified_name,
                    entity.signature,
                    entity.start_line,
                    entity.end_line,
                    entity.start_byte,
                    entity.end_byte,
                    entity.signature_hash.as_slice(),
                    entity.content_hash.as_slice(),
                    entity.structural_hash.as_slice(),
                    entity.identity_hash.as_slice(),
                    entity.context_hash.as_slice(),
                    serde_json::to_string(&entity.visibility).unwrap(),
                    entity.is_exported,
                    entity.is_async,
                    entity.is_test,
                    entity.first_seen_commit,
                    entity.last_seen_commit,
                    entity.deleted_at_commit,
                ],
            )
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        Ok(())
    }

    pub fn insert_edge(&self, edge: &Edge) -> Result<()> {
        let metadata_json = edge
            .metadata
            .as_ref()
            .map(|v| v.to_string())
            .unwrap_or_default();

        self.conn
            .execute(
                "INSERT OR REPLACE INTO edges (id, source_entity_id, target_entity_id, kind, confidence, source, metadata, created_at, validated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    edge.id.to_string(),
                    edge.source_entity_id.to_string(),
                    edge.target_entity_id.to_string(),
                    serde_json::to_string(&edge.kind).unwrap(),
                    edge.confidence,
                    serde_json::to_string(&edge.source).unwrap(),
                    metadata_json,
                    edge.created_at.to_rfc3339(),
                    edge.validated_at.map(|v| v.to_rfc3339()),
                ],
            )
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        Ok(())
    }

    pub fn insert_entity_version(&self, version: &EntityVersion) -> Result<()> {
        self.conn
            .execute(
                "INSERT OR REPLACE INTO entity_versions (
                    entity_id, commit_hash, name, qualified_name, signature,
                    signature_hash, content_hash, structural_hash, identity_hash, context_hash,
                    snapshot_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    version.entity_id.to_string(),
                    version.commit_hash,
                    version.name,
                    version.qualified_name,
                    version.signature,
                    version.signature_hash.as_slice(),
                    version.content_hash.as_slice(),
                    version.structural_hash.as_slice(),
                    version.identity_hash.as_slice(),
                    version.context_hash.as_slice(),
                    version.snapshot_at.to_rfc3339(),
                ],
            )
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        Ok(())
    }

    pub fn upsert_file_hash(
        &self,
        repo_id: Uuid,
        file_path: &str,
        content_hash: &[u8],
    ) -> Result<()> {
        self.conn
            .execute(
                "INSERT OR REPLACE INTO file_hashes (repo_id, file_path, content_hash) VALUES (?1, ?2, ?3)",
                params![repo_id.to_string(), file_path, content_hash],
            )
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        Ok(())
    }

    pub fn get_file_hash(&self, repo_id: Uuid, file_path: &str) -> Result<Option<[u8; 32]>> {
        let mut stmt = self
            .conn
            .prepare("SELECT content_hash FROM file_hashes WHERE repo_id = ?1 AND file_path = ?2")
            .map_err(|e| CoreError::StorageError(e.to_string()))?;

        let result = stmt
            .query_row(params![repo_id.to_string(), file_path], |row| {
                let hash: Vec<u8> = row.get(0)?;
                let arr = safe_hash_from_slice(&hash);
                Ok(arr)
            })
            .optional()
            .map_err(|e| CoreError::StorageError(e.to_string()))?;

        Ok(result)
    }

    pub fn get_repo_by_name(&self, name: &str) -> Result<Option<Repo>> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM repos WHERE name = ?1")
            .map_err(|e| CoreError::StorageError(e.to_string()))?;

        let result = stmt
            .query_row(params![name], |row| {
                let languages_str: String = row.get("languages")?;
                let ws_type_str: String = row.get("workspace_type")?;
                let last_indexed_str: String = row.get("last_indexed_at")?;

                Ok(Repo {
                    id: db_parse(Uuid::parse_str(&row.get::<_, String>("id")?))?,
                    name: row.get("name")?,
                    root_path: row.get("root_path")?,
                    git_remote: row.get("git_remote")?,
                    default_branch: row.get("default_branch")?,
                    languages: db_parse(serde_json::from_str(&languages_str))?,
                    workspace_type: db_parse(serde_json::from_str(&ws_type_str))?,
                    last_indexed_at: db_parse(chrono::DateTime::parse_from_rfc3339(
                        &last_indexed_str,
                    ))?
                    .with_timezone(&chrono::Utc),
                    commit_hash: row.get("commit_hash")?,
                })
            })
            .optional()
            .map_err(|e| CoreError::StorageError(e.to_string()))?;

        Ok(result)
    }

    pub fn get_entities_by_repo(&self, repo_id: Uuid) -> Result<Vec<Entity>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, repo_id, file_path, language, kind, name, qualified_name, signature, \
                 start_line, end_line, start_byte, end_byte, \
                 signature_hash, content_hash, structural_hash, identity_hash, context_hash, \
                 visibility, is_exported, is_async, is_test, \
                 first_seen_commit, last_seen_commit, deleted_at_commit \
                 FROM entities WHERE repo_id = ?1 AND deleted_at_commit IS NULL",
            )
            .map_err(|e| CoreError::StorageError(e.to_string()))?;

        let entities = stmt
            .query_map(params![repo_id.to_string()], |row| Ok(row_to_entity(row)))
            .map_err(|e| CoreError::StorageError(e.to_string()))?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| CoreError::StorageError(e.to_string()))?;

        Ok(entities)
    }

    pub fn mark_entities_deleted(
        &self,
        repo_id: Uuid,
        entity_ids: &[Uuid],
        commit_hash: &str,
    ) -> Result<()> {
        for id in entity_ids {
            self.conn
                .execute(
                    "UPDATE entities SET deleted_at_commit = ?1 WHERE id = ?2 AND repo_id = ?3",
                    params![commit_hash, id.to_string(), repo_id.to_string()],
                )
                .map_err(|e| CoreError::StorageError(e.to_string()))?;
        }
        Ok(())
    }

    pub fn remove_repo(&self, name: &str) -> Result<()> {
        let repo = match self.get_repo_by_name(name)? {
            Some(r) => r,
            None => return Ok(()),
        };
        // The 5 dependent DELETEs are atomic — a partial remove would leave
        // orphaned versions/hashes/edges behind (#320).
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        self.remove_edges_for_repo(repo.id)?;
        self.conn
            .execute(
                "DELETE FROM entity_versions WHERE entity_id IN (SELECT id FROM entities WHERE repo_id = ?1)",
                params![repo.id.to_string()],
            )
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        self.conn
            .execute(
                "DELETE FROM entities WHERE repo_id = ?1",
                params![repo.id.to_string()],
            )
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        self.conn
            .execute(
                "DELETE FROM file_hashes WHERE repo_id = ?1",
                params![repo.id.to_string()],
            )
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        self.conn
            .execute(
                "DELETE FROM repos WHERE id = ?1",
                params![repo.id.to_string()],
            )
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        tx.commit()
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        Ok(())
    }

    pub fn remove_file_hashes_for_repo(&self, repo_id: Uuid, file_paths: &[&str]) -> Result<()> {
        for path in file_paths {
            self.conn
                .execute(
                    "DELETE FROM file_hashes WHERE repo_id = ?1 AND file_path = ?2",
                    params![repo_id.to_string(), path],
                )
                .map_err(|e| CoreError::StorageError(e.to_string()))?;
        }
        Ok(())
    }

    pub fn get_entity_by_id(&self, id: Uuid) -> Result<Option<Entity>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, repo_id, file_path, language, kind, name, qualified_name, signature, \
                 start_line, end_line, start_byte, end_byte, \
                 signature_hash, content_hash, structural_hash, identity_hash, context_hash, \
                 visibility, is_exported, is_async, is_test, \
                 first_seen_commit, last_seen_commit, deleted_at_commit \
                 FROM entities WHERE id = ?1 AND deleted_at_commit IS NULL",
            )
            .map_err(|e| CoreError::StorageError(e.to_string()))?;

        let result = stmt
            .query_row(params![id.to_string()], |row| Ok(row_to_entity(row)))
            .optional()
            .map_err(|e| CoreError::StorageError(e.to_string()))?;

        Ok(result)
    }

    pub fn get_entities_by_name(&self, name: &str, repo_id: Option<Uuid>) -> Result<Vec<Entity>> {
        let sql = match repo_id {
            Some(_) => {
                "SELECT id, repo_id, file_path, language, kind, name, qualified_name, signature, \
                 start_line, end_line, start_byte, end_byte, \
                 signature_hash, content_hash, structural_hash, identity_hash, context_hash, \
                 visibility, is_exported, is_async, is_test, \
                 first_seen_commit, last_seen_commit, deleted_at_commit \
                 FROM entities WHERE name = ?1 AND repo_id = ?2 AND deleted_at_commit IS NULL"
            }
            None => {
                "SELECT id, repo_id, file_path, language, kind, name, qualified_name, signature, \
                 start_line, end_line, start_byte, end_byte, \
                 signature_hash, content_hash, structural_hash, identity_hash, context_hash, \
                 visibility, is_exported, is_async, is_test, \
                 first_seen_commit, last_seen_commit, deleted_at_commit \
                 FROM entities WHERE name = ?1 AND deleted_at_commit IS NULL"
            }
        };

        let mut stmt = self
            .conn
            .prepare(sql)
            .map_err(|e| CoreError::StorageError(e.to_string()))?;

        let entities = match repo_id {
            Some(rid) => stmt
                .query_map(params![name, rid.to_string()], |row| Ok(row_to_entity(row)))
                .map_err(|e| CoreError::StorageError(e.to_string()))?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|e| CoreError::StorageError(e.to_string()))?,
            None => stmt
                .query_map(params![name], |row| Ok(row_to_entity(row)))
                .map_err(|e| CoreError::StorageError(e.to_string()))?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|e| CoreError::StorageError(e.to_string()))?,
        };

        Ok(entities)
    }

    pub fn get_edges_all(&self) -> Result<Vec<Edge>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, source_entity_id, target_entity_id, kind, confidence, \
                 source, metadata, created_at, validated_at FROM edges",
            )
            .map_err(|e| CoreError::StorageError(e.to_string()))?;

        let edges = stmt
            .query_map([], row_to_edge)
            .map_err(|e| CoreError::StorageError(e.to_string()))?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| CoreError::StorageError(e.to_string()))?;

        Ok(edges)
    }

    pub fn get_entities_all(&self) -> Result<Vec<Entity>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, repo_id, file_path, language, kind, name, qualified_name, signature, \
                 start_line, end_line, start_byte, end_byte, \
                 signature_hash, content_hash, structural_hash, identity_hash, context_hash, \
                 visibility, is_exported, is_async, is_test, \
                 first_seen_commit, last_seen_commit, deleted_at_commit \
                 FROM entities WHERE deleted_at_commit IS NULL",
            )
            .map_err(|e| CoreError::StorageError(e.to_string()))?;

        let entities = stmt
            .query_map([], |row| Ok(row_to_entity(row)))
            .map_err(|e| CoreError::StorageError(e.to_string()))?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| CoreError::StorageError(e.to_string()))?;

        Ok(entities)
    }

    pub fn get_public_api_surface(&self, repo_id: Uuid) -> Result<Vec<Entity>> {
        Ok(self
            .get_entities_by_repo(repo_id)?
            .into_iter()
            .filter(|e| e.is_exported && matches!(e.visibility, crosshash_core::Visibility::Public))
            .collect())
    }

    pub fn get_edges_by_repo(&self, repo_id: Uuid) -> Result<Vec<Edge>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT e.id, e.source_entity_id, e.target_entity_id, e.kind, e.confidence, \
                 e.source, e.metadata, e.created_at, e.validated_at \
                 FROM edges e \
                 INNER JOIN entities e1 ON e.source_entity_id = e1.id \
                 INNER JOIN entities e2 ON e.target_entity_id = e2.id \
                 WHERE e1.repo_id = ?1 OR e2.repo_id = ?1",
            )
            .map_err(|e| CoreError::StorageError(e.to_string()))?;

        let edges = stmt
            .query_map(params![repo_id.to_string()], row_to_edge)
            .map_err(|e| CoreError::StorageError(e.to_string()))?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| CoreError::StorageError(e.to_string()))?;

        Ok(edges)
    }

    pub fn get_edges_for_entity(&self, entity_id: Uuid) -> Result<Vec<Edge>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, source_entity_id, target_entity_id, kind, confidence, \
                 source, metadata, created_at, validated_at \
                 FROM edges WHERE source_entity_id = ?1 OR target_entity_id = ?1",
            )
            .map_err(|e| CoreError::StorageError(e.to_string()))?;

        let edges = stmt
            .query_map(params![entity_id.to_string()], row_to_edge)
            .map_err(|e| CoreError::StorageError(e.to_string()))?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| CoreError::StorageError(e.to_string()))?;

        Ok(edges)
    }

    /// Begin a transaction on this connection. The CLI's index write phase
    /// wraps its writes so a mid-index failure cannot leave a half-written
    /// repo (#320). unchecked_transaction keeps &self working.
    pub fn transaction(&self) -> rusqlite::Result<rusqlite::Transaction<'_>> {
        self.conn.unchecked_transaction()
    }

    pub fn remove_edges_for_repo(&self, repo_id: Uuid) -> Result<()> {
        // Only re-index-derived (Static) edges are removed. AI-inferred edges
        // — including user-accepted ones — and other repos' cross-repo edges
        // must survive a re-index (#318).
        self.conn
            .execute(
                "DELETE FROM edges WHERE source = ?1 \
                 AND (source_entity_id IN (SELECT id FROM entities WHERE repo_id = ?2) \
                 OR target_entity_id IN (SELECT id FROM entities WHERE repo_id = ?2))",
                // '"Static"' is the serde encoding of EdgeSource::Static,
                // matching how insert_edge stores the column.
                params!["\"Static\"".to_string(), repo_id.to_string()],
            )
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        Ok(())
    }

    pub fn get_stale_entities(&self, repo_id: Uuid, since_commit: &str) -> Result<Vec<Entity>> {
        let entities = self.get_entities_by_repo(repo_id)?;
        let stale: Vec<Entity> = entities
            .into_iter()
            .filter(|e| e.last_seen_commit != since_commit)
            .collect();
        Ok(stale)
    }

    pub fn get_entity_versions(&self, entity_id: Uuid) -> Result<Vec<EntityVersion>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT entity_id, commit_hash, name, qualified_name, signature, \
                 signature_hash, content_hash, structural_hash, identity_hash, context_hash, \
                 snapshot_at \
                 FROM entity_versions WHERE entity_id = ?1 ORDER BY snapshot_at DESC",
            )
            .map_err(|e| CoreError::StorageError(e.to_string()))?;

        let versions = stmt
            .query_map(params![entity_id.to_string()], |row| {
                let sig_hash: Vec<u8> = row.get(5).unwrap();
                let cont_hash: Vec<u8> = row.get(6).unwrap();
                let struct_hash: Vec<u8> = row.get(7).unwrap();
                let ident_hash: Vec<u8> = row.get(8).unwrap();
                let ctx_hash: Vec<u8> = row.get(9).unwrap();
                let snapshot_str: String = row.get(10).unwrap();

                let to_arr = |v: Vec<u8>| -> [u8; 32] { safe_hash_from_slice(&v) };

                Ok(EntityVersion {
                    entity_id: db_parse(Uuid::parse_str(&row.get::<_, String>(0).unwrap()))?,
                    commit_hash: row.get(1).unwrap(),
                    name: row.get(2).unwrap(),
                    qualified_name: row.get(3).unwrap(),
                    signature: row.get(4).unwrap(),
                    signature_hash: to_arr(sig_hash),
                    content_hash: to_arr(cont_hash),
                    structural_hash: to_arr(struct_hash),
                    identity_hash: to_arr(ident_hash),
                    context_hash: to_arr(ctx_hash),
                    snapshot_at: db_parse(chrono::DateTime::parse_from_rfc3339(&snapshot_str))?
                        .with_timezone(&chrono::Utc),
                })
            })
            .map_err(|e| CoreError::StorageError(e.to_string()))?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| CoreError::StorageError(e.to_string()))?;

        Ok(versions)
    }

    pub fn insert_ai_inference_log(
        &self,
        id: &Uuid,
        trigger_reason: &str,
        gate_decision: &str,
        repo_a: Option<&Uuid>,
        repo_b: Option<&Uuid>,
        input_tokens: u64,
        output_tokens: u64,
        estimated_cost_usd: f64,
        edges_suggested: usize,
        edges_auto_accepted: usize,
    ) -> Result<()> {
        self.conn
            .execute(
                "INSERT OR REPLACE INTO ai_inference_log \
                 (id, created_at, trigger_reason, gate_decision, repo_a, repo_b, \
                  input_tokens, output_tokens, estimated_cost_usd, edges_suggested, edges_auto_accepted) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    id.to_string(),
                    chrono::Utc::now().to_rfc3339(),
                    trigger_reason,
                    gate_decision,
                    repo_a.map(|u| u.to_string()),
                    repo_b.map(|u| u.to_string()),
                    input_tokens as i64,
                    output_tokens as i64,
                    estimated_cost_usd,
                    edges_suggested as i64,
                    edges_auto_accepted as i64,
                ],
            )
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        Ok(())
    }

    pub fn get_ai_inference_logs(&self, limit: usize) -> Result<Vec<serde_json::Value>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, created_at, trigger_reason, gate_decision, repo_a, repo_b, \
                 input_tokens, output_tokens, estimated_cost_usd, edges_suggested, edges_auto_accepted \
                 FROM ai_inference_log ORDER BY created_at DESC LIMIT ?1",
            )
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        let rows = stmt
            .query_map(params![limit as i64], |row| {
                let id: String = row.get(0)?;
                let created_at: String = row.get(1)?;
                let trigger_reason: String = row.get(2)?;
                let gate_decision: String = row.get(3)?;
                let repo_a: Option<String> = row.get(4)?;
                let repo_b: Option<String> = row.get(5)?;
                let input_tokens: i64 = row.get(6)?;
                let output_tokens: i64 = row.get(7)?;
                let estimated_cost_usd: f64 = row.get(8)?;
                let edges_suggested: i64 = row.get(9)?;
                let edges_auto_accepted: i64 = row.get(10)?;
                Ok(serde_json::json!({
                    "id": id,
                    "created_at": created_at,
                    "trigger_reason": trigger_reason,
                    "gate_decision": gate_decision,
                    "repo_a": repo_a,
                    "repo_b": repo_b,
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "estimated_cost_usd": estimated_cost_usd,
                    "edges_suggested": edges_suggested,
                    "edges_auto_accepted": edges_auto_accepted,
                }))
            })
            .map_err(|e| CoreError::StorageError(e.to_string()))?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        Ok(rows)
    }

    pub fn insert_ai_edge_suggestion(
        &self,
        id: &Uuid,
        exporter_entity_id: &Uuid,
        consumer_entity_id: &Uuid,
        edge_type: &str,
        reasoning: &str,
        confidence: f64,
        status: &str,
    ) -> Result<()> {
        self.conn
            .execute(
                "INSERT OR REPLACE INTO ai_edge_suggestions \
                 (id, exporter_entity_id, consumer_entity_id, edge_type, reasoning, confidence, status, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    id.to_string(),
                    exporter_entity_id.to_string(),
                    consumer_entity_id.to_string(),
                    edge_type,
                    reasoning,
                    confidence,
                    status,
                    chrono::Utc::now().to_rfc3339(),
                ],
            )
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        Ok(())
    }

    pub fn get_pending_suggestions(&self) -> Result<Vec<serde_json::Value>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, exporter_entity_id, consumer_entity_id, edge_type, reasoning, confidence, status, created_at \
                 FROM ai_edge_suggestions WHERE status = 'pending' ORDER BY created_at DESC",
            )
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        let rows = stmt
            .query_map([], |row| {
                let id: String = row.get(0)?;
                let exporter_entity_id: String = row.get(1)?;
                let consumer_entity_id: String = row.get(2)?;
                let edge_type: String = row.get(3)?;
                let reasoning: String = row.get(4)?;
                let confidence: f64 = row.get(5)?;
                let status: String = row.get(6)?;
                let created_at: String = row.get(7)?;
                Ok(serde_json::json!({
                    "id": id,
                    "exporter_entity_id": exporter_entity_id,
                    "consumer_entity_id": consumer_entity_id,
                    "edge_type": edge_type,
                    "reasoning": reasoning,
                    "confidence": confidence,
                    "status": status,
                    "created_at": created_at,
                }))
            })
            .map_err(|e| CoreError::StorageError(e.to_string()))?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        Ok(rows)
    }

    pub fn get_suggestion_by_id(&self, id: &Uuid) -> Result<Option<serde_json::Value>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, exporter_entity_id, consumer_entity_id, edge_type, reasoning, confidence, status, created_at \
                 FROM ai_edge_suggestions WHERE id = ?1",
            )
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        let result = stmt
            .query_row(params![id.to_string()], |row| {
                let id: String = row.get(0)?;
                let exporter_entity_id: String = row.get(1)?;
                let consumer_entity_id: String = row.get(2)?;
                let edge_type: String = row.get(3)?;
                let reasoning: String = row.get(4)?;
                let confidence: f64 = row.get(5)?;
                let status: String = row.get(6)?;
                let created_at: String = row.get(7)?;
                Ok(serde_json::json!({
                    "id": id,
                    "exporter_entity_id": exporter_entity_id,
                    "consumer_entity_id": consumer_entity_id,
                    "edge_type": edge_type,
                    "reasoning": reasoning,
                    "confidence": confidence,
                    "status": status,
                    "created_at": created_at,
                }))
            })
            .optional()
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        Ok(result)
    }

    pub fn update_suggestion_status(&self, id: &Uuid, status: &str) -> Result<()> {
        self.conn
            .execute(
                "UPDATE ai_edge_suggestions SET status = ?1 WHERE id = ?2",
                params![status, id.to_string()],
            )
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        Ok(())
    }

    pub fn insert_feedback(
        &self,
        id: &Uuid,
        suggestion_id: &Uuid,
        decision: &str,
        reason: Option<&str>,
    ) -> Result<()> {
        self.conn
            .execute(
                "INSERT OR REPLACE INTO feedback (id, suggestion_id, decision, reason, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    id.to_string(),
                    suggestion_id.to_string(),
                    decision,
                    reason,
                    chrono::Utc::now().to_rfc3339(),
                ],
            )
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        Ok(())
    }

    pub fn get_feedback_events(&self) -> Result<Vec<serde_json::Value>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT f.id, f.suggestion_id, f.decision, f.reason, f.created_at, \
                 s.edge_type, s.confidence \
                 FROM feedback f \
                 LEFT JOIN ai_edge_suggestions s ON f.suggestion_id = s.id \
                 ORDER BY f.created_at DESC",
            )
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        let rows = stmt
            .query_map([], |row| {
                let id: String = row.get(0)?;
                let suggestion_id: String = row.get(1)?;
                let decision: String = row.get(2)?;
                let reason: Option<String> = row.get(3)?;
                let created_at: String = row.get(4)?;
                let edge_type: Option<String> = row.get(5)?;
                let confidence: Option<f64> = row.get(6)?;
                Ok(serde_json::json!({
                    "id": id,
                    "suggestion_id": suggestion_id,
                    "decision": decision,
                    "reason": reason,
                    "created_at": created_at,
                    "edge_type": edge_type,
                    "confidence": confidence,
                }))
            })
            .map_err(|e| CoreError::StorageError(e.to_string()))?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        Ok(rows)
    }
}

fn safe_hash_from_slice(v: &[u8]) -> [u8; 32] {
    let mut arr = [0u8; 32];
    let len = v.len().min(32);
    arr[..len].copy_from_slice(&v[..len]);
    arr
}

/// Map a parse failure on DB-derived data to a rusqlite error so the caller's
/// map_err turns it into CoreError::StorageError instead of panicking on
/// corrupt/foreign rows (#325). Row mappers must not unwrap DB strings.
fn db_parse<T, E>(result: std::result::Result<T, E>) -> rusqlite::Result<T>
where
    E: std::error::Error + Send + Sync + 'static,
{
    result.map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))
}

fn row_to_edge(row: &rusqlite::Row) -> rusqlite::Result<Edge> {
    let kind_str: String = row.get("kind").unwrap();
    let source_str: String = row.get("source").unwrap();
    let metadata_str: Option<String> = row.get("metadata").unwrap_or(None);
    let created_at_str: String = row.get("created_at").unwrap();
    let validated_at_str: Option<String> = row.get("validated_at").unwrap_or(None);

    // Corrupt kind/source values are an error, NOT silently reclassified as
    // Calls/Static — that corrupted graph semantics invisibly (#327).
    Ok(Edge {
        id: db_parse(Uuid::parse_str(&row.get::<_, String>("id").unwrap()))?,
        source_entity_id: db_parse(Uuid::parse_str(
            &row.get::<_, String>("source_entity_id").unwrap(),
        ))?,
        target_entity_id: db_parse(Uuid::parse_str(
            &row.get::<_, String>("target_entity_id").unwrap(),
        ))?,
        kind: db_parse(serde_json::from_str(&kind_str))?,
        confidence: row.get("confidence").unwrap_or(1.0),
        source: db_parse(serde_json::from_str(&source_str))?,
        metadata: metadata_str.and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()),
        created_at: db_parse(chrono::DateTime::parse_from_rfc3339(&created_at_str))?.to_utc(),
        validated_at: validated_at_str.and_then(|s| {
            chrono::DateTime::parse_from_rfc3339(&s)
                .map(|d| d.to_utc())
                .ok()
        }),
    })
}

fn row_to_entity(row: &rusqlite::Row) -> Entity {
    let sig_hash: Vec<u8> = row.get("signature_hash").unwrap();
    let cont_hash: Vec<u8> = row.get("content_hash").unwrap();
    let struct_hash: Vec<u8> = row.get("structural_hash").unwrap();
    let ident_hash: Vec<u8> = row.get("identity_hash").unwrap();
    let ctx_hash: Vec<u8> = row.get("context_hash").unwrap();

    let to_arr = |v: Vec<u8>| -> [u8; 32] { safe_hash_from_slice(&v) };

    Entity {
        id: Uuid::parse_str(&row.get::<_, String>("id").unwrap()).unwrap(),
        repo_id: Uuid::parse_str(&row.get::<_, String>("repo_id").unwrap()).unwrap(),
        file_path: row.get("file_path").unwrap(),
        language: serde_json::from_str(&row.get::<_, String>("language").unwrap()).unwrap(),
        kind: serde_json::from_str(&row.get::<_, String>("kind").unwrap()).unwrap(),
        name: row.get("name").unwrap(),
        qualified_name: row.get("qualified_name").unwrap(),
        signature: row.get("signature").unwrap(),
        start_line: row.get("start_line").unwrap(),
        end_line: row.get("end_line").unwrap(),
        start_byte: row.get("start_byte").unwrap(),
        end_byte: row.get("end_byte").unwrap(),
        signature_hash: to_arr(sig_hash),
        content_hash: to_arr(cont_hash),
        structural_hash: to_arr(struct_hash),
        identity_hash: to_arr(ident_hash),
        context_hash: to_arr(ctx_hash),
        visibility: serde_json::from_str(&row.get::<_, String>("visibility").unwrap()).unwrap(),
        is_exported: row.get("is_exported").unwrap(),
        is_async: row.get("is_async").unwrap(),
        is_test: row.get("is_test").unwrap(),
        first_seen_commit: row.get("first_seen_commit").unwrap(),
        last_seen_commit: row.get("last_seen_commit").unwrap(),
        deleted_at_commit: row.get("deleted_at_commit").unwrap(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crosshash_core::{EdgeKind, EdgeSource, EntityKind, Language, Visibility, WorkspaceType};

    fn test_repo() -> Repo {
        Repo {
            id: Uuid::now_v7(),
            name: "test-repo".to_string(),
            root_path: "/tmp/test-repo".to_string(),
            git_remote: Some("https://github.com/example/test-repo".to_string()),
            default_branch: "main".to_string(),
            languages: vec![Language::Rust],
            workspace_type: WorkspaceType::None,
            last_indexed_at: chrono::Utc::now(),
            commit_hash: "abc123".to_string(),
        }
    }

    fn test_entity(repo_id: Uuid) -> Entity {
        Entity {
            id: Uuid::now_v7(),
            repo_id,
            file_path: "src/lib.rs".to_string(),
            language: Language::Rust,
            kind: EntityKind::Function,
            name: "hello".to_string(),
            qualified_name: "myapp::hello".to_string(),
            signature: "fn hello() -> String".to_string(),
            start_line: 1,
            end_line: 3,
            start_byte: 0,
            end_byte: 30,
            signature_hash: [1u8; 32],
            content_hash: [2u8; 32],
            structural_hash: [3u8; 32],
            identity_hash: [4u8; 32],
            context_hash: [5u8; 32],
            visibility: Visibility::Public,
            is_exported: true,
            is_async: false,
            is_test: false,
            first_seen_commit: "abc123".to_string(),
            last_seen_commit: "abc123".to_string(),
            deleted_at_commit: None,
        }
    }

    #[test]
    fn test_open_in_memory() {
        let storage = GraphStorage::open_in_memory();
        assert!(storage.is_ok());
    }

    #[test]
    fn test_insert_and_get_repo() {
        let storage = GraphStorage::open_in_memory().unwrap();
        let repo = test_repo();
        storage.insert_repo(&repo).unwrap();

        let retrieved = storage.get_repo(repo.id).unwrap();
        assert!(retrieved.is_some());
        let retrieved = retrieved.unwrap();
        assert_eq!(retrieved.name, "test-repo");
        assert_eq!(retrieved.root_path, "/tmp/test-repo");
    }

    #[test]
    fn test_list_repos() {
        let storage = GraphStorage::open_in_memory().unwrap();
        let repo = test_repo();
        storage.insert_repo(&repo).unwrap();

        let repos = storage.list_repos().unwrap();
        assert_eq!(repos.len(), 1);
        assert_eq!(repos[0].name, "test-repo");
    }

    #[test]
    fn test_insert_entity() {
        let storage = GraphStorage::open_in_memory().unwrap();
        let repo = test_repo();
        storage.insert_repo(&repo).unwrap();

        let entity = test_entity(repo.id);
        storage.insert_entity(&entity).unwrap();
    }

    #[test]
    fn test_insert_edge() {
        let storage = GraphStorage::open_in_memory().unwrap();
        let repo = test_repo();
        storage.insert_repo(&repo).unwrap();

        let entity_a = test_entity(repo.id);
        let mut entity_b = test_entity(repo.id);
        entity_b.id = Uuid::now_v7();
        entity_b.name = "world".to_string();
        storage.insert_entity(&entity_a).unwrap();
        storage.insert_entity(&entity_b).unwrap();

        let edge = Edge {
            id: Uuid::now_v7(),
            source_entity_id: entity_a.id,
            target_entity_id: entity_b.id,
            kind: EdgeKind::Calls,
            confidence: 1.0,
            source: EdgeSource::Static,
            metadata: None,
            created_at: chrono::Utc::now(),
            validated_at: None,
        };
        storage.insert_edge(&edge).unwrap();
    }

    #[test]
    fn test_remove_edges_for_repo_preserves_non_static() {
        let storage = GraphStorage::open_in_memory().unwrap();
        let repo = test_repo();
        storage.insert_repo(&repo).unwrap();

        let entity_a = test_entity(repo.id);
        let mut entity_b = test_entity(repo.id);
        entity_b.id = Uuid::now_v7();
        entity_b.name = "world".to_string();
        storage.insert_entity(&entity_a).unwrap();
        storage.insert_entity(&entity_b).unwrap();

        let mk = |source: EdgeSource, kind: EdgeKind| Edge {
            id: Uuid::now_v7(),
            source_entity_id: entity_a.id,
            target_entity_id: entity_b.id,
            kind,
            confidence: 1.0,
            source,
            metadata: None,
            created_at: chrono::Utc::now(),
            validated_at: None,
        };

        storage
            .insert_edge(&mk(EdgeSource::Static, EdgeKind::Calls))
            .unwrap();
        storage
            .insert_edge(&mk(EdgeSource::AiInferred, EdgeKind::Calls))
            .unwrap();

        storage.remove_edges_for_repo(repo.id).unwrap();

        let remaining = storage
            .conn
            .prepare("SELECT COUNT(*) FROM edges")
            .unwrap()
            .query_row([], |row| row.get::<_, i64>(0))
            .unwrap();
        // Only the Static edge is re-index-derived; the user-facing
        // AiInferred edge must survive (issue #318).
        assert_eq!(remaining, 1);
    }

    #[test]
    fn test_insert_entity_version() {
        let storage = GraphStorage::open_in_memory().unwrap();
        let repo = test_repo();
        storage.insert_repo(&repo).unwrap();

        let entity = test_entity(repo.id);
        storage.insert_entity(&entity).unwrap();

        let version = EntityVersion {
            entity_id: entity.id,
            commit_hash: "abc123".to_string(),
            name: entity.name.clone(),
            qualified_name: entity.qualified_name.clone(),
            signature: entity.signature.clone(),
            signature_hash: entity.signature_hash,
            content_hash: entity.content_hash,
            structural_hash: entity.structural_hash,
            identity_hash: entity.identity_hash,
            context_hash: entity.context_hash,
            snapshot_at: chrono::Utc::now(),
        };
        storage.insert_entity_version(&version).unwrap();
    }

    #[test]
    fn test_file_hash_crud() {
        let storage = GraphStorage::open_in_memory().unwrap();
        let repo = test_repo();
        storage.insert_repo(&repo).unwrap();
        let hash = [42u8; 32];

        storage
            .upsert_file_hash(repo.id, "src/lib.rs", &hash)
            .unwrap();

        let retrieved = storage.get_file_hash(repo.id, "src/lib.rs").unwrap();
        assert!(retrieved.is_some());
        assert_eq!(retrieved.unwrap(), hash);
    }

    #[test]
    fn test_get_nonexistent_repo() {
        let storage = GraphStorage::open_in_memory().unwrap();
        let result = storage.get_repo(Uuid::now_v7()).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_migration_idempotent() {
        let storage = GraphStorage::open_in_memory().unwrap();
        let mut storage2 = storage;
        storage2.run_migrations().unwrap();
    }

    #[test]
    fn test_ai_inference_log_crud() {
        let storage = GraphStorage::open_in_memory().unwrap();
        let id = Uuid::now_v7();
        let repo_a = Uuid::now_v7();
        storage
            .insert_ai_inference_log(
                &id,
                "NewExports",
                "run-ai",
                Some(&repo_a),
                None,
                100,
                50,
                0.003,
                3,
                2,
            )
            .unwrap();
        let logs = storage.get_ai_inference_logs(10).unwrap();
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0]["trigger_reason"], "NewExports");
        assert_eq!(logs[0]["edges_suggested"], 3);
    }

    #[test]
    fn test_ai_edge_suggestion_lifecycle() {
        let storage = GraphStorage::open_in_memory().unwrap();
        let id = Uuid::now_v7();
        let exporter = Uuid::now_v7();
        let consumer = Uuid::now_v7();
        storage
            .insert_ai_edge_suggestion(
                &id,
                &exporter,
                &consumer,
                "APIContract",
                "test",
                0.9,
                "pending",
            )
            .unwrap();
        let pending = storage.get_pending_suggestions().unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0]["status"], "pending");
        storage.update_suggestion_status(&id, "accepted").unwrap();
        let found = storage.get_suggestion_by_id(&id).unwrap().unwrap();
        assert_eq!(found["status"], "accepted");
        let pending_after = storage.get_pending_suggestions().unwrap();
        assert!(pending_after.is_empty());
    }

    #[test]
    fn test_feedback_crud() {
        let storage = GraphStorage::open_in_memory().unwrap();
        let suggestion_id = Uuid::now_v7();
        let exporter = Uuid::now_v7();
        let consumer = Uuid::now_v7();
        storage
            .insert_ai_edge_suggestion(
                &suggestion_id,
                &exporter,
                &consumer,
                "DataFlow",
                "reasoning",
                0.88,
                "pending",
            )
            .unwrap();
        let fb_id = Uuid::now_v7();
        storage
            .insert_feedback(&fb_id, &suggestion_id, "accept", Some("correct"))
            .unwrap();
        let events = storage.get_feedback_events().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["decision"], "accept");
    }

    #[test]
    fn test_update_suggestion_status_to_rejected() {
        let storage = GraphStorage::open_in_memory().unwrap();
        let id = Uuid::now_v7();
        let exporter = Uuid::now_v7();
        let consumer = Uuid::now_v7();
        storage
            .insert_ai_edge_suggestion(
                &id,
                &exporter,
                &consumer,
                "APIContract",
                "test",
                0.88,
                "pending",
            )
            .unwrap();
        storage.update_suggestion_status(&id, "rejected").unwrap();
        let found = storage.get_suggestion_by_id(&id).unwrap().unwrap();
        assert_eq!(found["status"], "rejected");
        let pending = storage.get_pending_suggestions().unwrap();
        assert!(pending.is_empty());
    }

    #[test]
    fn test_get_ai_inference_logs_respects_limit() {
        let storage = GraphStorage::open_in_memory().unwrap();
        for i in 0..5 {
            let id = Uuid::now_v7();
            storage
                .insert_ai_inference_log(
                    &id,
                    "NewExports",
                    "all",
                    None,
                    None,
                    i as u64 * 10,
                    i as u64 * 5,
                    0.001 * i as f64,
                    i,
                    0,
                )
                .unwrap();
        }
        let logs = storage.get_ai_inference_logs(3).unwrap();
        assert_eq!(logs.len(), 3);
        let all_logs = storage.get_ai_inference_logs(100).unwrap();
        assert_eq!(all_logs.len(), 5);
    }
}
