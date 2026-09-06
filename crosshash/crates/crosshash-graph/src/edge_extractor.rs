use crosshash_core::{Edge, EdgeKind, EdgeSource, Entity, EntityKind, Language};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use uuid::Uuid;

/// Per-language import resolver.
trait ImportResolver {
    /// Parse import lines from source code and return (imported_name, source_file_path, raw_line).
    fn extract_imports(source: &str, file_path: &str) -> Vec<ImportInfo>;
}

struct ImportInfo {
    imported_name: String,
    #[allow(dead_code)]
    source_file: String,
    _raw_line: String,
}

struct TypeScriptResolver;
struct RustResolver;
struct PythonResolver;
struct GoResolver;
struct JavaResolver;
struct RubyResolver;

impl ImportResolver for TypeScriptResolver {
    fn extract_imports(source: &str, file_path: &str) -> Vec<ImportInfo> {
        let mut imports = Vec::new();
        for line in source.lines() {
            let trimmed = line.trim_start();
            if !(trimmed.starts_with("import ") || trimmed.starts_with("export ")) {
                continue;
            }
            if let Some(names) = parse_ts_import_names(trimmed) {
                if let Some(_module_path) = parse_ts_module_path(trimmed) {
                    for name in names {
                        imports.push(ImportInfo {
                            imported_name: name,
                            source_file: file_path.to_string(),
                            _raw_line: trimmed.to_string(),
                        });
                    }
                }
            }
        }
        imports
    }
}

fn parse_ts_import_names(line: &str) -> Option<Vec<String>> {
    let trimmed = line.trim_start();
    if !(trimmed.starts_with("import ") || trimmed.starts_with("export ")) {
        return None;
    }
    // Restrict parsing to the import statement only (before ';' or 'from')
    let stmt_end = trimmed.find(';').unwrap_or(trimmed.len());
    let from_pos = trimmed.find(" from ").unwrap_or(stmt_end);
    let stmt = &trimmed[..stmt_end.min(from_pos)];

    // export { X, Y } from '...'
    if let Some(pos) = stmt.find("export {") {
        let rest = &stmt[pos + 8..];
        let end = rest.find('}')?;
        let inner = rest[..end].trim();
        if inner.is_empty() {
            return None;
        }
        let names: Vec<String> = inner
            .split(',')
            .map(|s| {
                s.split_whitespace()
                    .next()
                    .unwrap_or("")
                    .split(" as ")
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_string()
            })
            .filter(|s| !s.is_empty())
            .collect();
        return if names.is_empty() { None } else { Some(names) };
    }
    // import { X, Y } from '...'
    if let Some(pos) = stmt.find('{') {
        let rest = &stmt[pos + 1..];
        let end = rest.find('}')?;
        let inner = rest[..end].trim();
        if inner.is_empty() {
            return None;
        }
        let names: Vec<String> = inner
            .split(',')
            .map(|s| {
                s.split_whitespace()
                    .next()
                    .unwrap_or("")
                    .split(" as ")
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_string()
            })
            .filter(|s| !s.is_empty())
            .collect();
        return if names.is_empty() { None } else { Some(names) };
    }
    // import Foo from '...' (default import)
    if let Some(rest) = stmt.strip_prefix("import ") {
        if !rest.is_empty() && !rest.starts_with('{') && !rest.starts_with('*') {
            return Some(vec![rest.trim().to_string()]);
        }
    }
    None
}

fn parse_ts_module_path(line: &str) -> Option<String> {
    // to_ascii_lowercase is byte-length-preserving, so the offset found here
    // maps exactly onto `line` and the slice stays on a char boundary.
    // to_lowercase is NOT length-preserving ('İ' grows) and panicked on
    // non-char boundaries for valid identifiers (#319).
    let lower = line.to_ascii_lowercase();
    let pos = lower.find(" from ")?;
    let rest = line[pos + 6..].trim();
    if rest.is_empty() {
        return None;
    }
    let first_char = rest.chars().next()?;
    if first_char != '\'' && first_char != '"' {
        return None;
    }
    let end = rest[1..].find(first_char)?;
    Some(rest[1..=end].to_string())
}

fn is_ts_reexport(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.starts_with("export") && trimmed.contains(" from ")
}

impl ImportResolver for RustResolver {
    fn extract_imports(source: &str, file_path: &str) -> Vec<ImportInfo> {
        let mut imports = Vec::new();
        for line in source.lines() {
            let trimmed = line.trim_start();
            if let Some(use_stmt) = trimmed.strip_prefix("use ") {
                let end = use_stmt.find(';').unwrap_or(use_stmt.len());
                let path = use_stmt[..end].trim();
                // use crate::module::Foo  → imported_name = "Foo"
                // use crate::module::{A, B} → imported_names = ["A", "B"]
                // use crate::module::Foo as Bar → imported_name = "Bar"
                if let Some(brace_pos) = path.find('{') {
                    let end_brace = path.find('}').unwrap_or(path.len());
                    let inner = path[brace_pos + 1..end_brace].trim();
                    for item in inner.split(',') {
                        let item = item.trim();
                        let name = item.split(" as ").next().unwrap_or(item).trim().to_string();
                        if !name.is_empty() {
                            imports.push(ImportInfo {
                                imported_name: name,
                                source_file: file_path.to_string(),
                                _raw_line: trimmed.to_string(),
                            });
                        }
                    }
                } else {
                    let name = path
                        .split(" as ")
                        .last()
                        .unwrap_or(path)
                        .trim()
                        .rsplit("::")
                        .next()
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    if !name.is_empty() {
                        imports.push(ImportInfo {
                            imported_name: name,
                            source_file: file_path.to_string(),
                            _raw_line: trimmed.to_string(),
                        });
                    }
                }
            }
        }
        imports
    }
}

impl ImportResolver for PythonResolver {
    fn extract_imports(source: &str, file_path: &str) -> Vec<ImportInfo> {
        let mut imports = Vec::new();
        for line in source.lines() {
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix("import ") {
                let rest = rest.split('#').next().unwrap_or(rest).trim();
                // import foo.bar as baz → name = "baz"
                // import foo → name = "foo"
                if let Some(as_pos) = rest.find(" as ") {
                    let name = rest[as_pos + 4..].trim().to_string();
                    imports.push(ImportInfo {
                        imported_name: name,
                        source_file: file_path.to_string(),
                        _raw_line: trimmed.to_string(),
                    });
                } else {
                    let name = rest
                        .split('.')
                        .next_back()
                        .unwrap_or(rest)
                        .trim()
                        .to_string();
                    imports.push(ImportInfo {
                        imported_name: name,
                        source_file: file_path.to_string(),
                        _raw_line: trimmed.to_string(),
                    });
                }
            } else if let Some(rest) = trimmed.strip_prefix("from ") {
                let rest = rest.split('#').next().unwrap_or(rest).trim();
                // from foo import bar, baz
                if let Some(import_pos) = rest.find(" import ") {
                    let names_part = rest[import_pos + 8..].trim();
                    for name in names_part.split(',') {
                        let name = name.trim();
                        if let Some(as_pos) = name.find(" as ") {
                            let actual = name[as_pos + 4..].trim().to_string();
                            imports.push(ImportInfo {
                                imported_name: actual,
                                source_file: file_path.to_string(),
                                _raw_line: trimmed.to_string(),
                            });
                        } else if !name.is_empty() {
                            imports.push(ImportInfo {
                                imported_name: name.to_string(),
                                source_file: file_path.to_string(),
                                _raw_line: trimmed.to_string(),
                            });
                        }
                    }
                }
            }
        }
        imports
    }
}

impl ImportResolver for GoResolver {
    fn extract_imports(source: &str, file_path: &str) -> Vec<ImportInfo> {
        let mut imports = Vec::new();
        let mut in_import_block = false;
        for line in source.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("import ") {
                if trimmed.contains('(') {
                    in_import_block = true;
                    let after_paren = trimmed.split('(').nth(1).unwrap_or("");
                    extract_go_import_names(after_paren, file_path, &mut imports);
                } else {
                    let path = trimmed.strip_prefix("import ").unwrap_or("").trim();
                    let name = go_import_name(path);
                    if !name.is_empty() {
                        imports.push(ImportInfo {
                            imported_name: name,
                            source_file: file_path.to_string(),
                            _raw_line: trimmed.to_string(),
                        });
                    }
                }
            } else if in_import_block {
                if trimmed.contains(')') {
                    in_import_block = false;
                    let before_paren = trimmed.split(')').next().unwrap_or("");
                    extract_go_import_names(before_paren, file_path, &mut imports);
                } else {
                    extract_go_import_names(trimmed, file_path, &mut imports);
                }
            }
        }
        imports
    }
}

fn extract_go_import_names(text: &str, file_path: &str, imports: &mut Vec<ImportInfo>) {
    for entry in text.split(',') {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        let name = go_import_name(entry);
        if !name.is_empty() {
            imports.push(ImportInfo {
                imported_name: name,
                source_file: file_path.to_string(),
                _raw_line: entry.to_string(),
            });
        }
    }
}

fn go_import_name(path: &str) -> String {
    let path = path.trim().trim_matches('"').trim();
    if path.is_empty() {
        return String::new();
    }
    if let Some(alias_end) = path.find(' ') {
        path[..alias_end].trim().to_string()
    } else {
        path.rsplit('/').next().unwrap_or(path).to_string()
    }
}

impl ImportResolver for JavaResolver {
    fn extract_imports(source: &str, file_path: &str) -> Vec<ImportInfo> {
        let mut imports = Vec::new();
        for line in source.lines() {
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix("import ") {
                if let Some(static_rest) = rest.strip_prefix("static ") {
                    let name = static_rest
                        .split('.')
                        .next_back()
                        .unwrap_or(static_rest)
                        .trim_end_matches(';')
                        .trim();
                    if !name.is_empty() && !name.contains('*') {
                        imports.push(ImportInfo {
                            imported_name: name.to_string(),
                            source_file: file_path.to_string(),
                            _raw_line: trimmed.to_string(),
                        });
                    }
                } else {
                    let name = rest
                        .trim_end_matches(';')
                        .split('.')
                        .next_back()
                        .unwrap_or(rest.trim_end_matches(';'))
                        .trim();
                    if !name.is_empty() && !name.contains('*') {
                        imports.push(ImportInfo {
                            imported_name: name.to_string(),
                            source_file: file_path.to_string(),
                            _raw_line: trimmed.to_string(),
                        });
                    }
                }
            }
        }
        imports
    }
}

impl ImportResolver for RubyResolver {
    fn extract_imports(source: &str, file_path: &str) -> Vec<ImportInfo> {
        let mut imports = Vec::new();
        for line in source.lines() {
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix("require ") {
                let path = rest
                    .trim_matches('\'')
                    .trim_matches('"')
                    .trim_end_matches(';')
                    .trim();
                if !path.is_empty() {
                    let name = path.rsplit('/').next().unwrap_or(path).to_string();
                    imports.push(ImportInfo {
                        imported_name: name,
                        source_file: file_path.to_string(),
                        _raw_line: trimmed.to_string(),
                    });
                }
            } else if let Some(rest) = trimmed.strip_prefix("require_relative ") {
                let path = rest
                    .trim_matches('\'')
                    .trim_matches('"')
                    .trim_end_matches(';')
                    .trim();
                if !path.is_empty() {
                    let name = path.rsplit('/').next().unwrap_or(path).to_string();
                    imports.push(ImportInfo {
                        imported_name: name,
                        source_file: file_path.to_string(),
                        _raw_line: trimmed.to_string(),
                    });
                }
            }
        }
        imports
    }
}

/// Resolve a relative import path to an absolute file path.
fn resolve_relative_import(
    importer_file: &str,
    module_path: &str,
    repo_root: &Path,
) -> Option<PathBuf> {
    if module_path.starts_with('.') {
        let importer_full = repo_root.join(importer_file);
        let importer_dir = importer_full.parent()?;
        let resolved = importer_dir.join(module_path);
        // Canonicalize to remove ./ segments (only for files)
        if resolved.is_file() {
            return resolved.canonicalize().ok();
        }
        // Try extensions
        for ext in ["ts", "tsx", "js", "py", "rs"] {
            let with_ext = resolved.with_extension(ext);
            if with_ext.exists() {
                return with_ext.canonicalize().ok();
            }
        }
        // Try index files
        for idx in ["index.ts", "index.js"] {
            let index = resolved.join(idx);
            if index.exists() {
                return index.canonicalize().ok();
            }
        }
        return Some(resolved);
    }
    let from_root = repo_root.join(module_path);
    if from_root.exists() {
        return from_root.canonicalize().ok();
    }
    None
}

/// Compute confidence score for an import edge.
fn import_confidence(target_in_resolved_file: bool, file_resolved: bool, is_relative: bool) -> f64 {
    match (target_in_resolved_file, file_resolved, is_relative) {
        (true, true, _) => 1.0,
        (true, false, _) => 0.8,
        (false, true, true) => 0.8,
        (false, true, false) => 0.5,
        (false, false, _) => 0.3,
    }
}

/// Look for `extends`/`implements` in class/interface definitions.
fn extract_inheritance_edges(
    entities: &[Entity],
    source_by_file: &HashMap<String, String>,
) -> Vec<(Uuid, Uuid, EdgeKind)> {
    let mut results = Vec::new();
    let source_set: HashSet<_> = source_by_file.keys().collect();

    for entity in entities.iter().filter(|e| {
        matches!(
            e.kind,
            EntityKind::Class | EntityKind::Struct | EntityKind::Interface | EntityKind::Trait
        )
    }) {
        if !source_set.contains(&entity.file_path) {
            continue;
        }
        let file_source = &source_by_file[&entity.file_path];
        let body = file_source
            .get(entity.start_byte as usize..entity.end_byte as usize)
            .unwrap_or("");
        let body_lower = body.to_lowercase();

        for target in entities.iter().filter(|e| e.id != entity.id) {
            if !source_by_file.contains_key(&target.file_path) {
                continue;
            }
            if body_lower.contains(&format!("extends {}", target.name.to_lowercase()))
                || body_lower.contains(&format!("extends {}<", target.name.to_lowercase()))
            {
                results.push((entity.id, target.id, EdgeKind::Extends));
            }
            if (entity.language == Language::TypeScript || entity.language == Language::JavaScript)
                && (body_lower.contains(&format!("implements {}", target.name.to_lowercase()))
                    || body_lower.contains(&format!(": {}", target.name.to_lowercase())))
            {
                results.push((entity.id, target.id, EdgeKind::Implements));
            }
        }
    }
    results
}

/// Extract call edges from entity bodies.
fn extract_call_edges(
    entities: &[Entity],
    source_by_file: &HashMap<String, String>,
) -> Vec<(Uuid, Uuid)> {
    let mut results = Vec::new();
    for entity in entities {
        let Some(file_source) = source_by_file.get(&entity.file_path) else {
            continue;
        };
        let body = file_source
            .get(entity.start_byte as usize..entity.end_byte as usize)
            .unwrap_or("");
        for target in entities.iter().filter(|e| e.id != entity.id) {
            if body.contains(&format!("{}(", target.name)) {
                results.push((entity.id, target.id));
            }
        }
    }
    results
}

/// Extract contains edges (parent → child for structs/classes/modules containing functions/methods).
fn extract_contains_edges(entities: &[Entity]) -> Vec<(Uuid, Uuid)> {
    let mut results = Vec::new();
    let is_container = |kind: EntityKind| -> bool {
        matches!(
            kind,
            EntityKind::Class
                | EntityKind::Struct
                | EntityKind::Trait
                | EntityKind::Impl
                | EntityKind::Module
        )
    };
    for parent in entities.iter().filter(|e| is_container(e.kind)) {
        let prefix = format!("{}::", parent.qualified_name);
        for child in entities.iter().filter(|e| e.id != parent.id) {
            if child.qualified_name.starts_with(&prefix) {
                results.push((parent.id, child.id));
            }
        }
    }
    results
}

/// The main edge extraction entry point.
pub struct StaticEdgeExtractor;

impl StaticEdgeExtractor {
    /// Extract all static edges for a repo.
    pub fn extract(
        repo_id: Uuid,
        repo_root: &Path,
        entities: &[Entity],
        source_by_file: &HashMap<String, String>,
    ) -> (Vec<Edge>, Vec<Edge>) {
        let mut seen = HashSet::new();
        let mut edges = Vec::new();
        let mut reexport_edges = Vec::new();

        // 1. Contains edges (parent → child)
        let contains = extract_contains_edges(entities);
        for (parent_id, child_id) in &contains {
            Self::push_edge(
                repo_id,
                *parent_id,
                *child_id,
                EdgeKind::Contains,
                1.0,
                EdgeSource::Static,
                &mut seen,
                &mut edges,
            );
        }

        // 2. Call edges
        let calls = extract_call_edges(entities, source_by_file);
        for (source_id, target_id) in &calls {
            Self::push_edge(
                repo_id,
                *source_id,
                *target_id,
                EdgeKind::Calls,
                1.0,
                EdgeSource::Static,
                &mut seen,
                &mut edges,
            );
        }

        // 3. Import edges with resolution and confidence scoring
        Self::extract_import_edges(
            repo_id,
            repo_root,
            entities,
            source_by_file,
            &mut seen,
            &mut edges,
        );

        // 4. Inheritance edges (extends/implements)
        let inheritance = extract_inheritance_edges(entities, source_by_file);
        for (source_id, target_id, kind) in &inheritance {
            Self::push_edge(
                repo_id,
                *source_id,
                *target_id,
                *kind,
                1.0,
                EdgeSource::Static,
                &mut seen,
                &mut edges,
            );
        }

        // 5. Re-export detection — export { X } from './y' creates Imports edge
        Self::extract_reexport_import_edges(
            repo_id,
            repo_root,
            entities,
            source_by_file,
            &mut seen,
            &mut edges,
            &mut reexport_edges,
        );

        (edges, reexport_edges)
    }

    fn extract_import_edges(
        repo_id: Uuid,
        repo_root: &Path,
        entities: &[Entity],
        source_by_file: &HashMap<String, String>,
        seen: &mut HashSet<(Uuid, Uuid, EdgeKind)>,
        edges: &mut Vec<Edge>,
    ) {
        let mut entities_by_name: HashMap<String, Vec<&Entity>> = HashMap::new();
        for entity in entities {
            entities_by_name
                .entry(entity.name.clone())
                .or_default()
                .push(entity);
        }

        // Collect import info per file (deduplicated at file level)
        let mut file_imports: HashMap<String, Vec<ImportInfo>> = HashMap::new();
        for (file_path, file_source) in source_by_file {
            let language = entities
                .iter()
                .find(|e| e.file_path == *file_path)
                .map(|e| e.language);
            let import_infos: Vec<ImportInfo> = match language {
                Some(Language::TypeScript) | Some(Language::JavaScript) => {
                    TypeScriptResolver::extract_imports(file_source, file_path)
                }
                Some(Language::Rust) => RustResolver::extract_imports(file_source, file_path),
                Some(Language::Python) => PythonResolver::extract_imports(file_source, file_path),
                Some(Language::Go) => GoResolver::extract_imports(file_source, file_path),
                Some(Language::Java) => JavaResolver::extract_imports(file_source, file_path),
                Some(Language::Ruby) => RubyResolver::extract_imports(file_source, file_path),
                _ => Vec::new(),
            };
            file_imports.insert(file_path.clone(), import_infos);
        }

        // For each file with imports, create import edges to matching entities
        for entity in entities {
            let import_infos = match file_imports.get(&entity.file_path) {
                Some(infos) => infos,
                None => continue,
            };

            for info in import_infos {
                // Skip module-path entries (contain '/' or ':')
                if info.imported_name.contains('/')
                    || info.imported_name.contains(':')
                    || info.imported_name.contains('.')
                {
                    continue;
                }

                let candidates = entities_by_name.get(&info.imported_name);
                if let Some(targets) = candidates {
                    for target in targets {
                        if target.id == entity.id {
                            continue;
                        }
                        let same_file = target.file_path == entity.file_path;

                        // Determine confidence based on file resolution
                        let is_relative = info._raw_line.contains(" from '")
                            || info._raw_line.contains(" from \"")
                            || info._raw_line.contains("from './")
                            || info._raw_line.contains("from \"./");

                        let confidence = if is_relative {
                            if let Some(module_path) = parse_ts_module_path(&info._raw_line)
                                .or_else(|| parse_rust_module_path(&info._raw_line))
                                .or_else(|| parse_python_module_path(&info._raw_line))
                            {
                                let resolved = resolve_relative_import(
                                    &entity.file_path,
                                    &module_path,
                                    repo_root,
                                );
                                let file_resolved = resolved.as_ref().is_some_and(|r| {
                                    let r_str = r.to_string_lossy();
                                    let r_file_name = r
                                        .file_name()
                                        .map(|n| n.to_string_lossy().to_string())
                                        .unwrap_or_default();
                                    let target_file_name = Path::new(&target.file_path)
                                        .file_name()
                                        .map(|n| n.to_string_lossy().to_string())
                                        .unwrap_or_default();
                                    target.file_path.ends_with(&*r_str)
                                        || target.file_path == r_str
                                        || r_str.ends_with(&target.file_path)
                                        || r_file_name == target_file_name
                                });
                                import_confidence(file_resolved, file_resolved, true)
                            } else {
                                import_confidence(same_file, same_file, true)
                            }
                        } else {
                            import_confidence(false, false, false)
                        };

                        // Only create cross-file import edges (same-file imports are implicit via Contains)
                        if !same_file {
                            Self::push_edge(
                                repo_id,
                                entity.id,
                                target.id,
                                EdgeKind::Imports,
                                confidence,
                                EdgeSource::Static,
                                seen,
                                edges,
                            );
                        }
                    }
                }
            }
        }
    }

    fn extract_reexport_import_edges(
        repo_id: Uuid,
        repo_root: &Path,
        entities: &[Entity],
        source_by_file: &HashMap<String, String>,
        seen: &mut HashSet<(Uuid, Uuid, EdgeKind)>,
        _edges: &mut Vec<Edge>,
        reexport_edges: &mut Vec<Edge>,
    ) {
        for (file_path, file_source) in source_by_file {
            for line in file_source.lines() {
                let trimmed = line.trim();
                if !is_ts_reexport(trimmed) {
                    continue;
                }
                // export { X } from './y' or export * from './y'
                let Some(module_path) = parse_ts_module_path(trimmed) else {
                    continue;
                };

                // Extract names from re-export
                let reexported_names: Vec<String> = if trimmed.contains('*') {
                    // export * from './y' — all entities from that file are re-exported
                    let resolved = resolve_relative_import(file_path, &module_path, repo_root);
                    if let Some(ref resolved_path) = resolved {
                        let resolved_str = resolved_path.to_string_lossy().to_string();
                        entities
                            .iter()
                            .filter(|e| {
                                e.file_path == resolved_str
                                    || e.file_path
                                        == resolved_path.with_extension("").to_string_lossy()
                            })
                            .map(|e| e.name.clone())
                            .collect()
                    } else {
                        Vec::new()
                    }
                } else {
                    parse_ts_import_names(trimmed).unwrap_or_default()
                };

                for reexported_name in reexported_names {
                    for entity in entities {
                        if entity.name == reexported_name && entity.file_path != *file_path {
                            // Create a Reexport edge from a synthetic "file re-exporter" entity
                            // Since we don't have a dedicated entity for the re-export statement,
                            // we create the Reexport edge between the original entity and note it
                            Self::push_edge(
                                repo_id,
                                entity.id,
                                entity.id, // self-referencing placeholder — stores the relationship
                                EdgeKind::Reexport,
                                1.0,
                                EdgeSource::Static,
                                seen,
                                reexport_edges,
                            );
                        }
                    }
                }
            }
        }
    }

    fn push_edge(
        repo_id: Uuid,
        source: Uuid,
        target: Uuid,
        kind: EdgeKind,
        confidence: f64,
        source_type: EdgeSource,
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
            confidence,
            source: source_type,
            metadata: None,
            created_at: chrono::Utc::now(),
            validated_at: None,
        });
    }
}

fn parse_rust_module_path(line: &str) -> Option<String> {
    let trimmed = line.trim_start();
    if let Some(rest) = trimmed.strip_prefix("use ") {
        let end = rest.find(';').unwrap_or(rest.len());
        let path = rest[..end].trim();
        let base = path.split("::{").next().unwrap_or(path);
        Some(base.to_string())
    } else {
        None
    }
}

fn parse_python_module_path(line: &str) -> Option<String> {
    let trimmed = line.trim_start();
    if let Some(rest) = trimmed.strip_prefix("from ") {
        rest.find(" import ")
            .map(|pos| rest[..pos].trim().to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crosshash_core::{EntityKind, Visibility};

    fn entity(name: &str, file: &str, language: Language) -> Entity {
        entity_with_span(name, file, language, 0, 1, 0, 1)
    }

    fn entity_with_span(
        name: &str,
        file: &str,
        language: Language,
        start_line: u32,
        end_line: u32,
        start_byte: u32,
        end_byte: u32,
    ) -> Entity {
        Entity {
            id: Uuid::new_v5(&Uuid::NAMESPACE_OID, name.as_bytes()),
            repo_id: Uuid::NAMESPACE_DNS,
            file_path: file.into(),
            language,
            kind: EntityKind::Function,
            name: name.into(),
            qualified_name: name.into(),
            signature: format!("fn {name}()"),
            start_line,
            end_line,
            start_byte,
            end_byte,
            signature_hash: [1; 32],
            content_hash: [2; 32],
            structural_hash: [3; 32],
            identity_hash: [4; 32],
            context_hash: [5; 32],
            visibility: Visibility::Public,
            is_exported: true,
            is_async: false,
            is_test: false,
            first_seen_commit: "a".into(),
            last_seen_commit: "a".into(),
            deleted_at_commit: None,
        }
    }

    #[test]
    fn contains_edges_link_parent_to_child() {
        let mut parent = entity("MyClass", "src/a.ts", Language::TypeScript);
        parent.kind = EntityKind::Class;
        parent.qualified_name = "MyClass".into();
        let mut child = entity("method", "src/a.ts", Language::TypeScript);
        child.qualified_name = "MyClass::method".into();
        let (edges, _) = StaticEdgeExtractor::extract(
            Uuid::NAMESPACE_DNS,
            Path::new("."),
            &[parent.clone(), child.clone()],
            &HashMap::new(),
        );
        let contains: Vec<_> = edges
            .iter()
            .filter(|e| e.kind == EdgeKind::Contains)
            .collect();
        assert_eq!(contains.len(), 1);
        assert_eq!(contains[0].source_entity_id, parent.id);
        assert_eq!(contains[0].target_entity_id, child.id);
    }

    #[test]
    fn call_edges_detected_in_body() {
        let src = "function caller() { callee(); }";
        let caller = entity_with_span(
            "caller",
            "src/a.ts",
            Language::TypeScript,
            1,
            1,
            0,
            src.len() as u32,
        );
        let callee = entity("callee", "src/a.ts", Language::TypeScript);
        let mut sources = HashMap::new();
        sources.insert("src/a.ts".to_string(), src.to_string());
        let (edges, _) = StaticEdgeExtractor::extract(
            Uuid::NAMESPACE_DNS,
            Path::new("."),
            &[caller.clone(), callee.clone()],
            &sources,
        );
        let calls: Vec<_> = edges.iter().filter(|e| e.kind == EdgeKind::Calls).collect();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].source_entity_id, caller.id);
        assert_eq!(calls[0].target_entity_id, callee.id);
    }

    #[test]
    fn ts_import_edge_extracted_cross_file() {
        let importer = entity("bar", "src/b.ts", Language::TypeScript);
        let importee = entity("foo", "src/a.ts", Language::TypeScript);
        let mut sources = HashMap::new();
        sources.insert(
            "src/a.ts".to_string(),
            "export function foo() {}".to_string(),
        );
        sources.insert(
            "src/b.ts".to_string(),
            "import { foo } from './a'; function bar() { foo(); }".to_string(),
        );
        let (edges, _) = StaticEdgeExtractor::extract(
            Uuid::NAMESPACE_DNS,
            Path::new("."),
            &[importer.clone(), importee.clone()],
            &sources,
        );
        let imports: Vec<_> = edges
            .iter()
            .filter(|e| e.kind == EdgeKind::Imports)
            .collect();
        assert!(
            imports
                .iter()
                .any(|e| e.source_entity_id == importer.id && e.target_entity_id == importee.id),
            "expected import edge from bar to foo"
        );
    }

    #[test]
    fn rust_use_import_edge_extracted() {
        let user = entity("User", "src/models.rs", Language::Rust);
        let api = entity("api", "src/main.rs", Language::Rust);
        let mut sources = HashMap::new();
        sources.insert(
            "src/models.rs".to_string(),
            "pub struct User {}".to_string(),
        );
        sources.insert(
            "src/main.rs".to_string(),
            "use crate::models::User; fn api() {}".to_string(),
        );
        let (edges, _) = StaticEdgeExtractor::extract(
            Uuid::NAMESPACE_DNS,
            Path::new("."),
            &[user.clone(), api.clone()],
            &sources,
        );
        let imports: Vec<_> = edges
            .iter()
            .filter(|e| e.kind == EdgeKind::Imports)
            .collect();
        assert!(
            imports
                .iter()
                .any(|e| e.source_entity_id == api.id && e.target_entity_id == user.id),
            "expected import edge from api to User"
        );
    }

    #[test]
    fn python_import_edge_extracted() {
        let util = entity("helper", "utils.py", Language::Python);
        let main_fn = entity("process", "main.py", Language::Python);
        let mut sources = HashMap::new();
        sources.insert("utils.py".to_string(), "def helper(): pass".to_string());
        sources.insert(
            "main.py".to_string(),
            "from utils import helper\ndef process(): pass".to_string(),
        );
        let (edges, _) = StaticEdgeExtractor::extract(
            Uuid::NAMESPACE_DNS,
            Path::new("."),
            &[util.clone(), main_fn.clone()],
            &sources,
        );
        let imports: Vec<_> = edges
            .iter()
            .filter(|e| e.kind == EdgeKind::Imports)
            .collect();
        assert!(
            imports
                .iter()
                .any(|e| e.source_entity_id == main_fn.id && e.target_entity_id == util.id),
            "expected import edge from process to helper"
        );
    }

    #[test]
    fn extends_edge_extracted_for_class_hierarchy() {
        let base_src = "export class Animal {}";
        let derived_src = "export class Dog extends Animal {}";
        let mut base = entity_with_span(
            "Animal",
            "src/a.ts",
            Language::TypeScript,
            1,
            1,
            0,
            base_src.len() as u32,
        );
        base.kind = EntityKind::Class;
        let mut derived = entity_with_span(
            "Dog",
            "src/b.ts",
            Language::TypeScript,
            1,
            1,
            0,
            derived_src.len() as u32,
        );
        derived.kind = EntityKind::Class;
        let mut sources = HashMap::new();
        sources.insert("src/a.ts".to_string(), base_src.to_string());
        sources.insert("src/b.ts".to_string(), derived_src.to_string());
        let (edges, _) = StaticEdgeExtractor::extract(
            Uuid::NAMESPACE_DNS,
            Path::new("."),
            &[base.clone(), derived.clone()],
            &sources,
        );
        let extends: Vec<_> = edges
            .iter()
            .filter(|e| e.kind == EdgeKind::Extends)
            .collect();
        assert_eq!(extends.len(), 1);
        assert_eq!(extends[0].source_entity_id, derived.id);
        assert_eq!(extends[0].target_entity_id, base.id);
    }

    #[test]
    fn no_self_edges() {
        let ent = entity("foo", "src/a.ts", Language::TypeScript);
        let mut sources = HashMap::new();
        sources.insert("src/a.ts".to_string(), "function foo() {}".to_string());
        let (edges, _) = StaticEdgeExtractor::extract(
            Uuid::NAMESPACE_DNS,
            Path::new("."),
            std::slice::from_ref(&ent),
            &sources,
        );
        assert!(edges.is_empty(), "should not create self-edges");
    }

    #[test]
    fn rust_brace_import_extracts_multiple_names() {
        let imports = RustResolver::extract_imports(
            "use std::collections::{HashMap, HashSet};",
            "src/lib.rs",
        );
        let names: Vec<_> = imports.iter().map(|i| i.imported_name.clone()).collect();
        assert!(names.contains(&"HashMap".to_string()));
        assert!(names.contains(&"HashSet".to_string()));
    }

    #[test]
    fn python_from_import_extracts_names() {
        let imports = PythonResolver::extract_imports(
            "from os.path import join, exists\nfrom sys import argv as a",
            "main.py",
        );
        let names: Vec<_> = imports.iter().map(|i| i.imported_name.clone()).collect();
        assert!(names.contains(&"join".to_string()));
        assert!(names.contains(&"exists".to_string()));
        assert!(names.contains(&"a".to_string()));
    }

    #[test]
    fn ts_default_import_edge_extracted() {
        let importer = entity("bar", "src/b.ts", Language::TypeScript);
        let importee = entity("Foo", "src/a.ts", Language::TypeScript);
        let mut sources = HashMap::new();
        sources.insert(
            "src/a.ts".to_string(),
            "export default class Foo {}".to_string(),
        );
        sources.insert(
            "src/b.ts".to_string(),
            "import Foo from './a'; fn bar() {}".to_string(),
        );
        let (edges, _) = StaticEdgeExtractor::extract(
            Uuid::NAMESPACE_DNS,
            Path::new("."),
            &[importer.clone(), importee.clone()],
            &sources,
        );
        let imports: Vec<_> = edges
            .iter()
            .filter(|e| e.kind == EdgeKind::Imports)
            .collect();
        assert!(
            imports
                .iter()
                .any(|e| e.source_entity_id == importer.id && e.target_entity_id == importee.id),
            "expected import edge from bar to Foo (default import)"
        );
    }

    #[test]
    fn ts_aliased_import_edge_extracted() {
        let importer = entity("bar", "src/b.ts", Language::TypeScript);
        let importee = entity("Foo", "src/a.ts", Language::TypeScript);
        let mut sources = HashMap::new();
        sources.insert(
            "src/a.ts".to_string(),
            "export function Foo() {}".to_string(),
        );
        sources.insert(
            "src/b.ts".to_string(),
            "import { Foo as F } from './a'; fn bar() { F(); }".to_string(),
        );
        let (edges, _) = StaticEdgeExtractor::extract(
            Uuid::NAMESPACE_DNS,
            Path::new("."),
            &[importer, importee],
            &sources,
        );
        let imports: Vec<_> = edges
            .iter()
            .filter(|e| e.kind == EdgeKind::Imports)
            .collect();
        assert!(!imports.is_empty(), "aliased import should produce edge");
    }

    #[test]
    fn rust_as_import_uses_alias() {
        let imports =
            RustResolver::extract_imports("use std::collections::HashMap as Map;", "src/lib.rs");
        let names: Vec<_> = imports.iter().map(|i| i.imported_name.clone()).collect();
        assert!(
            names.contains(&"Map".to_string()),
            "use ... as X should extract X"
        );
    }

    #[test]
    fn rust_use_self_import() {
        let imports = RustResolver::extract_imports("use crate::db::User;", "src/lib.rs");
        let names: Vec<_> = imports.iter().map(|i| i.imported_name.clone()).collect();
        assert!(names.contains(&"User".to_string()));
    }

    #[test]
    fn implements_edge_extracted_for_ts_class() {
        let iface_src = "export interface Serializable {}";
        let cls_src = "export class Model implements Serializable {}";
        let mut iface = entity_with_span(
            "Serializable",
            "src/a.ts",
            Language::TypeScript,
            1,
            1,
            0,
            iface_src.len() as u32,
        );
        iface.kind = EntityKind::Interface;
        let mut cls = entity_with_span(
            "Model",
            "src/b.ts",
            Language::TypeScript,
            1,
            1,
            0,
            cls_src.len() as u32,
        );
        cls.kind = EntityKind::Class;
        let mut sources = HashMap::new();
        sources.insert("src/a.ts".to_string(), iface_src.to_string());
        sources.insert("src/b.ts".to_string(), cls_src.to_string());
        let (edges, _) = StaticEdgeExtractor::extract(
            Uuid::NAMESPACE_DNS,
            Path::new("."),
            &[iface.clone(), cls.clone()],
            &sources,
        );
        let impls: Vec<_> = edges
            .iter()
            .filter(|e| e.kind == EdgeKind::Implements)
            .collect();
        assert_eq!(impls.len(), 1);
        assert_eq!(impls[0].source_entity_id, cls.id);
        assert_eq!(impls[0].target_entity_id, iface.id);
    }

    #[test]
    fn resolve_relative_import_with_ts_extension() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("a.ts"), "").unwrap();
        let resolved = resolve_relative_import("src/b.ts", "./a", dir.path());
        assert!(resolved.is_some());
        let resolved_str = resolved.unwrap().to_string_lossy().to_string();
        assert!(resolved_str.ends_with("a.ts"), "got: {resolved_str}");
    }

    #[test]
    fn resolve_relative_import_with_index_ts() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        let utils = src.join("utils");
        std::fs::create_dir_all(&utils).unwrap();
        std::fs::write(utils.join("index.ts"), "").unwrap();
        let resolved = resolve_relative_import("src/main.ts", "./utils", dir.path());
        assert!(resolved.is_some());
        let resolved_str = resolved.unwrap().to_string_lossy().to_string();
        assert!(resolved_str.ends_with("index.ts"), "got: {resolved_str}");
    }

    #[test]
    fn resolve_relative_import_non_relative_returns_none() {
        let resolved = resolve_relative_import("src/main.ts", "lodash", Path::new("/tmp"));
        assert!(resolved.is_none(), "non-relative import should return None");
    }

    #[test]
    fn import_confidence_matrix() {
        assert_eq!(import_confidence(true, true, true), 1.0);
        assert_eq!(import_confidence(true, true, false), 1.0);
        assert_eq!(import_confidence(false, true, true), 0.8);
        assert_eq!(import_confidence(false, true, false), 0.5);
        assert_eq!(import_confidence(false, false, true), 0.3);
        assert_eq!(import_confidence(false, false, false), 0.3);
    }

    #[test]
    fn confidence_high_for_resolved_import() {
        let importer = entity("bar", "src/b.ts", Language::TypeScript);
        let importee = entity("foo", "src/a.ts", Language::TypeScript);
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("a.ts"), "export function foo() {}").unwrap();
        std::fs::write(src.join("b.ts"), "import { foo } from './a'; fn bar() {}").unwrap();
        let mut sources = HashMap::new();
        sources.insert(
            "src/a.ts".to_string(),
            "export function foo() {}".to_string(),
        );
        sources.insert(
            "src/b.ts".to_string(),
            "import { foo } from './a'; fn bar() {}".to_string(),
        );
        let (edges, _) = StaticEdgeExtractor::extract(
            Uuid::NAMESPACE_DNS,
            dir.path(),
            &[importer, importee],
            &sources,
        );
        let import = edges.iter().find(|e| e.kind == EdgeKind::Imports);
        assert!(import.is_some());
        assert!(
            import.unwrap().confidence >= 0.5,
            "resolved import should have at least medium confidence, got {}",
            import.unwrap().confidence
        );
    }

    #[test]
    fn confidence_low_for_unresolved_import() {
        let importer = entity("bar", "src/b.ts", Language::TypeScript);
        let importee = entity("foo", "other/foo.ts", Language::TypeScript);
        let mut sources = HashMap::new();
        sources.insert(
            "src/b.ts".to_string(),
            "import { foo } from 'some-package'; fn bar() {}".to_string(),
        );
        sources.insert(
            "other/foo.ts".to_string(),
            "export function foo() {}".to_string(),
        );
        let (edges, _) = StaticEdgeExtractor::extract(
            Uuid::NAMESPACE_DNS,
            Path::new("."),
            &[importer, importee],
            &sources,
        );
        let import = edges.iter().find(|e| e.kind == EdgeKind::Imports);
        assert!(import.is_some());
        assert!(
            import.unwrap().confidence <= 0.5,
            "unresolved import should have low confidence"
        );
    }

    #[test]
    fn parse_ts_import_names_handles_brace_imports() {
        let result = parse_ts_import_names("import { Foo, Bar } from './module'");
        assert!(result.is_some());
        let names = result.unwrap();
        assert_eq!(names, vec!["Foo", "Bar"]);
    }

    #[test]
    fn parse_ts_import_names_handles_aliased_brace_imports() {
        let result = parse_ts_import_names("import { Foo as F, Bar as B } from './module'");
        assert!(result.is_some());
        let names = result.unwrap();
        assert_eq!(names, vec!["Foo", "Bar"]);
    }

    #[test]
    fn parse_ts_import_names_handles_default_import() {
        let result = parse_ts_import_names("import Foo from './module'");
        assert!(result.is_some());
        assert_eq!(result.unwrap(), vec!["Foo"]);
    }

    #[test]
    fn parse_ts_module_path_extracts_path() {
        assert_eq!(
            parse_ts_module_path("import { X } from './foo'"),
            Some("./foo".to_string())
        );
        assert_eq!(
            parse_ts_module_path("import { X } from \"./foo\""),
            Some("./foo".to_string())
        );
        assert_eq!(
            parse_ts_module_path("export { X } from '../bar'"),
            Some("../bar".to_string())
        );
    }

    #[test]
    fn parse_ts_module_path_handles_non_ascii_before_from() {
        // 'İ' (U+0130) lowercases to a 3-byte sequence, so offsets from the
        // lowercased line used to slice `line` mid-character and panic
        // (#319). to_ascii_lowercase keeps byte lengths identical.
        let line = "import { İ } from './x';";
        assert_eq!(parse_ts_module_path(line).as_deref(), Some("./x"));
    }
}
