const { createParserRegistry } = require('./parser-registry');

function normalizeSymbol(symbol, fallbackFilePath) {
  return {
    file_path: symbol.file_path || fallbackFilePath,
    name: symbol.name,
    kind: symbol.kind,
    signature: symbol.signature || '',
    qualified_name: symbol.qualified_name || symbol.name,
    start_line: symbol.start_line,
    end_line: symbol.end_line,
    start_byte: symbol.start_byte,
    end_byte: symbol.end_byte,
    docstring: symbol.docstring || '',
    body_preview: symbol.body_preview || '',
    language: symbol.language || '',
    parent_name: symbol.parent_name || '',
  };
}

function extractSymbolsFromFile(filePath, registry = createParserRegistry()) {
  if (!registry.canParseFile(filePath)) {
    return [];
  }
  return registry.parseFile(filePath).map((symbol) => normalizeSymbol(symbol, filePath));
}

module.exports = { extractSymbolsFromFile, normalizeSymbol };
