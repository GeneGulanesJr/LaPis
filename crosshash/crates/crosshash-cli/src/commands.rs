use anyhow::{anyhow, Result};
use chrono::Utc;
use clap::{Args, Parser, Subcommand, ValueEnum};
use crosshash_core::{
    Edge, EdgeKind, EdgeSource, Entity, EntityVersion, Language, Repo, WorkspaceType,
};
use crosshash_git::get_head_commit;
use crosshash_graph::{GraphBuilder, GraphStorage, GraphTraversal, StaticEdgeExtractor};
use crosshash_hash::hash_file_content;
use crosshash_parser::languages::bash::BashExtractor;
use crosshash_parser::languages::c::CExtractor;
use crosshash_parser::languages::cpp::CppExtractor;
use crosshash_parser::languages::csharp::CSharpExtractor;
use crosshash_parser::languages::dart::DartExtractor;
use crosshash_parser::languages::elixir::ElixirExtractor;
use crosshash_parser::languages::go::GoExtractor;
use crosshash_parser::languages::java::JavaExtractor;
use crosshash_parser::languages::javascript::JavaScriptExtractor;
use crosshash_parser::languages::kotlin::KotlinExtractor;
use crosshash_parser::languages::ocaml::OcamlExtractor;
use crosshash_parser::languages::php::PhpExtractor;
use crosshash_parser::languages::python::PythonExtractor;
use crosshash_parser::languages::ruby::RubyExtractor;
use crosshash_parser::languages::rust::RustExtractor;
use crosshash_parser::languages::scala::ScalaExtractor;
use crosshash_parser::languages::swift::SwiftExtractor;
use crosshash_parser::languages::typescript::TypeScriptExtractor;
use crosshash_parser::languages::zig::ZigExtractor;
use crosshash_parser::{
    collect_source_files, detect_language, EntityExtractor, ParserConfig, ParserEngine,
};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;
use uuid::Uuid;

use crate::output::render_message;
use notify::Watcher;

#[derive(Debug, Clone, Parser)]
#[command(
    name = "crosshash",
    version,
    about = "Cross-repo structural impact analysis"
)]
pub struct Cli {
    #[arg(long, value_enum, default_value_t = OutputFormat::Text, global = true)]
    pub format: OutputFormat,
    #[arg(long, global = true, env = "CROSSHASH_DB")]
    pub db: Option<PathBuf>,
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum OutputFormat {
    Text,
    Json,
}

#[derive(Debug, Clone, Subcommand)]
pub enum Command {
    Repo(RepoCommand),
    Index(IndexCommand),
    DiscoverEdges(DiscoverEdgesCommand),
    Impact(ImpactCommand),
    Entity(EntityCommand),
    Graph(GraphCommand),
    Feedback(FeedbackCommand),
    AiStats(AiStatsCommand),
    Serve(ServeCommand),
    Watch(WatchCommand),
    Mcp(McpCommand),
}

#[derive(Debug, Clone, Args)]
pub struct RepoCommand {
    #[command(subcommand)]
    pub action: RepoAction,
}

#[derive(Debug, Clone, Subcommand)]
pub enum RepoAction {
    Add {
        path: String,
        #[arg(long)]
        name: String,
        #[arg(long)]
        workspace_aware: bool,
    },
    List,
    Remove {
        name: String,
    },
    Info {
        name: String,
    },
}

#[derive(Debug, Clone, Args)]
pub struct IndexCommand {
    #[arg(long)]
    pub repo: Option<String>,
    #[arg(long)]
    pub incremental: bool,
    #[arg(long)]
    pub no_ai: bool,
    #[arg(long)]
    pub force_ai: bool,
}

#[derive(Debug, Clone, Args)]
pub struct DiscoverEdgesCommand {
    #[arg(long)]
    pub repo: Option<String>,
    #[arg(long)]
    pub no_ai: bool,
    #[arg(long)]
    pub force_ai: bool,
    #[arg(long)]
    pub static_only: bool,
    #[arg(long)]
    pub dry_run: bool,
    #[arg(long)]
    pub validate: bool,
}
#[derive(Debug, Clone, Args)]
pub struct ImpactCommand {
    #[arg(long)]
    pub entity: Option<String>,
    #[arg(long)]
    pub source: Option<String>,
    #[arg(long, value_delimiter = ',')]
    pub target: Vec<String>,
    #[arg(long)]
    pub all: bool,
    #[arg(long)]
    pub commit: Option<String>,
    #[arg(long)]
    pub diff: bool,
    #[arg(long, value_enum, default_value_t = ImpactOutputFormat::Json)]
    pub output: ImpactOutputFormat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum ImpactOutputFormat {
    Json,
    Markdown,
    Sarif,
}
#[derive(Debug, Clone, Args)]
pub struct EntityCommand {
    #[command(subcommand)]
    pub action: EntityAction,
}
#[derive(Debug, Clone, Subcommand)]
pub enum EntityAction {
    Lookup {
        name: String,
        #[arg(long)]
        repo: Option<String>,
        #[arg(long)]
        all: bool,
    },
    Hash {
        name: String,
        #[arg(long)]
        repo: String,
    },
}
#[derive(Debug, Clone, Args)]
pub struct GraphCommand {
    #[command(subcommand)]
    pub action: GraphAction,
}
#[derive(Debug, Clone, Subcommand)]
pub enum GraphAction {
    Callers {
        name: String,
        #[arg(long)]
        repo: Option<String>,
        #[arg(long)]
        cross_repo: bool,
        #[arg(long, default_value_t = 2)]
        depth: usize,
    },
    Callees {
        name: String,
        #[arg(long)]
        repo: Option<String>,
        #[arg(long)]
        cross_repo: bool,
        #[arg(long, default_value_t = 2)]
        depth: usize,
    },
    BlastRadius {
        name: String,
        #[arg(long)]
        repo: Option<String>,
        #[arg(long)]
        cross_repo: bool,
    },
    Cycles {
        #[arg(long)]
        repo: String,
    },
    ValidateEdges {
        #[arg(long)]
        repo: String,
    },
    PathBetween {
        source: String,
        target: String,
        #[arg(long)]
        repo: Option<String>,
    },
}
#[derive(Debug, Clone, Args)]
pub struct FeedbackCommand {
    #[command(subcommand)]
    pub action: Option<FeedbackAction>,
}
#[derive(Debug, Clone, Subcommand)]
pub enum FeedbackAction {
    Accept { edge_id: String },
    Reject { edge_id: String },
    Stats,
    Export,
}
#[derive(Debug, Clone, Args)]
pub struct AiStatsCommand {}

#[derive(Debug, Clone, Args)]
pub struct ServeCommand {
    #[arg(long, default_value = "127.0.0.1:3000")]
    pub addr: String,
    #[arg(long)]
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, Args)]
pub struct WatchCommand {
    #[arg(long)]
    pub repo: Option<String>,
    #[arg(long, default_value_t = 2000)]
    pub debounce_ms: u64,
}

#[derive(Debug, Clone, Args)]
pub struct McpCommand {}

impl Cli {
    pub async fn execute_async(self) -> Result<()> {
        match self.command {
            Command::Repo(cmd) => execute_repo(self.format, self.db, cmd),
            Command::Index(cmd) => execute_index(self.format, self.db, cmd).await,
            Command::Entity(cmd) => execute_entity(self.format, self.db, cmd),
            Command::Graph(cmd) => execute_graph(self.format, self.db, cmd),
            Command::DiscoverEdges(cmd) => execute_discover_edges(self.format, self.db, cmd).await,
            Command::Impact(cmd) => execute_impact(self.format, self.db, cmd),
            Command::Feedback(cmd) => execute_feedback(self.format, self.db, cmd),
            Command::AiStats(cmd) => execute_ai_stats(self.format, self.db, cmd),
            Command::Serve(cmd) => execute_serve(self.format, self.db, cmd).await,
            Command::Watch(cmd) => execute_watch(self.format, self.db, cmd).await,
            Command::Mcp(cmd) => execute_mcp(self.format, self.db, cmd),
        }
    }
}

fn execute_repo(format: OutputFormat, db: Option<PathBuf>, cmd: RepoCommand) -> Result<()> {
    let storage = open_storage(db)?;
    match cmd.action {
        RepoAction::Add {
            path,
            name,
            workspace_aware,
        } => {
            let root = PathBuf::from(&path).canonicalize()?;
            let repo = Repo {
                id: Uuid::now_v7(),
                name: name.clone(),
                root_path: root.to_string_lossy().to_string(),
                git_remote: None,
                default_branch: "main".into(),
                languages: detect_languages(&root)?,
                workspace_type: detect_workspace_type(&root, workspace_aware),
                last_indexed_at: Utc::now(),
                commit_hash: get_head_commit(&root).unwrap_or_else(|_| "WORKTREE".into()),
            };
            validate_repo_has_sources(&root)?;
            storage.insert_repo(&repo)?;
            print(
                format,
                &format!("added repo {name}"),
                json!({"status":"ok","repo": repo}),
            )
        }
        RepoAction::List => {
            let repos = storage.list_repos()?;
            let text = repos
                .iter()
                .map(|r| format!("{}\t{}", r.name, r.root_path))
                .collect::<Vec<_>>()
                .join("\n");
            print(
                format,
                if text.is_empty() { "no repos" } else { &text },
                json!({"repos": repos}),
            )
        }
        RepoAction::Remove { name } => {
            storage.remove_repo(&name)?;
            print(
                format,
                &format!("removed repo {name}"),
                json!({"status":"ok","removed": name}),
            )
        }
        RepoAction::Info { name } => {
            let repo = storage
                .get_repo_by_name(&name)?
                .ok_or_else(|| anyhow!("repo not found: {name}"))?;
            let entities = storage.get_entities_by_repo(repo.id)?;
            let exports = storage.get_public_api_surface(repo.id)?;
            let edges = storage.get_edges_by_repo(repo.id)?;
            print(
                format,
                &format!(
                    "{}\npath: {}\nworkspace: {:?}\nentities: {}\nexports: {}\nedges: {}",
                    repo.name,
                    repo.root_path,
                    repo.workspace_type,
                    entities.len(),
                    exports.len(),
                    edges.len()
                ),
                json!({"repo": repo, "entities": entities.len(), "exports": exports.len(), "edges": edges.len()}),
            )
        }
    }
}

async fn execute_index(format: OutputFormat, db: Option<PathBuf>, cmd: IndexCommand) -> Result<()> {
    let storage = open_storage(db)?;
    if cmd.repo.is_none() {
        let repos = storage.list_repos()?;
        let mut summaries = Vec::new();
        for repo in repos {
            summaries.push(index_one_repo(&storage, &repo, cmd.incremental, &cmd).await?);
        }
        return print(
            format,
            &format!("indexed {} repos", summaries.len()),
            json!({"status":"ok","repos": summaries}),
        );
    }
    let repo_name = cmd.repo.as_deref().unwrap();
    let repo = storage
        .get_repo_by_name(repo_name)?
        .ok_or_else(|| anyhow!("repo not found: {repo_name}"))?;
    let summary = index_one_repo(&storage, &repo, cmd.incremental, &cmd).await?;
    print(format, &summary.text, json!(summary))
}

#[derive(Debug, serde::Serialize)]
struct IndexSummary {
    status: &'static str,
    repo: String,
    files_parsed: usize,
    files_skipped: usize,
    entities_extracted: usize,
    edges: usize,
    entities_deleted: usize,
    exports: usize,
    ai_edges_suggested: usize,
    ai_edges_auto_accepted: usize,
    ai_cost: f64,
    gate_decision: Option<String>,
    text: String,
}

async fn index_one_repo(
    storage: &GraphStorage,
    repo: &Repo,
    incremental: bool,
    cmd: &IndexCommand,
) -> Result<IndexSummary> {
    let root = PathBuf::from(&repo.root_path);
    let commit_hash = get_head_commit(&root).unwrap_or_else(|_| repo.commit_hash.clone());
    let files = collect_source_files(&root, &repo.languages)?;
    let parser = ParserEngine::new(ParserConfig {
        languages: repo.languages.clone(),
    });
    let existing = storage.get_entities_by_repo(repo.id)?;
    let existing_exported: HashSet<Uuid> = existing
        .iter()
        .filter(|e| e.is_exported)
        .map(|e| e.id)
        .collect();
    let is_new_repo = existing.is_empty();
    let mut seen_ids = HashSet::new();
    let mut parsed_files = 0usize;
    let mut skipped_files = 0usize;
    let mut extracted = 0usize;
    let mut all_entities = Vec::new();
    let mut source_by_file = HashMap::new();
    let mut exported_added = 0usize;

    for file in files {
        let rel = file
            .strip_prefix(&root)
            .unwrap_or(&file)
            .to_string_lossy()
            .to_string();
        let source = std::fs::read_to_string(&file)?;
        source_by_file.insert(rel.clone(), source.clone());
        let file_hash = hash_file_content(&source);
        if incremental
            && storage
                .get_file_hash(repo.id, &rel)?
                .is_some_and(|h| h == file_hash)
        {
            skipped_files += 1;
            for entity in existing.iter().filter(|e| e.file_path == rel) {
                seen_ids.insert(entity.id);
                all_entities.push(entity.clone());
            }
            continue;
        }
        let Some(language) = detect_language(&file)? else {
            continue;
        };
        // Skip languages that don't support entity extraction
        if matches!(language, Language::Html | Language::Css | Language::Unknown) {
            skipped_files += 1;
            continue;
        }
        let parsed = parser.parse_file(&file, language)?;
        let entities = extract_for_language(
            language,
            repo.id,
            &root,
            &file,
            &parsed.source,
            &parsed.tree,
            &commit_hash,
        )?;
        parsed_files += 1;
        for entity in entities {
            seen_ids.insert(entity.id);
            storage.insert_entity(&entity)?;
            storage.insert_entity_version(&version_for(&entity, &commit_hash))?;
            let is_new_export = entity.is_exported && !existing_exported.contains(&entity.id);
            all_entities.push(entity);
            extracted += 1;
            if is_new_export {
                exported_added += 1;
            }
        }
        storage.upsert_file_hash(repo.id, &rel, &file_hash)?;
    }

    let deleted_ids: Vec<Uuid> = existing
        .into_iter()
        .filter(|e| !seen_ids.contains(&e.id))
        .map(|e| e.id)
        .collect();
    let exported_deleted = deleted_ids
        .iter()
        .filter(|id| existing_exported.contains(id))
        .count();
    storage.mark_entities_deleted(repo.id, &deleted_ids, &commit_hash)?;
    storage.remove_edges_for_repo(repo.id)?;
    let edges = infer_static_edges(repo.id, &root, &all_entities, &source_by_file);
    for edge in &edges {
        storage.insert_edge(edge)?;
    }
    let cross_repo_edges =
        infer_cross_repo_edges(storage, repo.id, &all_entities, &source_by_file)?;
    for edge in &cross_repo_edges {
        storage.insert_edge(edge)?;
    }
    let edge_count = edges.len() + cross_repo_edges.len();
    let exports = storage.get_public_api_surface(repo.id)?.len();

    let mut ai_edges_suggested = 0usize;
    let mut ai_edges_auto_accepted = 0usize;
    let mut ai_cost = 0.0f64;
    let mut gate_decision_str: Option<String> = None;

    if !cmd.no_ai {
        let ai_config = load_ai_config();
        let decision = crosshash_ai::AiGate::decide(&crosshash_ai::GateInput {
            ai_enabled: ai_config.enabled,
            auto_gate: ai_config.auto_gate,
            no_ai: false,
            force_ai: cmd.force_ai,
            new_repo: is_new_repo,
            exported_added,
            exported_signature_changed: 0,
            exported_deleted,
            body_only_changed: 0,
            commits_since_validation: 0,
            days_since_validation: 0,
        });
        gate_decision_str = Some(format!(
            "{:?}",
            decision
                .reasons
                .first()
                .unwrap_or(&crosshash_ai::GateReason::NoApiSurfaceChange)
        ));
        if decision.should_run_ai && ai_config.enabled {
            let other_repos = storage
                .list_repos()?
                .into_iter()
                .filter(|r| r.id != repo.id)
                .collect::<Vec<_>>();
            if !other_repos.is_empty() {
                let client = crosshash_ai::LlmClient::default();
                let llm_request = crosshash_ai::LlmRequest {
                    provider: ai_config.provider(),
                    endpoint: ai_config.endpoint(),
                    api_key: ai_config.api_key(),
                    model: ai_config.model.clone(),
                    prompt: String::new(),
                    temperature: ai_config.temperature,
                    max_tokens: ai_config.max_tokens,
                };
                let mut languages = HashSet::new();
                languages.extend(repo.languages.iter().map(|l| format!("{l:?}")));
                for other in &other_repos {
                    languages.extend(other.languages.iter().map(|l| format!("{l:?}")));
                }
                let mut engine = crosshash_ai::EdgeInferenceEngine {
                    auto_accept_threshold: ai_config.confidence_auto_accept,
                    languages: languages.into_iter().collect(),
                    feedback: Vec::new(),
                };
                let feedback_rows = storage.get_feedback_events()?;
                engine.feedback = feedback_rows
                    .into_iter()
                    .filter_map(|row| {
                        let edge_type = match row.get("edge_type")?.as_str()?.trim() {
                            "SharedType" => crosshash_ai::InferredEdgeType::SharedType,
                            "DataFlow" => crosshash_ai::InferredEdgeType::DataFlow,
                            "EventContract" => crosshash_ai::InferredEdgeType::EventContract,
                            _ => crosshash_ai::InferredEdgeType::APIContract,
                        };
                        let decision = match row.get("decision")?.as_str()? {
                            "reject" => crosshash_ai::FeedbackDecision::Reject,
                            _ => crosshash_ai::FeedbackDecision::Accept,
                        };
                        let confidence = row
                            .get("confidence")
                            .and_then(|v| v.as_f64())
                            .unwrap_or(0.5);
                        let suggestion_id = row
                            .get("suggestion_id")
                            .and_then(|v| v.as_str())
                            .and_then(|s| Uuid::parse_str(s).ok())?;
                        Some(crosshash_ai::FeedbackEvent {
                            suggestion_id,
                            edge_type,
                            language: String::new(),
                            confidence,
                            decision,
                        })
                    })
                    .collect();
                let current_exports = storage.get_public_api_surface(repo.id)?;
                let current_surface =
                    crosshash_ai::ApiSurface::from_exported_entities(repo.id, current_exports);
                for other in &other_repos {
                    let other_exports = storage.get_public_api_surface(other.id)?;
                    if other_exports.is_empty() {
                        continue;
                    }
                    let other_surface =
                        crosshash_ai::ApiSurface::from_exported_entities(other.id, other_exports);
                    let (exporter, consumer, surface_a, surface_b) = if is_new_repo {
                        (&other.id, &repo.id, &other_surface, &current_surface)
                    } else {
                        (&repo.id, &other.id, &current_surface, &other_surface)
                    };
                    match engine
                        .infer(&client, &llm_request, surface_a, surface_b)
                        .await
                    {
                        Ok(suggestions) => {
                            let suggested = suggestions.len();
                            let auto_accepted = engine.accept_high_confidence(&suggestions);
                            let auto_count = auto_accepted.len();
                            for edge in &auto_accepted {
                                let _ = storage.insert_edge(edge);
                            }
                            for suggestion in &suggestions {
                                let status =
                                    if suggestion.confidence >= engine.auto_accept_threshold {
                                        "accepted"
                                    } else {
                                        "pending"
                                    };
                                let _ = storage.insert_ai_edge_suggestion(
                                    &suggestion.id,
                                    &suggestion.exporter_entity_id,
                                    &suggestion.consumer_entity_id,
                                    &format!("{:?}", suggestion.edge_type),
                                    &suggestion.reasoning,
                                    suggestion.confidence,
                                    status,
                                );
                            }
                            let input_est = surface_a.entities.len() as u64 * 4;
                            let output_est = suggested as u64 * 20;
                            let cost = (input_est + output_est) as f64 * 0.00001;
                            let log_id = Uuid::now_v7();
                            let reason_str = format!(
                                "{:?}",
                                decision
                                    .reasons
                                    .first()
                                    .unwrap_or(&crosshash_ai::GateReason::Forced)
                            );
                            let _ = storage.insert_ai_inference_log(
                                &log_id,
                                &reason_str,
                                &decision.scope,
                                Some(exporter),
                                Some(consumer),
                                input_est,
                                output_est,
                                cost,
                                suggested,
                                auto_count,
                            );
                            ai_edges_suggested += suggested;
                            ai_edges_auto_accepted += auto_count;
                            ai_cost += cost;
                        }
                        Err(e) => {
                            eprintln!(
                                "AI inference failed for {} vs {}: {}",
                                repo.name, other.name, e
                            );
                        }
                    }
                }
            }
        }
    }

    let mut text = format!("indexed {}: {parsed_files} files parsed, {skipped_files} files skipped, {extracted} entities extracted, {edge_count} edges, {exports} exports, {} deleted", repo.name, deleted_ids.len());
    if ai_edges_suggested > 0 {
        text.push_str(&format!(", AI edges: {ai_edges_suggested} suggested, {ai_edges_auto_accepted} auto-accepted, ${ai_cost:.4} cost"));
    }
    if let Some(ref gate) = gate_decision_str {
        text.push_str(&format!(
            ", gate={}",
            if cmd.no_ai { "skipped (--no-ai)" } else { gate }
        ));
    }
    Ok(IndexSummary {
        status: "ok",
        repo: repo.name.clone(),
        files_parsed: parsed_files,
        files_skipped: skipped_files,
        entities_extracted: extracted,
        edges: edge_count,
        entities_deleted: deleted_ids.len(),
        exports,
        ai_edges_suggested,
        ai_edges_auto_accepted,
        ai_cost,
        gate_decision: gate_decision_str,
        text,
    })
}

fn execute_entity(format: OutputFormat, db: Option<PathBuf>, cmd: EntityCommand) -> Result<()> {
    let storage = open_storage(db)?;
    match cmd.action {
        EntityAction::Lookup { name, repo, all } => {
            let repo_id = if all {
                None
            } else {
                match repo {
                    Some(repo) => storage.get_repo_by_name(&repo)?.map(|r| r.id),
                    None => None,
                }
            };
            let entities = storage.get_entities_by_name(&name, repo_id)?;
            let text = entities
                .iter()
                .map(|e| format!("{}\t{}\t{:?}", e.qualified_name, e.file_path, e.kind))
                .collect::<Vec<_>>()
                .join("\n");
            print(
                format,
                if text.is_empty() {
                    "no entities"
                } else {
                    &text
                },
                json!({"entities": entities}),
            )
        }
        EntityAction::Hash { name, repo } => {
            let repo = storage
                .get_repo_by_name(&repo)?
                .ok_or_else(|| anyhow!("repo not found: {repo}"))?;
            let entity = resolve_entity(&storage, &name, repo.id)?;
            let text = format!(
                "{}\nsignature: {}\ncontent: {}\nstructural: {}\nidentity: {}\ncontext: {}",
                entity.qualified_name,
                hex_hash(&entity.signature_hash),
                hex_hash(&entity.content_hash),
                hex_hash(&entity.structural_hash),
                hex_hash(&entity.identity_hash),
                hex_hash(&entity.context_hash)
            );
            print(
                format,
                &text,
                json!({"entity": entity, "hashes": entity.hashes()}),
            )
        }
    }
}

fn execute_graph(format: OutputFormat, db: Option<PathBuf>, cmd: GraphCommand) -> Result<()> {
    let storage = open_storage(db)?;
    match cmd.action {
        GraphAction::Callers {
            name,
            repo,
            cross_repo,
            depth,
        } => {
            let repo = repo.ok_or_else(|| anyhow!("--repo is required"))?;
            let repo = storage
                .get_repo_by_name(&repo)?
                .ok_or_else(|| anyhow!("repo not found: {repo}"))?;
            let entity = resolve_entity(&storage, &name, repo.id)?;
            let graph = if cross_repo {
                GraphBuilder::from_all_repos(&storage)?
            } else {
                GraphBuilder::from_storage(&storage, repo.id)?
            };
            let hits = GraphTraversal::new(&graph).callers(entity.id, depth);
            print_hits(format, "callers", &entity, hits)
        }
        GraphAction::Callees {
            name,
            repo,
            cross_repo,
            depth,
        } => {
            let repo = repo.ok_or_else(|| anyhow!("--repo is required"))?;
            let repo = storage
                .get_repo_by_name(&repo)?
                .ok_or_else(|| anyhow!("repo not found: {repo}"))?;
            let entity = resolve_entity(&storage, &name, repo.id)?;
            let graph = if cross_repo {
                GraphBuilder::from_all_repos(&storage)?
            } else {
                GraphBuilder::from_storage(&storage, repo.id)?
            };
            let hits = GraphTraversal::new(&graph).callees(entity.id, depth);
            print_hits(format, "callees", &entity, hits)
        }
        GraphAction::BlastRadius {
            name,
            repo,
            cross_repo,
        } => {
            let repo = repo.ok_or_else(|| anyhow!("--repo is required"))?;
            let repo = storage
                .get_repo_by_name(&repo)?
                .ok_or_else(|| anyhow!("repo not found: {repo}"))?;
            let entity = resolve_entity(&storage, &name, repo.id)?;
            let graph = if cross_repo {
                GraphBuilder::from_all_repos(&storage)?
            } else {
                GraphBuilder::from_storage(&storage, repo.id)?
            };
            let hits = GraphTraversal::new(&graph).blast_radius(entity.id);
            print_hits(format, "blast-radius", &entity, hits)
        }
        GraphAction::Cycles { repo } => {
            let repo = storage
                .get_repo_by_name(&repo)?
                .ok_or_else(|| anyhow!("repo not found: {repo}"))?;
            let graph = GraphBuilder::from_storage(&storage, repo.id)?;
            let cycles = GraphTraversal::new(&graph).detect_cycles();
            let text = if cycles.is_empty() {
                "no cycles".to_string()
            } else {
                cycles
                    .iter()
                    .map(|cycle| {
                        cycle
                            .iter()
                            .map(|e| e.qualified_name.clone())
                            .collect::<Vec<_>>()
                            .join(" -> ")
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            print(format, &text, json!({"cycles": cycles}))
        }
        GraphAction::ValidateEdges { repo } => {
            let repo = storage
                .get_repo_by_name(&repo)?
                .ok_or_else(|| anyhow!("repo not found: {repo}"))?;
            let report = crosshash_graph::validate_edges_for_repo(&storage, repo.id)?;
            print(
                format,
                &format!(
                    "valid edges: {}, stale edges: {}",
                    report.valid_edges,
                    report.stale_edges.len()
                ),
                json!({"valid_edges": report.valid_edges, "stale_edges": report.stale_edges}),
            )
        }
        GraphAction::PathBetween {
            source,
            target,
            repo,
        } => {
            let repo_name = repo.ok_or_else(|| anyhow!("--repo is required"))?;
            let repo = storage
                .get_repo_by_name(&repo_name)?
                .ok_or_else(|| anyhow!("repo not found: {repo_name}"))?;
            let source_entity = resolve_entity(&storage, &source, repo.id)?;
            let target_entity = resolve_entity(&storage, &target, repo.id)?;
            let graph = GraphBuilder::from_storage(&storage, repo.id)?;
            let path = GraphTraversal::new(&graph).path_between(source_entity.id, target_entity.id);
            match path {
                Some(steps) => {
                    let text = steps
                        .iter()
                        .map(|step| {
                            format!("{} -> {}", step.source_entity_id, step.target_entity_id)
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    print(format, &text, json!({"path": steps}))
                }
                None => print(format, "no path found", json!({"path": null})),
            }
        }
    }
}

async fn execute_discover_edges(
    format: OutputFormat,
    db: Option<PathBuf>,
    cmd: DiscoverEdgesCommand,
) -> Result<()> {
    let storage = open_storage(db)?;
    let repos = storage.list_repos()?;
    let repo_filter = cmd.repo.as_deref();
    let filtered_repos: Vec<&Repo> = repos
        .iter()
        .filter(|r| repo_filter.is_none_or(|name| r.name == name))
        .collect();
    let mut surfaces = Vec::new();
    let mut languages = HashSet::new();
    for repo in &filtered_repos {
        let exports = storage.get_public_api_surface(repo.id)?;
        languages.extend(repo.languages.iter().map(|l| format!("{l:?}")));
        surfaces.push((
            repo.id,
            repo.name.clone(),
            crosshash_ai::ApiSurface::from_exported_entities(repo.id, exports),
        ));
    }
    let total_entities = surfaces.iter().map(|s| s.2.entities.len()).sum::<usize>();
    if cmd.validate {
        let pending = storage.get_pending_suggestions()?;
        let text = format!("pending AI suggestions: {}", pending.len());
        return print(format, &text, json!({"pending_suggestions": pending}));
    }
    if cmd.dry_run {
        let text = format!(
            "public surfaces: {total_entities} entities across {} repos",
            filtered_repos.len()
        );
        return print(
            format,
            &text,
            json!({"surfaces": surfaces.iter().map(|s| s.2.to_prompt_json()).collect::<Vec<_>>(), "repo_count": filtered_repos.len()}),
        );
    }
    let ai_config = load_ai_config();
    let decision = crosshash_ai::AiGate::decide(&crosshash_ai::GateInput {
        ai_enabled: ai_config.enabled && !cmd.static_only,
        auto_gate: ai_config.auto_gate,
        no_ai: cmd.no_ai || cmd.static_only,
        force_ai: cmd.force_ai,
        new_repo: false,
        exported_added: 0,
        exported_signature_changed: 0,
        exported_deleted: 0,
        body_only_changed: 0,
        commits_since_validation: 0,
        days_since_validation: 0,
    });
    let mut ai_edges_suggested = 0usize;
    let mut ai_edges_auto_accepted = 0usize;
    let mut total_input_tokens = 0u64;
    let mut total_output_tokens = 0u64;
    let mut total_cost = 0.0f64;
    if decision.should_run_ai && !cmd.static_only && ai_config.enabled {
        let client = crosshash_ai::LlmClient::default();
        let llm_request = crosshash_ai::LlmRequest {
            provider: ai_config.provider(),
            endpoint: ai_config.endpoint(),
            api_key: ai_config.api_key(),
            model: ai_config.model.clone(),
            prompt: String::new(),
            temperature: ai_config.temperature,
            max_tokens: ai_config.max_tokens,
        };
        let mut engine = crosshash_ai::EdgeInferenceEngine {
            auto_accept_threshold: ai_config.confidence_auto_accept,
            languages: languages.into_iter().collect(),
            feedback: Vec::new(),
        };
        let feedback_rows = storage.get_feedback_events()?;
        engine.feedback = feedback_rows
            .into_iter()
            .filter_map(|row| {
                let edge_type = match row.get("edge_type")?.as_str()?.trim() {
                    "SharedType" => crosshash_ai::InferredEdgeType::SharedType,
                    "DataFlow" => crosshash_ai::InferredEdgeType::DataFlow,
                    "EventContract" => crosshash_ai::InferredEdgeType::EventContract,
                    _ => crosshash_ai::InferredEdgeType::APIContract,
                };
                let decision = match row.get("decision")?.as_str()? {
                    "reject" => crosshash_ai::FeedbackDecision::Reject,
                    _ => crosshash_ai::FeedbackDecision::Accept,
                };
                let confidence = row
                    .get("confidence")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.5);
                let suggestion_id = row
                    .get("suggestion_id")
                    .and_then(|v| v.as_str())
                    .and_then(|s| Uuid::parse_str(s).ok())?;
                Some(crosshash_ai::FeedbackEvent {
                    suggestion_id,
                    edge_type,
                    language: String::new(),
                    confidence,
                    decision,
                })
            })
            .collect();
        for i in 0..surfaces.len() {
            for j in 0..surfaces.len() {
                if i == j {
                    continue;
                }
                let (repo_a_id, _, ref surface_a) = &surfaces[i];
                let (repo_b_id, _, ref surface_b) = &surfaces[j];
                if surface_a.entities.is_empty() || surface_b.entities.is_empty() {
                    continue;
                }
                match engine
                    .infer(&client, &llm_request, surface_a, surface_b)
                    .await
                {
                    Ok(suggestions) => {
                        let suggested = suggestions.len();
                        let auto_accepted = engine.accept_high_confidence(&suggestions);
                        let auto_count = auto_accepted.len();
                        for edge in &auto_accepted {
                            let _ = storage.insert_edge(edge);
                        }
                        for suggestion in &suggestions {
                            let status = if suggestion.confidence >= engine.auto_accept_threshold {
                                "accepted"
                            } else {
                                "pending"
                            };
                            let _ = storage.insert_ai_edge_suggestion(
                                &suggestion.id,
                                &suggestion.exporter_entity_id,
                                &suggestion.consumer_entity_id,
                                &format!("{:?}", suggestion.edge_type),
                                &suggestion.reasoning,
                                suggestion.confidence,
                                status,
                            );
                        }
                        let input_est = surface_a.entities.len() as u64 * 4;
                        let output_est = suggested as u64 * 20;
                        let cost = (input_est + output_est) as f64 * 0.00001;
                        let log_id = Uuid::now_v7();
                        let reason_str = format!(
                            "{:?}",
                            decision
                                .reasons
                                .first()
                                .unwrap_or(&crosshash_ai::GateReason::Forced)
                        );
                        let _ = storage.insert_ai_inference_log(
                            &log_id,
                            &reason_str,
                            &decision.scope,
                            Some(repo_a_id),
                            Some(repo_b_id),
                            input_est,
                            output_est,
                            cost,
                            suggested,
                            auto_count,
                        );
                        ai_edges_suggested += suggested;
                        ai_edges_auto_accepted += auto_count;
                        total_input_tokens += input_est;
                        total_output_tokens += output_est;
                        total_cost += cost;
                    }
                    Err(e) => {
                        let name = &surfaces[i].1;
                        eprintln!("AI inference failed for {name}: {e}");
                    }
                }
            }
        }
    }
    let text = format!(
        "static edges found, AI edges suggested: {ai_edges_suggested}, auto-accepted: {ai_edges_auto_accepted}, AI cost: ${total_cost:.4}, gate_run_ai={}",
        decision.should_run_ai
    );
    print(
        format,
        &text,
        json!({
            "surfaces": surfaces.iter().map(|s| s.2.to_prompt_json()).collect::<Vec<_>>(),
            "gate": decision,
            "ai_edges_suggested": ai_edges_suggested,
            "ai_edges_auto_accepted": ai_edges_auto_accepted,
            "ai_cost": total_cost,
            "ai_input_tokens": total_input_tokens,
            "ai_output_tokens": total_output_tokens,
        }),
    )
}

fn execute_impact(format: OutputFormat, db: Option<PathBuf>, cmd: ImpactCommand) -> Result<()> {
    let storage = open_storage(db)?;
    let repos = storage.list_repos()?;
    let entities = storage.get_entities_all()?;
    let edges = storage.get_edges_all()?;
    let changed = if let Some(entity_name) = cmd.entity.as_deref() {
        storage
            .get_entities_by_name(entity_name, None)?
            .into_iter()
            .map(|e| e.id)
            .collect::<Vec<_>>()
    } else {
        entities.iter().take(1).map(|e| e.id).collect::<Vec<_>>()
    };
    let affected = crosshash_impact::ImpactAnalyzer::default().analyze(&changed, &entities, &edges);
    let changed_entities = changed
        .iter()
        .map(|id| crosshash_impact::ChangedEntity {
            entity_id: *id,
            old_name: None,
            new_name: None,
            change_kind: crosshash_impact::ChangeKind::Modified,
            diff_summary: "current indexed state".into(),
        })
        .collect::<Vec<_>>();
    let classifications = affected
        .iter()
        .map(|a| {
            crosshash_impact::ImpactClassifier::classify(crosshash_impact::ChangeKind::Modified, a)
        })
        .collect::<Vec<_>>();
    let report = crosshash_impact::ImpactReportBuilder {
        changed_repos: repos
            .iter()
            .filter(|r| cmd.source.as_deref().is_none_or(|name| r.name == name))
            .map(|r| r.id)
            .collect(),
        affected_repos: repos
            .iter()
            .filter(|r| cmd.all || cmd.target.is_empty() || cmd.target.contains(&r.name))
            .map(|r| r.id)
            .collect(),
        changed_entities,
        affected_entities: affected,
        classifications,
        generated_at: Utc::now(),
    };
    let report_format = match cmd.output {
        ImpactOutputFormat::Json => crosshash_impact::ReportFormat::Json,
        ImpactOutputFormat::Markdown => crosshash_impact::ReportFormat::Markdown,
        ImpactOutputFormat::Sarif => crosshash_impact::ReportFormat::Sarif,
    };
    let rendered = report.render(report_format);
    print(
        format,
        &rendered,
        json!({"report": report, "ai_calls": 0, "commit": cmd.commit, "diff": cmd.diff}),
    )
}

fn execute_feedback(format: OutputFormat, db: Option<PathBuf>, cmd: FeedbackCommand) -> Result<()> {
    let storage = open_storage(db)?;
    let text = match cmd.action {
        Some(FeedbackAction::Accept { edge_id }) => {
            let id = Uuid::parse_str(&edge_id).map_err(|_| anyhow!("invalid UUID: {edge_id}"))?;
            let suggestion = storage
                .get_suggestion_by_id(&id)?
                .ok_or_else(|| anyhow!("suggestion not found: {edge_id}"))?;
            storage.update_suggestion_status(&id, "accepted")?;
            let fb_id = Uuid::now_v7();
            storage.insert_feedback(&fb_id, &id, "accept", None)?;
            let exporter =
                Uuid::parse_str(suggestion["exporter_entity_id"].as_str().unwrap_or("")).ok();
            let consumer =
                Uuid::parse_str(suggestion["consumer_entity_id"].as_str().unwrap_or("")).ok();
            if let (Some(exporter_id), Some(consumer_id)) = (exporter, consumer) {
                let edge = Edge {
                    id: Uuid::now_v7(),
                    source_entity_id: consumer_id,
                    target_entity_id: exporter_id,
                    kind: EdgeKind::PackageDep,
                    confidence: suggestion["confidence"].as_f64().unwrap_or(0.5),
                    source: EdgeSource::AiInferred,
                    metadata: Some(serde_json::json!({
                        "edge_type": suggestion["edge_type"],
                        "reasoning": suggestion["reasoning"],
                    })),
                    created_at: Utc::now(),
                    validated_at: Some(Utc::now()),
                };
                storage.insert_edge(&edge)?;
            }
            format!("accepted AI edge suggestion {edge_id}")
        }
        Some(FeedbackAction::Reject { edge_id }) => {
            let id = Uuid::parse_str(&edge_id).map_err(|_| anyhow!("invalid UUID: {edge_id}"))?;
            storage
                .get_suggestion_by_id(&id)?
                .ok_or_else(|| anyhow!("suggestion not found: {edge_id}"))?;
            storage.update_suggestion_status(&id, "rejected")?;
            let fb_id = Uuid::now_v7();
            storage.insert_feedback(&fb_id, &id, "reject", None)?;
            format!("rejected AI edge suggestion {edge_id}")
        }
        Some(FeedbackAction::Stats) | None => {
            let events = storage.get_feedback_events()?;
            let total = events.len();
            let accepted = events
                .iter()
                .filter(|e| e["decision"].as_str() == Some("accept"))
                .count();
            let rejected = total - accepted;
            let precision = if total == 0 {
                1.0
            } else {
                accepted as f64 / total as f64
            };
            format!(
                "feedback stats: total={total} accepted={accepted} rejected={rejected} precision={precision:.2}"
            )
        }
        Some(FeedbackAction::Export) => {
            let events = storage.get_feedback_events()?;
            return print(
                format,
                &format!("{} feedback events", events.len()),
                json!(events),
            );
        }
    };
    print(format, &text, json!({"status": "ok"}))
}

fn execute_ai_stats(format: OutputFormat, db: Option<PathBuf>, _cmd: AiStatsCommand) -> Result<()> {
    let storage = open_storage(db)?;
    let logs = storage.get_ai_inference_logs(1000)?;
    let invocations = logs.len();
    let total_input_tokens: u64 = logs.iter().filter_map(|l| l["input_tokens"].as_u64()).sum();
    let total_output_tokens: u64 = logs
        .iter()
        .filter_map(|l| l["output_tokens"].as_u64())
        .sum();
    let total_cost: f64 = logs
        .iter()
        .filter_map(|l| l["estimated_cost_usd"].as_f64())
        .sum();
    let edges_suggested: usize = logs
        .iter()
        .filter_map(|l| l["edges_suggested"].as_u64())
        .sum::<u64>() as usize;
    let edges_auto_accepted: usize = logs
        .iter()
        .filter_map(|l| l["edges_auto_accepted"].as_u64())
        .sum::<u64>() as usize;
    let stats = crosshash_ai::AiStats {
        invocations,
        total_input_tokens,
        total_output_tokens,
        total_cost_usd: total_cost,
        edges_suggested,
        edges_auto_accepted,
    };
    let total_cost: f64 = total_cost.abs();
    let text = format!(
        "AI invocations: {invocations}, total cost: ${total_cost:.4}, tokens: {total_input_tokens}in/{total_output_tokens}out, edges: {edges_suggested} suggested, {edges_auto_accepted} auto-accepted"
    );
    print(format, &text, json!(stats))
}

fn extract_for_language(
    language: Language,
    repo_id: Uuid,
    root: &Path,
    file: &Path,
    source: &str,
    tree: &tree_sitter::Tree,
    commit: &str,
) -> Result<Vec<Entity>> {
    match language {
        Language::Rust => {
            Ok(RustExtractor.extract_entities(repo_id, root, file, source, tree, commit)?)
        }
        Language::TypeScript => {
            Ok(TypeScriptExtractor.extract_entities(repo_id, root, file, source, tree, commit)?)
        }
        Language::JavaScript => {
            Ok(JavaScriptExtractor.extract_entities(repo_id, root, file, source, tree, commit)?)
        }
        Language::Python => {
            Ok(PythonExtractor.extract_entities(repo_id, root, file, source, tree, commit)?)
        }
        Language::Go => {
            Ok(GoExtractor.extract_entities(repo_id, root, file, source, tree, commit)?)
        }
        Language::Java => {
            Ok(JavaExtractor.extract_entities(repo_id, root, file, source, tree, commit)?)
        }
        Language::C => Ok(CExtractor.extract_entities(repo_id, root, file, source, tree, commit)?),
        Language::Cpp => {
            Ok(CppExtractor.extract_entities(repo_id, root, file, source, tree, commit)?)
        }
        Language::CSharp => {
            Ok(CSharpExtractor.extract_entities(repo_id, root, file, source, tree, commit)?)
        }
        Language::Ruby => {
            Ok(RubyExtractor.extract_entities(repo_id, root, file, source, tree, commit)?)
        }
        Language::Php => {
            Ok(PhpExtractor.extract_entities(repo_id, root, file, source, tree, commit)?)
        }
        Language::Swift => {
            Ok(SwiftExtractor.extract_entities(repo_id, root, file, source, tree, commit)?)
        }
        Language::Kotlin => {
            Ok(KotlinExtractor.extract_entities(repo_id, root, file, source, tree, commit)?)
        }
        Language::Scala => {
            Ok(ScalaExtractor.extract_entities(repo_id, root, file, source, tree, commit)?)
        }
        Language::Elixir => {
            Ok(ElixirExtractor.extract_entities(repo_id, root, file, source, tree, commit)?)
        }
        Language::Dart => {
            Ok(DartExtractor.extract_entities(repo_id, root, file, source, tree, commit)?)
        }
        Language::Ocaml => {
            Ok(OcamlExtractor.extract_entities(repo_id, root, file, source, tree, commit)?)
        }
        Language::Zig => {
            Ok(ZigExtractor.extract_entities(repo_id, root, file, source, tree, commit)?)
        }
        Language::Bash => {
            Ok(BashExtractor.extract_entities(repo_id, root, file, source, tree, commit)?)
        }
        Language::Html | Language::Css => Err(anyhow!(
            "unsupported language for extraction: {:?}",
            language
        )),
        Language::Unknown => Err(anyhow!("unsupported language for extraction: Unknown")),
    }
}

fn infer_static_edges(
    repo_id: Uuid,
    repo_root: &Path,
    entities: &[Entity],
    source_by_file: &HashMap<String, String>,
) -> Vec<Edge> {
    let (edges, _reexports) =
        StaticEdgeExtractor::extract(repo_id, repo_root, entities, source_by_file);
    edges
}

fn slice_entity_source<'a>(source: &'a str, entity: &Entity) -> &'a str {
    source
        .get(entity.start_byte as usize..entity.end_byte as usize)
        .unwrap_or(source)
}

fn import_mentions(source: &str, target_name: &str) -> bool {
    source.lines().any(|line| {
        let trimmed = line.trim_start();
        (trimmed.starts_with("use ")
            || trimmed.starts_with("import ")
            || trimmed.starts_with("from ")
            || trimmed.starts_with("export "))
            && trimmed.contains(target_name)
    })
}

fn push_edge(
    repo_id: Uuid,
    source: Uuid,
    target: Uuid,
    kind: EdgeKind,
    seen: &mut HashSet<(Uuid, Uuid, EdgeKind)>,
    edges: &mut Vec<Edge>,
) {
    if !seen.insert((source, target, kind)) {
        return;
    }
    edges.push(Edge {
        id: Uuid::new_v5(&repo_id, format!("{source}:{target}:{kind:?}").as_bytes()),
        source_entity_id: source,
        target_entity_id: target,
        kind,
        confidence: 1.0,
        source: EdgeSource::Static,
        metadata: None,
        created_at: Utc::now(),
        validated_at: Some(Utc::now()),
    });
}

fn resolve_entity(storage: &GraphStorage, name: &str, repo_id: Uuid) -> Result<Entity> {
    storage
        .get_entities_by_name(name, Some(repo_id))?
        .into_iter()
        .next()
        .ok_or_else(|| anyhow!("entity not found: {name}"))
}

fn print_hits(
    format: OutputFormat,
    label: &str,
    entity: &Entity,
    hits: Vec<crosshash_graph::TraversalHit>,
) -> Result<()> {
    let text = if hits.is_empty() {
        format!("no {label} for {}", entity.qualified_name)
    } else {
        hits.iter()
            .map(|hit| {
                format!(
                    "{}\tdepth={}\tpath_edges={}",
                    hit.entity.qualified_name,
                    hit.distance,
                    hit.path.len()
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    let results = hits
        .iter()
        .map(|hit| {
            json!({
                "entity": hit.entity,
                "distance": hit.distance,
                "path": hit.path.iter().map(|step| json!({
                    "source_entity_id": step.source_entity_id,
                    "target_entity_id": step.target_entity_id,
                    "edge": step.edge,
                })).collect::<Vec<_>>()
            })
        })
        .collect::<Vec<_>>();
    print(
        format,
        &text,
        json!({"query": label, "entity": entity, "results": results}),
    )
}

fn hex_hash(hash: &[u8; 32]) -> String {
    hash.iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

fn infer_cross_repo_edges(
    storage: &GraphStorage,
    source_repo_id: Uuid,
    source_entities: &[Entity],
    source_by_file: &HashMap<String, String>,
) -> Result<Vec<Edge>> {
    let repos = storage.list_repos()?;
    let other_repo_ids = repos
        .iter()
        .filter(|repo| repo.id != source_repo_id)
        .map(|repo| repo.id)
        .collect::<HashSet<_>>();
    if other_repo_ids.is_empty() {
        return Ok(Vec::new());
    }
    let public_targets = storage
        .get_entities_all()?
        .into_iter()
        .filter(|entity| other_repo_ids.contains(&entity.repo_id) && entity.is_exported)
        .collect::<Vec<_>>();
    let mut edges = Vec::new();
    let mut seen = HashSet::new();
    for source in source_entities {
        let body = source_by_file
            .get(&source.file_path)
            .map(|file_source| slice_entity_source(file_source, source))
            .unwrap_or(&source.signature);
        for target in &public_targets {
            if source.signature.contains(&target.name)
                || source.name.contains(&target.name)
                || body.contains(&format!("{}(", target.name))
                || import_mentions(body, &target.name)
            {
                push_edge(
                    source_repo_id,
                    source.id,
                    target.id,
                    EdgeKind::PackageDep,
                    &mut seen,
                    &mut edges,
                );
            }
        }
    }
    Ok(edges)
}

fn detect_languages(root: &Path) -> Result<Vec<Language>> {
    let mut languages = collect_source_files(root, &[])?
        .into_iter()
        .filter_map(|path| detect_language(&path).ok().flatten())
        .collect::<HashSet<_>>();
    if languages.is_empty() {
        languages.extend([Language::Rust, Language::TypeScript, Language::Python]);
    }
    let mut languages = languages.into_iter().collect::<Vec<_>>();
    languages.sort_by_key(|language| format!("{language:?}"));
    Ok(languages)
}

fn validate_repo_has_sources(root: &Path) -> Result<()> {
    if collect_source_files(root, &[])?.is_empty() {
        return Err(anyhow!(
            "repo path contains no supported source files: {}",
            root.display()
        ));
    }
    Ok(())
}

fn version_for(entity: &Entity, commit_hash: &str) -> EntityVersion {
    EntityVersion {
        entity_id: entity.id,
        commit_hash: commit_hash.into(),
        name: entity.name.clone(),
        qualified_name: entity.qualified_name.clone(),
        signature: entity.signature.clone(),
        signature_hash: entity.signature_hash,
        content_hash: entity.content_hash,
        structural_hash: entity.structural_hash,
        identity_hash: entity.identity_hash,
        context_hash: entity.context_hash,
        snapshot_at: Utc::now(),
    }
}

fn open_storage(db: Option<PathBuf>) -> Result<GraphStorage> {
    let path = db.unwrap_or_else(|| PathBuf::from(".crosshash/crosshash.db"));
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    Ok(GraphStorage::open(&path)?)
}
fn detect_workspace_type(root: &Path, workspace_aware: bool) -> WorkspaceType {
    if root.join("nx.json").exists() {
        WorkspaceType::Nx
    } else if root.join("turbo.json").exists() {
        WorkspaceType::Turborepo
    } else if root.join("Cargo.toml").exists() {
        if workspace_aware
            && std::fs::read_to_string(root.join("Cargo.toml"))
                .unwrap_or_default()
                .contains("[workspace]")
        {
            WorkspaceType::CargoWorkspace
        } else {
            WorkspaceType::Cargo
        }
    } else if root.join("package.json").exists() {
        if workspace_aware
            && std::fs::read_to_string(root.join("package.json"))
                .unwrap_or_default()
                .contains("\"workspaces\"")
        {
            WorkspaceType::NpmWorkspace
        } else {
            WorkspaceType::Npm
        }
    } else if root.join("go.mod").exists() {
        WorkspaceType::GoModules
    } else {
        WorkspaceType::None
    }
}

fn load_ai_config() -> crosshash_ai::AiConfig {
    let candidates: Vec<PathBuf> = [
        Some(PathBuf::from("config/default.toml")),
        std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|p| p.join("config").join("default.toml"))),
        std::env::var("CROSSHASH_CONFIG").ok().map(PathBuf::from),
    ]
    .into_iter()
    .flatten()
    .collect();
    for candidate in &candidates {
        if candidate.exists() {
            if let Ok(config) = crosshash_ai::AiConfig::load(candidate) {
                return config;
            }
        }
    }
    crosshash_ai::AiConfig::load_from_env().unwrap_or_default()
}

async fn execute_serve(
    _format: OutputFormat,
    db: Option<PathBuf>,
    cmd: ServeCommand,
) -> Result<()> {
    let storage = open_storage(db)?;
    let addr: std::net::SocketAddr = cmd.addr.parse()?;
    if addr.ip().is_unspecified() && cmd.api_key.is_none() {
        anyhow::bail!(
            "refusing to bind crosshash API to {addr} without --api-key; use 127.0.0.1 or pass --api-key"
        );
    }
    let config = crosshash_api::ApiConfig {
        api_key: cmd.api_key,
        max_requests_per_minute: 60,
    };
    let app = crosshash_api::api_router_with_storage(config, storage);
    eprintln!("crosshash API server listening on {addr}");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn execute_watch(
    _format: OutputFormat,
    db: Option<PathBuf>,
    cmd: WatchCommand,
) -> Result<()> {
    let storage = open_storage(db.clone())?;
    let repos = if let Some(name) = &cmd.repo {
        vec![storage
            .get_repo_by_name(name)?
            .ok_or_else(|| anyhow!("repo not found: {name}"))?]
    } else {
        storage.list_repos()?
    };
    if repos.is_empty() {
        anyhow::bail!("no repos to watch. Add repos with `crosshash repo add`");
    }

    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(100);
    let watch_roots: Vec<(String, String)> = repos
        .iter()
        .map(|r| (r.name.clone(), r.root_path.clone()))
        .collect();

    let root_names: Vec<String> = watch_roots.iter().map(|(n, _)| n.clone()).collect();
    std::thread::spawn(move || -> Result<()> {
        let (notify_tx, notify_rx) = std::sync::mpsc::channel::<notify::Event>();
        let mut watcher = notify::RecommendedWatcher::new(
            move |res: Result<notify::Event, notify::Error>| {
                if let Ok(event) = res {
                    let _ = notify_tx.send(event);
                }
            },
            notify::Config::default(),
        )?;
        for (_, path) in &watch_roots {
            watcher.watch(std::path::Path::new(path), notify::RecursiveMode::Recursive)?;
        }
        for event in notify_rx.iter() {
            if matches!(
                event.kind,
                notify::EventKind::Create(_)
                    | notify::EventKind::Modify(_)
                    | notify::EventKind::Remove(_)
            ) {
                for path in &event.paths {
                    for (name, root) in &watch_roots {
                        if path.starts_with(root) {
                            let _ = tx.blocking_send(name.clone());
                            break;
                        }
                    }
                }
            }
        }
        Ok(())
    });

    for name in &root_names {
        eprintln!("watching {name}");
    }
    eprintln!(
        "watching {} repos for changes (debounce {}ms, Ctrl+C to stop)...",
        repos.len(),
        cmd.debounce_ms
    );

    let debounce = Duration::from_millis(cmd.debounce_ms);
    loop {
        if let Some(repo_name) = rx.recv().await {
            let mut pending = HashSet::new();
            pending.insert(repo_name);

            let deadline = tokio::time::Instant::now() + debounce;
            loop {
                tokio::select! {
                    Some(name) = rx.recv() => {
                        pending.insert(name);
                    }
                    _ = tokio::time::sleep_until(deadline) => {
                        break;
                    }
                }
            }

            for name in &pending {
                eprintln!("[watch] re-indexing {name}...");
                let idx_db = db
                    .clone()
                    .unwrap_or_else(|| PathBuf::from(".crosshash/crosshash.db"));
                match open_storage(Some(idx_db)) {
                    Ok(idx_storage) => {
                        if let Some(repo) = idx_storage.get_repo_by_name(name)? {
                            let index_cmd = IndexCommand {
                                repo: Some(name.clone()),
                                incremental: true,
                                no_ai: false,
                                force_ai: false,
                            };
                            match index_one_repo(&idx_storage, &repo, true, &index_cmd).await {
                                Ok(summary) => eprintln!(
                                    "[watch] {}: {} entities, {} edges",
                                    name, summary.entities_extracted, summary.edges
                                ),
                                Err(e) => eprintln!("[watch] error indexing {name}: {e}"),
                            }
                        }
                    }
                    Err(e) => eprintln!("[watch] error opening storage: {e}"),
                }
            }
        }
    }
}

fn execute_mcp(_format: OutputFormat, db: Option<PathBuf>, _cmd: McpCommand) -> Result<()> {
    let storage = open_storage(db)?;
    let server = crosshash_mcp::McpServer::new(storage);
    server.run()
}
fn print(format: OutputFormat, text: &str, payload: serde_json::Value) -> Result<()> {
    println!("{}", render_message(format, text, &payload)?);
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;
    use crosshash_core::{EntityKind, Language, Visibility};

    #[test]
    fn cli_exposes_phase_one_index_flags_and_commands() {
        let mut help = Vec::new();
        Cli::command().write_long_help(&mut help).unwrap();
        let help = String::from_utf8(help).unwrap();
        for command in [
            "repo",
            "index",
            "discover-edges",
            "impact",
            "entity",
            "graph",
            "feedback",
            "ai-stats",
            "serve",
            "watch",
            "mcp",
        ] {
            assert!(
                help.contains(command),
                "missing command {command} in help: {help}"
            );
        }
        let help = Cli::command().render_long_help().to_string();
        assert!(help.contains("--db"));
    }

    #[test]
    fn feedback_accept_reject_flow_via_storage() {
        let storage = GraphStorage::open_in_memory().unwrap();
        let repo = Repo {
            id: Uuid::now_v7(),
            name: "test".into(),
            root_path: "/tmp/test".into(),
            git_remote: None,
            default_branch: "main".into(),
            languages: vec![Language::Rust],
            workspace_type: WorkspaceType::None,
            last_indexed_at: Utc::now(),
            commit_hash: "abc".into(),
        };
        storage.insert_repo(&repo).unwrap();
        let entity_a = Entity {
            id: Uuid::now_v7(),
            repo_id: repo.id,
            file_path: "src/a.rs".into(),
            language: Language::Rust,
            kind: EntityKind::Function,
            name: "api_fn".into(),
            qualified_name: "api_fn".into(),
            signature: "pub fn api_fn()".into(),
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
            first_seen_commit: "abc".into(),
            last_seen_commit: "abc".into(),
            deleted_at_commit: None,
        };
        let mut entity_b = Entity {
            id: Uuid::now_v7(),
            ..entity_a.clone()
        };
        entity_b.name = "consumer_fn".into();
        entity_b.qualified_name = "consumer_fn".into();
        storage.insert_entity(&entity_a).unwrap();
        storage.insert_entity(&entity_b).unwrap();
        let sug_id = Uuid::now_v7();
        storage
            .insert_ai_edge_suggestion(
                &sug_id,
                &entity_a.id,
                &entity_b.id,
                "APIContract",
                "test reasoning",
                0.9,
                "pending",
            )
            .unwrap();
        let pending = storage.get_pending_suggestions().unwrap();
        assert_eq!(pending.len(), 1);
        storage
            .update_suggestion_status(&sug_id, "accepted")
            .unwrap();
        let fb_id = Uuid::now_v7();
        storage
            .insert_feedback(&fb_id, &sug_id, "accept", None)
            .unwrap();
        let events = storage.get_feedback_events().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["decision"], "accept");
        let logs = storage.get_ai_inference_logs(10).unwrap();
        assert!(logs.is_empty());
        let log_id = Uuid::now_v7();
        storage
            .insert_ai_inference_log(
                &log_id,
                "NewExports",
                "all",
                Some(&repo.id),
                None,
                100,
                50,
                0.003,
                1,
                1,
            )
            .unwrap();
        let logs = storage.get_ai_inference_logs(10).unwrap();
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0]["trigger_reason"], "NewExports");
    }
}
