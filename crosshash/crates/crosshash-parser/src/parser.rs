use crate::ignore::collect_source_files;
use crate::language_detect::detect_language;
use crosshash_core::{CoreError, Language, Result};
use rayon::prelude::*;
use std::fs;
use std::path::{Path, PathBuf};
use tree_sitter::{Parser, Tree};

#[derive(Debug, Clone)]
pub struct ParserConfig {
    pub languages: Vec<Language>,
}

impl Default for ParserConfig {
    fn default() -> Self {
        Self {
            languages: vec![
                Language::Rust,
                Language::TypeScript,
                Language::JavaScript,
                Language::Python,
                Language::Go,
                Language::Java,
                Language::C,
                Language::Cpp,
                Language::CSharp,
                Language::Ruby,
                Language::Php,
                Language::Swift,
                Language::Kotlin,
                Language::Scala,
                Language::Elixir,
                Language::Dart,
                Language::Ocaml,
                Language::Zig,
                Language::Bash,
            ],
        }
    }
}

#[derive(Debug)]
pub struct ParsedFile {
    pub path: PathBuf,
    pub language: Language,
    pub source: String,
    pub tree: Tree,
    pub has_error: bool,
}

pub struct ParserEngine {
    config: ParserConfig,
}

impl ParserEngine {
    pub fn new(config: ParserConfig) -> Self {
        Self { config }
    }

    pub fn parse_file(&self, path: &Path, language: Language) -> Result<ParsedFile> {
        let source = fs::read_to_string(path).map_err(|e| CoreError::Io(e.to_string()))?;
        let tree = parse_source(&source, language)?;
        let has_error = tree.root_node().has_error();
        Ok(ParsedFile {
            path: path.to_path_buf(),
            language,
            source,
            tree,
            has_error,
        })
    }

    pub fn parse_repo(&self, repo_path: &Path) -> Result<Vec<ParsedFile>> {
        let files = collect_source_files(repo_path, &self.config.languages)?;
        files
            .par_iter()
            .filter_map(|path| {
                let language = match detect_language(path) {
                    Ok(Some(language)) => language,
                    _ => return None,
                };
                Some(self.parse_file(path, language))
            })
            .collect()
    }
}

pub fn parse_file(path: &Path, language: Language) -> Result<Tree> {
    let source = fs::read_to_string(path).map_err(|e| CoreError::Io(e.to_string()))?;
    parse_source(&source, language)
}

pub fn parse_source(source: &str, language: Language) -> Result<Tree> {
    let mut parser = Parser::new();
    match language {
        Language::Rust => parser.set_language(&tree_sitter_rust::language()),
        Language::TypeScript => parser.set_language(&tree_sitter_typescript::language_typescript()),
        Language::JavaScript => parser.set_language(&tree_sitter_typescript::language_tsx()),
        Language::Python => parser.set_language(&tree_sitter_python::language()),
        Language::Go => parser.set_language(&tree_sitter_go::language()),
        Language::Java => parser.set_language(&tree_sitter_java::language()),
        Language::C => parser.set_language(&tree_sitter_c::language()),
        Language::Cpp => parser.set_language(&tree_sitter_cpp::language()),
        Language::CSharp => parser.set_language(&tree_sitter_c_sharp::language()),
        Language::Ruby => parser.set_language(&tree_sitter_ruby::language()),
        Language::Swift | Language::Dart | Language::Zig => {
            return Err(CoreError::UnsupportedLanguage(format!(
                "{language:?} grammar crate is incompatible with tree-sitter 0.22"
            )))
        }
        Language::Php => parser.set_language(&tree_sitter_php::language_php()),
        Language::Kotlin => parser.set_language(&tree_sitter_kotlin::language()),
        Language::Scala => parser.set_language(&tree_sitter_scala::language()),
        Language::Elixir => parser.set_language(&tree_sitter_elixir::language()),
        Language::Ocaml => parser.set_language(&tree_sitter_ocaml::language_ocaml()),
        Language::Bash => parser.set_language(&tree_sitter_bash::language()),
        Language::Html | Language::Css => {
            return Err(CoreError::UnsupportedLanguage(format!(
                "{language:?} is detected but entity extraction is not yet supported"
            )))
        }
        Language::Unknown => {
            return Err(CoreError::UnsupportedLanguage(
                "Unknown language".to_string(),
            ))
        }
    }
    .map_err(|e| CoreError::ParseError(e.to_string()))?;

    parser
        .parse(source, None)
        .ok_or_else(|| CoreError::ParseError("tree-sitter returned no tree".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn parses_rust_typescript_and_python_sources() {
        assert_eq!(
            parse_source("fn main() {}", Language::Rust)
                .unwrap()
                .root_node()
                .kind(),
            "source_file"
        );
        assert_eq!(
            parse_source("export function f() {}", Language::TypeScript)
                .unwrap()
                .root_node()
                .kind(),
            "program"
        );
        assert_eq!(
            parse_source("def f():\n    pass\n", Language::Python)
                .unwrap()
                .root_node()
                .kind(),
            "module"
        );
    }

    #[test]
    fn parses_go_java_c_sources() {
        assert_eq!(
            parse_source("package main\nfunc main() {}\n", Language::Go)
                .unwrap()
                .root_node()
                .kind(),
            "source_file"
        );
        assert_eq!(
            parse_source("class Main { public static void main(String[] args) {} }\n", Language::Java)
                .unwrap()
                .root_node()
                .kind(),
            "program"
        );
        assert_eq!(
            parse_source("int main() { return 0; }\n", Language::C)
                .unwrap()
                .root_node()
                .kind(),
            "translation_unit"
        );
    }

    #[test]
    fn parse_repo_skips_unknown_and_returns_partial_error_trees() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("src")).unwrap();
        fs::write(dir.path().join("src/lib.rs"), "fn ok() {}").unwrap();
        fs::write(dir.path().join("src/bad.py"), "def broken(:\n").unwrap();
        fs::write(dir.path().join("README.md"), "skip").unwrap();

        let parsed = ParserEngine::new(ParserConfig::default())
            .parse_repo(dir.path())
            .unwrap();
        assert_eq!(parsed.len(), 2);
        assert!(parsed.iter().any(|f| f.has_error));
    }
}
