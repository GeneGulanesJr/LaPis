/**
 * Compatibility facade for documentation indexing.
 *
 * The implementation lives in src/doc-index so documentation parsing,
 * indexing, links, glossary, examples, and analytics are modular peer
 * features rather than incidental memory-store branches.
 */
module.exports = require('./src/doc-index');
