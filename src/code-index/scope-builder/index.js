// Scope builder orchestrator — picks the right builder per language.
// Each builder is a pure function: (tree, source, filePath) => Binding[]

const path = require('path'), { buildJsTsScopeBindings } = require('./js-ts-scope'), { buildPythonScopeBindings } = require('./python-scope'), { buildGoScopeBindings } = require('./go-scope'), { buildRustScopeBindings } = require('./rust-scope'), { buildSqlScopeBindings } = require('./sql-scope'), { buildHtmlScopeBindings } = require('./html-scope'),
  // Map file extensions to builder functions.
  // This mirrors the LANGUAGE_MAP in parse-code.js.
  SCOPE_BUILDER_MAP = {
    '.js': buildJsTsScopeBindings,
    '.jsx': buildJsTsScopeBindings,
    '.mjs': buildJsTsScopeBindings,
    '.cjs': buildJsTsScopeBindings,
    '.ts': buildJsTsScopeBindings,
    '.mts': buildJsTsScopeBindings,
    '.cts': buildJsTsScopeBindings,
    '.tsx': buildJsTsScopeBindings,
    '.py': buildPythonScopeBindings,
    '.pyw': buildPythonScopeBindings,
    '.go': buildGoScopeBindings,
    '.rs': buildRustScopeBindings,
    '.sql': buildSqlScopeBindings,
    '.html': buildHtmlScopeBindings,
  };







/**
 * Get the appropriate scope builder function for a file.
 * @param {string} filePath - File path to determine language from
 * @returns {function|null} The scope builder function, or null if unsupported
 */
function getScopeBuilder(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return SCOPE_BUILDER_MAP[ext] || null;
}

/**
 * Build scope bindings for a file using the tree-sitter AST.
 * @param {object} tree - tree-sitter tree (from parser.parse(source))
 * @param {string} source - source code content
 * @param {string} filePath - file path (used to determine language)
 * @returns {Array} Array of binding objects, or empty array if unsupported
 */
function buildScopeBindings(tree, source, filePath) {
  const builder = getScopeBuilder(filePath);
  if (!builder) {
    return [];
  }
  try {
    return builder(tree, source, filePath);
  } catch {
    return [];
  }
}

module.exports = {
  getScopeBuilder,
  buildScopeBindings,
  SCOPE_BUILDER_MAP,
};
