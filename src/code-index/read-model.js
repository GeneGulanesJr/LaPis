/**
 * Stable read model for the code-index feature.
 *
 * These names intentionally mirror the persisted code-index domain rather than
 * memory/trust concepts so indexing can be used without loading those services.
 */

/** @typedef {{ id: number, name: string, path: string, file_count?: number, symbol_count?: number, indexed_at?: string, updated_at?: string, head_commit?: string }} CodeRepository */
/** @typedef {{ id: number, repo_id: number, path: string, language: string, content?: string, content_hash?: string, mtime?: number, size_bytes?: number, line_count?: number }} CodeFile */
/** @typedef {{ id?: number, repo_id?: number, file_id?: number, file_path: string, name: string, kind: string, signature?: string, qualified_name?: string, start_line: number, end_line: number, start_byte: number, end_byte: number, docstring?: string, body_preview?: string, language: string, parent_name?: string }} CodeSymbol */
/** @typedef {{ id?: number, repo_id: number, source_file_id: number, target_module: string, target_file_id?: number | null, import_type: string, line_number?: number }} ImportEdge */
/** @typedef {{ id?: number, repo_id: number, caller_symbol_id: number, callee_name: string, callee_symbol_id?: number | null, confidence: number, line_number?: number }} CallEdge */
/** @typedef {{ id?: number, symbol_id: number, cyclomatic: number, nesting_depth: number, param_count: number, lines_of_code: number, assessment: string }} ComplexityMetric */

module.exports = {};
