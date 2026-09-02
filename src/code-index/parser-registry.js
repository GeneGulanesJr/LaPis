const path = require('path');
const codeParser = require('../../parse-code');
const { CODE_EXTENSIONS } = require('../../utils'),
  LANGUAGE_BY_EXTENSION = Object.freeze({
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.ts': 'typescript',
    '.mts': 'typescript',
    '.cts': 'typescript',
    '.tsx': 'typescript',
    '.py': 'python',
    '.pyw': 'python',
    '.go': 'go',
    '.rs': 'rust',
    '.sh': 'bash',
    '.bash': 'bash',
    '.json': 'json',
    '.jsonc': 'json',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.html': 'html',
    '.css': 'css',
    '.scss': 'scss',
    '.sql': 'sql',
  });

function getLanguageForFile(filePath) {
  return LANGUAGE_BY_EXTENSION[path.extname(filePath).toLowerCase()] || null;
}

function canParseFile(filePath) {
  return CODE_EXTENSIONS.has(path.extname(filePath).toLowerCase()) && Boolean(getLanguageForFile(filePath));
}

async function ensureParserAvailable(parser = codeParser) {
  if (parser.isReady()) {
    return true;
  }
  await parser.init();
  return parser.isReady();
}

function createParserRegistry(parser = codeParser) {
  return Object.freeze({
    getLanguageForFile,
    canParseFile,
    async ensureReady() {
      return ensureParserAvailable(parser);
    },
    parseFile(filePath) {
      return parser.parseFile(filePath);
    },
    parseContent(filePath, content) {
      return parser.parseContent(filePath, content);
    },
    extractCallees(filePath) {
      return parser.extractCallees(filePath);
    },
    extractCalleesFromContent(filePath, content) {
      return parser.extractCalleesFromContent(filePath, content);
    },
    /**
     * Parse a file and return the raw tree-sitter tree (for scope building).
     * Returns { tree, parser } or null if language not supported.
     */
    parseTree(filePath, content) {
      const lang = getLanguageForFile(filePath);
      if (!lang) {
        return null;
      }
      return parser.parseTree(filePath, content);
    },
  });
}

module.exports = {
  LANGUAGE_BY_EXTENSION,
  getLanguageForFile,
  canParseFile,
  ensureParserAvailable,
  createParserRegistry,
};
