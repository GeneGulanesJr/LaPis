const path = require('path');
const codeParser = require('../../parse-code');
const { CODE_EXTENSIONS } = require('../../utils');

const LANGUAGE_BY_EXTENSION = Object.freeze({
  '.js': 'javascript',
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
    extractCallees(filePath) {
      return parser.extractCallees(filePath);
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
