#!/usr/bin/env node
/**
 * Parse-code.js — web-tree-sitter (WASM) AST parser
 *
 * Replaces parse_code.py. Zero Python dependency.
 * In-process parsing via web-tree-sitter WASM runtime + pre-compiled grammar .wasm files.
 *
 * Usage:
 *   const codeParser = require('./parse-code');
 *   await codeParser.init();
 *   const symbols = codeParser.parseFile('/path/to/file.js');
 *
 * Supported: .js/.jsx/.mjs/.cjs, .ts/.mts/.cts, .tsx, .sql
 */

const path = require('path');
const fs = require('fs');
const { SKIP_CALLEE_NAMES } = require('./utils');

// Resolve web-tree-sitter from the nearest node_modules (handles npm hoisting).
// Falls back to the legacy __dirname-relative path for backward compatibility.
let _wtsPath;
try {
  _wtsPath = require.resolve('web-tree-sitter/web-tree-sitter.cjs', { paths: [__dirname] });
} catch {
  _wtsPath = path.resolve(__dirname, 'node_modules', 'web-tree-sitter', 'web-tree-sitter.cjs');
}

const GRAMMAR_DIR = path.resolve(__dirname, 'grammars');

// Language map: file extension → { grammarFile, languageName, parserKey }
const LANGUAGE_MAP = {
  '.js': { grammarFile: 'javascript.wasm', languageName: 'javascript', parserKey: 'javascript' },
  '.jsx': { grammarFile: 'javascript.wasm', languageName: 'javascript', parserKey: 'javascript' },
  '.mjs': { grammarFile: 'javascript.wasm', languageName: 'javascript', parserKey: 'javascript' },
  '.cjs': { grammarFile: 'javascript.wasm', languageName: 'javascript', parserKey: 'javascript' },
  '.ts': { grammarFile: 'typescript.wasm', languageName: 'typescript', parserKey: 'typescript' },
  '.mts': { grammarFile: 'typescript.wasm', languageName: 'typescript', parserKey: 'typescript' },
  '.cts': { grammarFile: 'typescript.wasm', languageName: 'typescript', parserKey: 'typescript' },
  '.tsx': { grammarFile: 'tsx.wasm', languageName: 'typescript', parserKey: 'tsx' },
  '.py': { grammarFile: 'tree-sitter-python.wasm', languageName: 'python', parserKey: 'python' },
  '.pyw': { grammarFile: 'tree-sitter-python.wasm', languageName: 'python', parserKey: 'python' },
  '.go': { grammarFile: 'tree-sitter-go.wasm', languageName: 'go', parserKey: 'go' },
  '.rs': { grammarFile: 'tree-sitter-rust.wasm', languageName: 'rust', parserKey: 'rust' },
  '.sh': { grammarFile: null, languageName: 'bash', extractor: 'regex' },
  '.bash': { grammarFile: null, languageName: 'bash', extractor: 'regex' },
  '.json': { grammarFile: null, languageName: 'json', extractor: 'regex' },
  '.jsonc': { grammarFile: null, languageName: 'json', extractor: 'regex' },
  '.yaml': { grammarFile: null, languageName: 'yaml', extractor: 'regex' },
  '.yml': { grammarFile: null, languageName: 'yaml', extractor: 'regex' },
  '.html': { grammarFile: null, languageName: 'html', extractor: 'regex' },
  '.css': { grammarFile: null, languageName: 'css', extractor: 'regex' },
  '.scss': { grammarFile: null, languageName: 'scss', extractor: 'regex' },
  '.sql': { grammarFile: 'sql.wasm', languageName: 'sql', parserKey: 'sql', extractor: 'sql' },
};

// ── Module state ──
let _ready = false;
let _initPromise = null;
let _ParserClass = null;
let _LanguageClass = null;
const _parsers = {}; // ParserKey → Parser instance
const _languages = {}; // ParserKey → Language object

/**
 * Initialize web-tree-sitter and load all available grammar .wasm files.
 * Must be called (and awaited) before parseFile().
 * Safe to call multiple times — returns same promise.
 */
async function init() {
  if (_ready) {
    return;
  }
  if (_initPromise) {
    return _initPromise;
  }

  _initPromise = (async () => {
    try {
      const mod = require(_wtsPath);
      _ParserClass = mod.Parser;
      _LanguageClass = mod.Language;
      await _ParserClass.init();

      // Load available grammars (key → wasm filename)
      const grammarEntries = Object.entries(LANGUAGE_MAP).map(([, config]) => [config.parserKey, config.grammarFile]);
      // Deduplicate by parserKey
      const uniqueEntries = [...new Map(grammarEntries).entries()];

      for (const [key, wasmFile] of uniqueEntries) {
        if (!wasmFile || !key) continue; // Skip regex-based extractors (no WASM grammar)
        const wasmPath = path.join(GRAMMAR_DIR, wasmFile);
        if (!fs.existsSync(wasmPath)) {
          // Skip silently — grammar not bundled
          continue;
        }
        try {
          const lang = await _LanguageClass.load(wasmPath);
          _languages[key] = lang;
          const parser = new _ParserClass();
          parser.setLanguage(lang);
          _parsers[key] = parser;
        } catch (e) {
          console.error(`[parse-code] Failed to load grammar ${wasmFile}: ${e.message}`);
        }
      }

      _ready = Object.keys(_parsers).length > 0;
      if (!_ready) {
        console.error('[parse-code] No grammars loaded. Code indexing disabled.');
      }
    } catch (e) {
      console.error(`[parse-code] Init failed: ${e.message}`);
      _ready = false;
    }
  })();

  return _initPromise;
}

function isReady() {
  return _ready;
}

/**
 * Return info about loaded grammars (for debugging).
 */
function info() {
  return {
    ready: _ready,
    grammars: Object.keys(_parsers),
    grammarDir: GRAMMAR_DIR,
    availableFiles: fs.existsSync(GRAMMAR_DIR) ? fs.readdirSync(GRAMMAR_DIR).filter((f) => f.endsWith('.wasm')) : [],
  };
}

/**
 * Parse a single file and return an array of symbol objects.
 * Returns [] if parser not initialized or file cannot be parsed.
 * Synchronous — must call init() first.
 */
function _routeToExtractor(filePath, source, parser, langConfig) {
  if (langConfig.extractor === 'regex') {
    if (langConfig.languageName === 'html') {
      return _extractHtmlSymbols(filePath, source);
    }
    if (langConfig.languageName === 'css' || langConfig.languageName === 'scss') {
      return _extractCssSymbols(filePath, source);
    }
    if (langConfig.languageName === 'bash') {
      return _extractBashSymbols(filePath, source);
    }
    if (langConfig.languageName === 'json') {
      return _extractJsonSymbols(filePath, source);
    }
    if (langConfig.languageName === 'yaml') {
      return _extractYamlSymbols(filePath, source);
    }
    if (langConfig.languageName === 'sql') {
      return _extractSqlSymbolsRegex(filePath, source);
    }
    return [];
  }
  if (langConfig.languageName === 'sql') {
    return _extractSqlSymbols(filePath, source, parser);
  }
  if (langConfig.languageName === 'python') {
    return _extractPythonSymbols(filePath, source, parser);
  }
  if (langConfig.languageName === 'go') {
    return _extractGoSymbols(filePath, source, parser);
  }
  if (langConfig.languageName === 'rust') {
    return _extractRustSymbols(filePath, source, parser);
  }
  return _extractJsTsSymbols(filePath, source, parser, langConfig.languageName);
}

function _getLangConfig(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const langConfig = LANGUAGE_MAP[ext];
  if (!langConfig) {return null;}
  // Regex-based extractors don't need a tree-sitter parser
  if (langConfig.extractor === 'regex') {
    return { langConfig, parser: null };
  }
  // SQL: use WASM parser if available, otherwise fall back to regex
  if (langConfig.extractor === 'sql') {
    const parser = _parsers[langConfig.parserKey];
    if (parser) {
      return { langConfig, parser };
    }
    return { langConfig: { ...langConfig, extractor: 'regex' }, parser: null };
  }
  const parser = _parsers[langConfig.parserKey];
  if (!parser) {return null;}
  return { langConfig, parser };
}

function parseContent(filePath, content) {
  if (!_ready) {return [];}
  const cfg = _getLangConfig(filePath);
  if (!cfg) {return [];}

  const symbols = _routeToExtractor(filePath, content, cfg.parser, cfg.langConfig);
  if (symbols.length === 0 && content.trim().length > 0) {
    return _fallbackExtractSymbols(filePath, content);
  }
  return symbols;
}

function parseFile(filePath) {
  if (!_ready) {
    return [];
  }

  const cfg = _getLangConfig(filePath);
  if (!cfg) {
    return [];
  }

  let source;
  try {
    source = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    console.error(`[parse-code] Failed to read ${filePath}: ${e.message}`);
    return [];
  }

  return parseContent(filePath, source);
}

function _getLineFromOffset(content, offset) {
  return content.substring(0, offset).split('\n').length;
}

function _fallbackLanguageFromExtension(ext) {
  if (ext === '.tsx') {
    return 'typescript';
  }
  if (ext === '.jsx') {
    return 'javascript';
  }
  return ext.slice(1);
}

function _fallbackJsTsKind(content, match) {
  if (match[1]) {
    return 'function';
  }
  if (!match[2]) {
    return 'constant';
  }
  const declaration = content.substring(match.index, match.index + 20);
  if (declaration.includes('class ')) {
    return 'class';
  }
  if (declaration.includes('interface ')) {
    return 'interface';
  }
  if (declaration.includes('enum ')) {
    return 'enum';
  }
  return 'type';
}

function _fallbackExtractSymbols(filePath, content) {
  const ext = path.extname(filePath).toLowerCase();
  const symbols = [];
  const seen = new Set();

  function add(name, kind, line, signature, startByte) {
    const key = `${name}:${kind}:${startByte}`;
    if (seen.has(key)) {return;}
    seen.add(key);
    symbols.push({
      name,
      kind,
      language: _fallbackLanguageFromExtension(ext),
      file: filePath,
      signature: signature.length > 200 ? `${signature.slice(0, 197)}...` : signature,
      qualified_name: name,
      start_line: line,
      end_line: line,
      start_byte: startByte,
      end_byte: startByte + signature.length,
      docstring: '',
      body_preview: '',
      parent_name: '',
    });
  }

  const jsTsExts = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.tsx']);
  if (jsTsExts.has(ext)) {
    const re =
      /(?:^|\n)\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function\s+(\w+)|(?:class|interface|type|enum)\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=[^;\n]*)/g;
    let match;
    while ((match = re.exec(content)) !== null) {
      const name = match[1] || match[2] || match[3];
      if (name) {
        const kind = _fallbackJsTsKind(content, match);
        const line = _getLineFromOffset(content, match.index);
        const sig = match[0].trim().split('\n')[0];
        add(name, kind, line, sig, match.index);
      }
    }
  } else if (ext === '.py' || ext === '.pyw') {
    const re = /^(?:async\s+)?(?:def|class)\s+(\w+)/gm;
    let match;
    while ((match = re.exec(content)) !== null) {
      const name = match[1];
      const kind = match[0].includes('def ') ? 'function' : 'class';
      const line = _getLineFromOffset(content, match.index);
      add(name, kind, line, match[0].trim(), match.index);
    }
  } else if (ext === '.go') {
    const funcRe = /^func\s+(?:\([^)]*\)\s*)?(\w+)/gm;
    const typeRe = /^type\s+(\w+)/gm;
    let match;
    while ((match = funcRe.exec(content)) !== null) {
      const line = _getLineFromOffset(content, match.index);
      add(match[1], 'function', line, match[0].trim(), match.index);
    }
    while ((match = typeRe.exec(content)) !== null) {
      const line = _getLineFromOffset(content, match.index);
      add(match[1], 'type', line, match[0].trim(), match.index);
    }
  } else if (ext === '.rs') {
    const fnRe = /(?:^|\n)\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/g;
    const structRe = /(?:^|\n)\s*(?:pub\s+)?struct\s+(\w+)/g;
    const enumRe = /(?:^|\n)\s*(?:pub\s+)?enum\s+(\w+)/g;
    const traitRe = /(?:^|\n)\s*(?:pub\s+)?trait\s+(\w+)/g;
    let match;
    for (const [regex, kind] of [
      [fnRe, 'function'],
      [structRe, 'class'],
      [enumRe, 'enum'],
      [traitRe, 'interface'],
    ]) {
      while ((match = regex.exec(content)) !== null) {
        const line = _getLineFromOffset(content, match.index);
        add(match[1], kind, line, match[0].trim(), match.index);
      }
    }
  } else if (ext === '.sql') {
    const sqlPatterns = [
      { re: /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`\[\]"']?\w+[`\[\]"']?)/gi, kind: 'table' },
      { re: /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?([`\[\]"']?\w+[`\[\]"']?)/gi, kind: 'view' },
      { re: /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?FUNCTION\s+([`\[\]"']?\w+[`\[\]"']?)/gi, kind: 'function' },
      { re: /\bCREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+([`\[\]"']?\w+[`\[\]"']?)/gi, kind: 'trigger' },
      { re: /\bCREATE\s+PROCEDURE\s+([`\[\]"']?\w+[`\[\]"']?)/gi, kind: 'procedure' },
    ];
    for (const { re, kind: symKind } of sqlPatterns) {
      let match;
      re.lastIndex = 0;
      while ((match = re.exec(content)) !== null) {
        const name = match[1].replace(/[`\[\]"']/g, '');
        const line = _getLineFromOffset(content, match.index);
        add(name, symKind, line, match[0].trim(), match.index);
      }
    }
  }

  return symbols;
}

// ═══════════════════════════════════════════════════════════
// JS/TS symbol extraction
// ═══════════════════════════════════════════════════════════

const _JS_TS_SYMBOL_NODES = {
  function_declaration: 'function',
  generator_function_declaration: 'function',
  class_declaration: 'class',
  method_definition: 'method',
  interface_declaration: 'interface',
  type_alias_declaration: 'type',
  enum_declaration: 'enum',
  // V5.1: additional symbol types
  public_field_definition: 'property',
  // V5.3: removed 'assignment_expression' — reassignments like `match = ...` are not top-level symbols
};

const _VARIABLE_FUNCTION_NODES = new Set(['arrow_function', 'function_expression']);

// V5.1: const/let/var declarations that should be extracted as symbols
const _CONST_PATTERN = /^const\s+([A-Z_][A-Z0-9_]*)\s*=/;
const _NAMED_EXPORT_PATTERN = /^export\s+(?:default\s+)?/;

function _getNodeName(node) {
  for (const child of node.children) {
    if (child.type === 'identifier' || child.type === 'type_identifier' || child.type === 'property_identifier') {
      return child.text;
    }
  }
  return null;
}

function _getParentClassName(node) {
  let parent = node.parent;
  while (parent) {
    if (parent.type === 'class_declaration') {
      for (const child of parent.children) {
        if (child.type === 'identifier' || child.type === 'type_identifier') {
          return child.text;
        }
      }
    }
    parent = parent.parent;
  }
  return '';
}

function _getSignature(node, sourceStr) {
  const text = sourceStr.substring(node.startIndex, node.endIndex);
  const firstLine = text.split('\n')[0].trim();
  return firstLine.length > 200 ? `${firstLine.slice(0, 197)}...` : firstLine;
}

function _getDocstring(node) {
  if (!node.parent) {
    return '';
  }
  // Find index manually — WASM node objects don't support indexOf reference equality
  const parent = node.parent;
  let idx = -1;
  for (let i = 0; i < parent.childCount; i++) {
    if (parent.child(i).id === node.id) {
      idx = i;
      break;
    }
  }
  if (idx <= 0) {
    return '';
  }
  const prev = parent.child(idx - 1);
  if (prev.type === 'comment') {
    let text = prev.text;
    if (text.startsWith('/**')) {
      text = text.slice(3);
    } else if (text.startsWith('/*')) {
      text = text.slice(2);
    }
    if (text.endsWith('*/')) {
      text = text.slice(0, -2);
    }
    const lines = text.split('\n');
    const cleaned = [];
    for (let line of lines) {
      line = line.trim();
      if (line.startsWith('* ')) {
        line = line.slice(2);
      } else if (line === '*') {
        line = '';
      }
      cleaned.push(line.trim());
    }
    return cleaned.join('\n').trim();
  }
  return '';
}

function _getBodyPreview(node, sourceStr, maxLines = 5) {
  const text = sourceStr.substring(node.startIndex, node.endIndex);
  const lines = text.split('\n');
  const bodyLines = [];
  for (let i = 1; i < lines.length; i++) {
    const stripped = lines[i].trim();
    if (stripped) {
      bodyLines.push(stripped);
      if (bodyLines.length >= maxLines) {
        break;
      }
    }
  }
  return bodyLines.join('\n');
}

function _getLineNumber(node) {
  const count = 1;
  const n = node;
  // Walk back to count rows
  // Web-tree-sitter provides startPosition.row (0-indexed)
  return node.startPosition.row + 1;
}

function _getEndLineNumber(node) {
  return node.endPosition.row + 1;
}

// V5.3: Find containing context name for inner functions/methods
function _getContextName(node) {
  let current = node.parent;
  while (current) {
    if (current.type === 'function_declaration' || current.type === 'generator_function_declaration') {
      for (const child of current.children) {
        if (child.type === 'identifier') {
          return child.text;
        }
      }
    }
    if (current.type === 'method_definition') {
      for (const child of current.children) {
        if (child.type === 'property_identifier') {
          return child.text;
        }
      }
    }
    if (
      current.type === 'arrow_function' ||
      current.type === 'function_expression'
    ) {
      const vdParent = current.parent;
      if (vdParent && vdParent.type === 'variable_declarator') {
        for (const child of vdParent.children) {
          if (child.type === 'identifier') {
            return child.text;
          }
        }
      }
    }
    if (current.type === 'class_declaration') {
      for (const child of current.children) {
        if (child.type === 'identifier' || child.type === 'type_identifier') {
          return child.text;
        }
      }
    }
    if (current.type === 'object') {
      const varDecl = current.parent;
      if (varDecl && varDecl.type === 'variable_declarator') {
        for (const child of varDecl.children) {
          if (child.type === 'identifier') {
            return child.text;
          }
        }
      }
    }
    if (current.type === 'assignment_expression') {
      const left = current.child(0);
      if (left && (left.type === 'identifier' || left.type === 'member_expression')) {
        return left.text;
      }
    }
    current = current.parent;
  }
  return '';
}

// V5.3: Extract class extends heritage
function _getExtendsClass(node) {
  for (const child of node.children) {
    if (child.type === 'heritage_clause') {
      for (const hc of child.children) {
        if (hc.type === 'type_identifier' || hc.type === 'identifier') {
          return hc.text;
        }
      }
    }
  }
  return '';
}

// V5.3: Scope-creating node types
const _SCOPE_NODES = new Set([
  'function_declaration',
  'generator_function_declaration',
  'method_definition',
  'arrow_function',
  'function_expression',
]);

function _extractJsTsSymbols(filePath, sourceStr, parser, languageName) {
  const tree = parser.parse(sourceStr);
  const root = tree.rootNode;
  const symbols = [];
  const seen = new Set();

  function walk(node, depth) {
    if (node.type in _JS_TS_SYMBOL_NODES) {
      const kind = _JS_TS_SYMBOL_NODES[node.type];
      const name = _getNodeName(node);
      if (name) {
        const key = `${name}:${kind}:${node.startIndex}`;
        if (!seen.has(key)) {
          seen.add(key);
          let parentName = '';
          if (kind === 'method' || kind === 'property') {
            parentName = _getParentClassName(node);
            if (!parentName) {
              parentName = _getContextName(node);
            }
          } else if (kind === 'class') {
            const extendsClass = _getExtendsClass(node);
            if (extendsClass) {
              parentName = extendsClass;
            }
          } else if (depth > 0) {
            parentName = _getContextName(node);
          }
          const qualified = parentName ? `${parentName}.${name}` : name;
          symbols.push({
            name,
            kind,
            language: languageName,
            file: filePath,
            signature: _getSignature(node, sourceStr),
            qualified_name: qualified,
            start_line: _getLineNumber(node),
            end_line: _getEndLineNumber(node),
            start_byte: node.startIndex,
            end_byte: node.endIndex,
            docstring: _getDocstring(node),
            body_preview: _getBodyPreview(node, sourceStr),
            parent_name: parentName,
          });
        }
      }
    } else if (_VARIABLE_FUNCTION_NODES.has(node.type)) {
      const parent = node.parent;
      if (parent && parent.type === 'variable_declarator') {
        let name = null;
        for (const child of parent.children) {
          if (child.type === 'identifier') {
            name = child.text;
            break;
          }
        }
        if (name) {
          const key = `${name}:function:${parent.startIndex}`;
          if (!seen.has(key)) {
            seen.add(key);
            const parentName = _getParentClassName(node) || _getContextName(node);
            const qualified = parentName ? `${parentName}.${name}` : name;
            symbols.push({
              name,
              kind: 'function',
              language: languageName,
              file: filePath,
              signature: _getSignature(parent, sourceStr),
              qualified_name: qualified,
              start_line: _getLineNumber(parent),
              end_line: _getEndLineNumber(parent),
              start_byte: parent.startIndex,
              end_byte: parent.endIndex,
              docstring: _getDocstring(parent),
              body_preview: _getBodyPreview(node, sourceStr),
              parent_name: parentName,
            });
          }
        }
      }
    } else if (node.type === 'variable_declarator' && depth <= 3) {
      let name = null;
      let kind = 'constant';
      for (const child of node.children) {
        if (child.type === 'identifier') {
          name = child.text;
          break;
        }
      }
      if (name) {
        const parent = node.parent;
        let isArrowFn = false;
        if (parent && (parent.type === 'lexical_declaration' || parent.type === 'variable_declaration')) {
          for (const child of node.children) {
            if (child.type === 'arrow_function' || child.type === 'function_expression') {
              isArrowFn = true;
              break;
            }
          }
        }
        if (isArrowFn) {
          kind = 'function';
        } else if (/^[A-Z_][A-Z0-9_]*$/.test(name) || name.startsWith('_')) {
          kind = 'constant';
        } else {
          kind = 'constant';
        }
        const key = `${name}:${kind}:${node.startIndex}`;
        if (!seen.has(key)) {
          seen.add(key);
          const parentName = _getParentClassName(node) || _getContextName(node);
          const lineText = sourceStr
            .substring(node.startIndex, Math.min(node.startIndex + 200, sourceStr.length))
            .split('\n')[0];
          const sig = (parent ? sourceStr.substring(parent.startIndex, parent.endIndex) : lineText).split('\n')[0];
          symbols.push({
            name,
            kind,
            language: languageName,
            file: filePath,
            signature: sig.length > 200 ? `${sig.slice(0, 197)}...` : sig,
            qualified_name: parentName ? `${parentName}.${name}` : name,
            start_line: _getLineNumber(node),
            end_line: _getEndLineNumber(node),
            start_byte: node.startIndex,
            end_byte: node.endIndex,
            docstring: _getDocstring(node),
            body_preview: '',
            parent_name: parentName,
          });
        }
      }
    } else if (node.type === 'export_default_statement') {
      for (const child of node.children) {
        if (child.type === 'identifier') {
          const name = child.text;
          const key = `${name}:export:${node.startIndex}`;
          if (!seen.has(key)) {
            seen.add(key);
            symbols.push({
              name,
              kind: 'export',
              language: languageName,
              file: filePath,
              signature: `export default ${name}`,
              qualified_name: name,
              start_line: _getLineNumber(node),
              end_line: _getEndLineNumber(node),
              start_byte: node.startIndex,
              end_byte: node.endIndex,
              docstring: '',
              body_preview: '',
              parent_name: '',
            });
          }
        }
      }
    }

    // Dynamic import() — call_expression with import callee node
    if (node.type === 'call_expression') {
      const callee = node.child(0);
      if (callee && callee.type === 'import') {
        // Walk arguments node to find the module path string
        const argsNode = node.childForFieldName('arguments');
        if (argsNode) {
          for (const ac of argsNode.children) {
            if (ac.type === 'string') {
              const modPath = ac.text.replace(/^["']|["']$/g, '');
              const key = `${modPath}:dynamic_import:${node.startIndex}`;
              if (!seen.has(key)) {
                seen.add(key);
                symbols.push({
                  name: modPath,
                  kind: 'dynamic_import',
                  language: languageName,
                  file: filePath,
                  signature: `import('${modPath}')`,
                  qualified_name: modPath,
                  start_line: _getLineNumber(node),
                  end_line: _getEndLineNumber(node),
                  start_byte: node.startIndex,
                  end_byte: node.endIndex,
                  docstring: '',
                  body_preview: '',
                  parent_name: '',
                });
              }
              break;
            }
          }
        }
      }
    }

    // Walk into all children, incrementing depth for scope-creating nodes
    const childDepth = _SCOPE_NODES.has(node.type) ? depth + 1 : depth;
    for (const child of node.children) {
      walk(child, childDepth);
    }
  }

  walk(root, 0);
  tree.delete();
  return symbols;
}
// ═══════════════════════════════════════════════════════════
// Python symbol extraction
// ═══════════════════════════════════════════════════════════

const _PY_SYMBOL_NODES = {
  function_definition: 'function',
  class_definition: 'class',
  decorator: 'decorator',
};

const _PY_SCOPE_NODES = new Set(['function_definition', 'class_definition', 'lambda']);

function _extractPythonSymbols(filePath, sourceStr, parser) {
  const tree = parser.parse(sourceStr);
  const root = tree.rootNode;
  const symbols = [];
  const seen = new Set();

  function walk(node, depth) {
    const kind = _PY_SYMBOL_NODES[node.type];
    if (kind) {
      let name = '';
      for (const child of node.children) {
        if (child.type === 'identifier') {
          name = child.text;
          break;
        }
      }
      if (name) {
        const key = `${name}:${kind}:${node.startIndex}`;
        if (!seen.has(key)) {
          seen.add(key);
          let parentName = '';
          if (kind === 'function') {
            let p = node.parent;
            while (p) {
              if (p.type === 'class_definition') {
                for (const c of p.children) {
                  if (c.type === 'identifier') {
                    parentName = c.text;
                    break;
                  }
                }
                break;
              }
              p = p.parent;
            }
          }
          symbols.push({
            name,
            kind,
            language: 'python',
            file: filePath,
            signature: sourceStr
              .substring(node.startIndex, Math.min(node.startIndex + 200, node.endIndex))
              .split('\n')[0],
            qualified_name: parentName ? `${parentName}.${name}` : name,
            start_line: node.startPosition.row + 1,
            end_line: node.endPosition.row + 1,
            start_byte: node.startIndex,
            end_byte: node.endIndex,
            docstring: '',
            body_preview: '',
            parent_name: parentName,
          });
        }
      }
    }
    // Walk decorator children for decorated functions
    if (node.type === 'decorator') {
      // Decorators are captured as separate symbols
      const name = node.text.replace(/^@/, '').split('(')[0];
      if (name && !seen.has(`@${name}:decorator:${node.startIndex}`)) {
        seen.add(`@${name}:decorator:${node.startIndex}`);
      }
    }

    const childDepth = _PY_SCOPE_NODES.has(node.type) ? depth + 1 : depth;
    for (const child of node.children) {
      walk(child, childDepth);
    }
  }

  walk(root, 0);
  tree.delete();
  return symbols;
}

// ═══════════════════════════════════════════════════════════
// Go symbol extraction
// ═══════════════════════════════════════════════════════════

const _GO_SYMBOL_NODES = {
  function_declaration: 'function',
  method_declaration: 'function',
  type_declaration: 'type',
};

function _extractGoSymbols(filePath, sourceStr, parser) {
  const tree = parser.parse(sourceStr);
  const root = tree.rootNode;
  const symbols = [];
  const seen = new Set();

  function walk(node, depth) {
    // Function_declaration: func name(...)
    if (node.type === 'function_declaration') {
      let name = '';
      for (const child of node.children) {
        if (child.type === 'identifier') {
          name = child.text;
          break;
        }
      }
      if (name) {
        const key = `${name}:function:${node.startIndex}`;
        if (!seen.has(key)) {
          seen.add(key);
          symbols.push({
            name,
            kind: 'function',
            language: 'go',
            file: filePath,
            signature: sourceStr
              .substring(node.startIndex, Math.min(node.startIndex + 200, node.endIndex))
              .split('\n')[0],
            qualified_name: name,
            start_line: node.startPosition.row + 1,
            end_line: node.endPosition.row + 1,
            start_byte: node.startIndex,
            end_byte: node.endIndex,
            docstring: '',
            body_preview: '',
            parent_name: '',
          });
        }
      }
    }
    // Method_declaration: func (r Receiver) name(...)
    else if (node.type === 'method_declaration') {
      let name = '';
      let receiver = '';
      for (const child of node.children) {
        // Name comes after receiver, as field_identifier
        if (child.type === 'field_identifier') {
          name = child.text;
        }
        // Receiver is in the first parameter_list
        if (child.type === 'parameter_list' && child.text.startsWith('(') && !receiver) {
          // Walk into parameter_declaration to find the type
          for (const pc of child.children) {
            if (pc.type === 'parameter_declaration') {
              for (const pcc of pc.children) {
                if (pcc.type === 'pointer_type') {
                  // Extract type from inside *Type
                  for (const pccc of pcc.children) {
                    if (pccc.type === 'type_identifier') {
                      receiver = pccc.text;
                    }
                  }
                } else if (pcc.type === 'type_identifier' && !receiver) {
                  receiver = pcc.text;
                }
              }
            }
          }
        }
      }
      if (name) {
        const key = `${receiver ? `${receiver}.` : ''}${name}:function:${node.startIndex}`;
        if (!seen.has(key)) {
          seen.add(key);
          symbols.push({
            name,
            kind: 'function',
            language: 'go',
            file: filePath,
            signature: sourceStr
              .substring(node.startIndex, Math.min(node.startIndex + 200, node.endIndex))
              .split('\n')[0],
            qualified_name: receiver ? `${receiver}.${name}` : name,
            start_line: node.startPosition.row + 1,
            end_line: node.endPosition.row + 1,
            start_byte: node.startIndex,
            end_byte: node.endIndex,
            docstring: '',
            body_preview: '',
            parent_name: receiver,
          });
        }
      }
    }
    // Type_declaration: type Name struct/interface
    else if (node.type === 'type_declaration') {
      for (const child of node.children) {
        if (child.type === 'type_identifier') {
          const name = child.text;
          const key = `${name}:type:${node.startIndex}`;
          if (!seen.has(key)) {
            seen.add(key);
            symbols.push({
              name,
              kind: 'type',
              language: 'go',
              file: filePath,
              signature: sourceStr
                .substring(node.startIndex, Math.min(node.startIndex + 200, node.endIndex))
                .split('\n')[0],
              qualified_name: name,
              start_line: node.startPosition.row + 1,
              end_line: node.endPosition.row + 1,
              start_byte: node.startIndex,
              end_byte: node.endIndex,
              docstring: '',
              body_preview: '',
              parent_name: '',
            });
          }
          break;
        }
      }
    }

    for (const child of node.children) {
      walk(child, depth);
    }
  }

  walk(root, 0);
  tree.delete();
  return symbols;
}

// ═══════════════════════════════════════════════════════════
// Rust symbol extraction
// ═══════════════════════════════════════════════════════════

const _RUST_SYMBOL_NODES = {
  function_item: 'function',
  struct_item: 'class',
  enum_item: 'enum',
  trait_item: 'interface',
  impl_item: 'class',
  type_item: 'type',
  constant_item: 'constant',
  static_item: 'constant',
};

const _RUST_SCOPE_NODES = new Set(['function_item', 'impl_item', 'closure_expression', 'block']);

function _extractRustSymbols(filePath, sourceStr, parser) {
  const tree = parser.parse(sourceStr);
  const root = tree.rootNode;
  const symbols = [];
  const seen = new Set();

  function walk(node, depth) {
    const kind = _RUST_SYMBOL_NODES[node.type];
    if (kind && depth === 0) {
      let name = '';
      for (const child of node.children) {
        if (child.type === 'identifier' || child.type === 'type_identifier') {
          name = child.text;
          break;
        }
      }
      // Impl blocks have a trait name as type_identifier
      if (node.type === 'impl_item') {
        // Find the trait or type being implemented
        let implName = '';
        let implTarget = '';
        for (const child of node.children) {
          if (child.type === 'type_identifier' && !implName) {
            implName = child.text;
          } else if (child.type === 'type_identifier' && implName && !implTarget) {
            implTarget = child.text;
          }
        }
        if (implName) {
          name = implTarget ? `${implName} for ${implTarget}` : implName;
          const key = `impl ${name}:class:${node.startIndex}`;
          if (!seen.has(key)) {
            seen.add(key);
            symbols.push({
              name,
              kind: 'class',
              language: 'rust',
              file: filePath,
              signature: sourceStr
                .substring(node.startIndex, Math.min(node.startIndex + 200, node.endIndex))
                .split('\n')[0],
              qualified_name: name,
              start_line: node.startPosition.row + 1,
              end_line: node.endPosition.row + 1,
              start_byte: node.startIndex,
              end_byte: node.endIndex,
              docstring: '',
              body_preview: '',
              parent_name: '',
            });
          }
        }
        // Walk into impl_item to find methods at depth+1
        const childDepth = depth + 1;
        for (const child of node.children) {
          if (child.type === 'function_item' || child.type === 'function_signature_item') {
            let methodName = '';
            for (const mc of child.children) {
              if (mc.type === 'identifier') {
                methodName = mc.text;
                break;
              }
            }
            if (methodName) {
              const key = `${implName}.${methodName}:function:${child.startIndex}`;
              if (!seen.has(key)) {
                seen.add(key);
                symbols.push({
                  name: methodName,
                  kind: 'function',
                  language: 'rust',
                  file: filePath,
                  signature: sourceStr
                    .substring(child.startIndex, Math.min(child.startIndex + 200, child.endIndex))
                    .split('\n')[0],
                  qualified_name: implName ? `${implName}.${methodName}` : methodName,
                  start_line: child.startPosition.row + 1,
                  end_line: child.endPosition.row + 1,
                  start_byte: child.startIndex,
                  end_byte: child.endIndex,
                  docstring: '',
                  body_preview: '',
                  parent_name: implName,
                });
              }
            }
          }
        }
        // Don't walk deeper since we already handled methods
        return;
      }
      if (name && kind !== 'constant') {
        const key = `${name}:${kind}:${node.startIndex}`;
        if (!seen.has(key)) {
          seen.add(key);
          // Detect extends for struct
          let parentName = '';
          if (node.type === 'struct_item') {
            for (const child of node.children) {
              if (child.type === 'type_identifier' && child.text !== name) {
                parentName = child.text;
              }
            }
          }
          symbols.push({
            name,
            kind,
            language: 'rust',
            file: filePath,
            signature: sourceStr
              .substring(node.startIndex, Math.min(node.startIndex + 200, node.endIndex))
              .split('\n')[0],
            qualified_name: parentName ? `${parentName}::${name}` : name,
            start_line: node.startPosition.row + 1,
            end_line: node.endPosition.row + 1,
            start_byte: node.startIndex,
            end_byte: node.endIndex,
            docstring: '',
            body_preview: '',
            parent_name: parentName,
          });
        }
      }
    }
    const childDepth = _RUST_SCOPE_NODES.has(node.type) ? depth + 1 : depth;
    for (const child of node.children) {
      walk(child, childDepth);
    }
  }

  walk(root, 0);
  tree.delete();
  return symbols;
}

function _extractSqlSymbolsRegex(filePath, source) {
  const symbols = [];
  const seen = new Set();

  function add(name, kind, startLine, startByte, endByte, sig) {
    const key = `${name}:${kind}:${startLine}`;
    if (seen.has(key)) return;
    seen.add(key);
    const bodyLines = source
      .substring(startByte, endByte)
      .split('\n')
      .slice(1)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 5);
    symbols.push({
      name,
      kind,
      language: 'sql',
      file: filePath,
      signature: (sig || name).length > 200 ? `${(sig || name).slice(0, 197)}...` : sig || name,
      qualified_name: name,
      start_line: startLine,
      end_line: startLine,
      start_byte: startByte,
      end_byte: endByte,
      docstring: '',
      body_preview: bodyLines.join('\n'),
      parent_name: '',
    });
  }

  function getLine(idx) {
    return source.substring(0, idx).split('\n').length;
  }

  const patterns = [
    { re: /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`\[\]"']?\w+[`\[\]"']?(?:\.[`\[\]"']?\w+[`\[\]"']?)?)/gi, kind: 'table' },
    { re: /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?([`\[\]"']?\w+[`\[\]"']?(?:\.[`\[\]"']?\w+[`\[\]"']?)?)/gi, kind: 'view' },
    { re: /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([`\[\]"']?\w+[`\[\]"']?(?:\.[`\[\]"']?\w+[`\[\]"']?)?)/gi, kind: 'index' },
    { re: /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?FUNCTION\s+([`\[\]"']?\w+[`\[\]"']?(?:\.[`\[\]"']?\w+[`\[\]"']?)?)/gi, kind: 'function' },
    { re: /\bCREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+([`\[\]"']?\w+[`\[\]"']?)/gi, kind: 'trigger' },
    { re: /\bALTER\s+TABLE\s+([`\[\]"']?\w+[`\[\]"']?(?:\.[`\[\]"']?\w+[`\[\]"']?)?)/gi, kind: 'alter' },
    { re: /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([`\[\]"']?\w+[`\[\]"']?(?:\.[`\[\]"']?\w+[`\[\]"']?)?)/gi, kind: 'drop' },
    { re: /\bINSERT\s+INTO\s+([`\[\]"']?\w+[`\[\]"']?(?:\.[`\[\]"']?\w+[`\[\]"']?)?)/gi, kind: 'insert' },
    { re: /\bUPDATE\s+([`\[\]"']?\w+[`\[\]"']?(?:\.[`\[\]"']?\w+[`\[\]"']?)?)/gi, kind: 'update' },
    { re: /\bDELETE\s+FROM\s+([`\[\]"']?\w+[`\[\]"']?(?:\.[`\[\]"']?\w+[`\[\]"']?)?)/gi, kind: 'delete' },
    { re: /\bCREATE\s+PROCEDURE\s+([`\[\]"']?\w+[`\[\]"']?(?:\.[`\[\]"']?\w+[`\[\]"']?)?)/gi, kind: 'procedure' },
  ];

  for (const { re, kind } of patterns) {
    let match;
    re.lastIndex = 0;
    while ((match = re.exec(source)) !== null) {
      const rawName = match[1].replace(/[`\[\]"']/g, '');
      const line = getLine(match.index);
      const lineEnd = source.indexOf('\n', match.index);
      const endByte = lineEnd === -1 ? source.length : lineEnd;
      const sig = source.substring(match.index, endByte).trim();
      add(rawName, kind, line, match.index, endByte, sig);
    }
  }

  const selectRe = /\bSELECT\b/gi;
  let selMatch;
  while ((selMatch = selectRe.exec(source)) !== null) {
    const line = getLine(selMatch.index);
    const lineEnd = source.indexOf('\n', selMatch.index);
    const endByte = lineEnd === -1 ? source.length : lineEnd;
    const sig = source.substring(selMatch.index, endByte).trim();
    add(`SELECT:${line}`, 'select', line, selMatch.index, endByte, sig);
  }

  return symbols;
}

// SQL statement types mapped from tree-sitter AST node types
const SQL_STATEMENT_MAP = {
  select_statement: 'select',
  insert_statement: 'insert',
  update_statement: 'update',
  delete_statement: 'delete',
  create_table_statement: 'table',
  create_index_statement: 'index',
  create_view_statement: 'view',
  create_function_statement: 'function',
  create_trigger_statement: 'trigger',
  alter_table_statement: 'alter',
  drop_statement: 'drop',
  // Common alternate names across tree-sitter SQL grammars
  select: 'select',
  insert: 'insert',
  insert_into: 'insert',
  update: 'update',
  delete: 'delete',
  create_table: 'table',
  create_index: 'index',
  create_view: 'view',
};

function _extractSqlSymbols(filePath, sourceStr, parser) {
  const tree = parser.parse(sourceStr);
  const root = tree.rootNode;
  const symbols = [];

  function getSqlName(node) {
    for (const child of node.children) {
      if (child.type === 'object_reference' || child.type === 'identifier') {
        return child.text;
      }
    }
    return '';
  }

  function walk(node) {
    if (node.type in SQL_STATEMENT_MAP) {
      const kind = SQL_STATEMENT_MAP[node.type];
      let name = getSqlName(node);
      if (!name) {
        name = { select: 'SELECT', insert: 'INSERT', update: 'UPDATE', delete: 'DELETE' }[node.type] || 'UNKNOWN';
      }

      const fullText = node.text;
      let sig = fullText.split('\n')[0].trim();
      if (sig.length > 200) {
        sig = `${sig.slice(0, 197)}...`;
      }

      const bodyLines = fullText
        .split('\n')
        .slice(1)
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 5);
      const bodyPreview = bodyLines.join('\n');

      symbols.push({
        name,
        kind,
        language: 'sql',
        file: filePath,
        signature: sig,
        qualified_name: name,
        start_line: _getLineNumber(node),
        end_line: _getEndLineNumber(node),
        start_byte: node.startIndex,
        end_byte: node.endIndex,
        docstring: '',
        body_preview: bodyPreview,
        parent_name: '',
      });
    }
    for (const child of node.children) {
      walk(child);
    }
  }

  walk(root);
  tree.delete();
  return symbols;
}

// ── HTML regex-based extractor ──────────────────────────────

const _HTML_ID_RE = /\bid\s*=\s*["']([^"']+)["']/g;
const _HTML_CLASS_RE = /\bclass\s*=\s*["']([^"']+)["']/g;
const _HTML_SCRIPT_RE = /<script[^>]*>([\s\S]*?)<\/script\s*>/gi;
const _HTML_STYLE_RE = /<style[^>]*>([\s\S]*?)<\/style\s*>/gi;
const _HTML_CUSTOM_ELEMENT_RE = /<\/?([A-Z][A-Za-z0-9]*|([a-z]+-[a-z][a-z0-9-]*))/g;

const _STANDARD_HTML_TAGS = new Set([
  'div', 'span', 'p', 'a', 'img', 'input', 'button', 'form', 'table',
  'tr', 'td', 'th', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'head', 'body', 'html', 'title', 'meta', 'link', 'script', 'style',
  'header', 'footer', 'main', 'section', 'article', 'aside', 'nav',
  'pre', 'code', 'br', 'hr', 'label', 'select', 'option', 'textarea',
  'template', 'slot', 'iframe', 'canvas', 'video', 'audio', 'source',
  'noscript', 'details', 'summary', 'dialog', 'figure', 'figcaption',
]);

function _extractHtmlSymbols(filePath, source) {
  const symbols = [];
  const seen = new Set();

  function add(name, kind, startLine, signature) {
    const key = `${name}:${kind}:${startLine}`;
    if (seen.has(key)) return;
    seen.add(key);
    symbols.push({
      name,
      kind,
      language: 'html',
      file: filePath,
      qualified_name: name,
      signature: signature || '',
      start_line: startLine,
      end_line: startLine,
      start_byte: 0,
      end_byte: 0,
      docstring: '',
      body_preview: '',
      parent_name: '',
    });
  }

  function getLine(index) {
    return source.substring(0, index).split('\n').length;
  }

  // Extract id attributes
  for (const match of source.matchAll(_HTML_ID_RE)) {
    const name = match[1].trim();
    if (!name) continue;
    add(name, 'id', getLine(match.index), `id="${name}"`);
  }

  // Extract class attributes (split on whitespace, record each class)
  for (const match of source.matchAll(_HTML_CLASS_RE)) {
    const raw = match[1].trim();
    if (!raw) continue;
    const line = getLine(match.index);
    for (const cls of raw.split(/\s+/)) {
      if (cls) add(cls, 'css_class', line, `class="${cls}"`);
    }
  }

  // Extract custom element / component tags (PascalCase or kebab-case)
  for (const match of source.matchAll(_HTML_CUSTOM_ELEMENT_RE)) {
    const tagName = match[1];
    if (_STANDARD_HTML_TAGS.has(tagName.toLowerCase())) continue;
    add(tagName, 'component', getLine(match.index), `<${tagName}>`);
  }

  // Extract inline <script> blocks
  for (const match of source.matchAll(_HTML_SCRIPT_RE)) {
    const body = match[1].trim();
    if (!body) continue;
    const startLine = getLine(match.index);
    const preview = body.split('\n').slice(0, 3).join('\n');
    const sig = preview.length > 200 ? `${preview.slice(0, 197)}...` : preview;
    add(`[inline-script:${startLine}]`, 'script', startLine, sig);
  }

  // Extract inline <style> blocks
  for (const match of source.matchAll(_HTML_STYLE_RE)) {
    const body = match[1].trim();
    if (!body) continue;
    const startLine = getLine(match.index);
    const preview = body.split('\n').slice(0, 3).join('\n');
    const sig = preview.length > 200 ? `${preview.slice(0, 197)}...` : preview;
    add(`[inline-style:${startLine}]`, 'style', startLine, sig);
  }

  return symbols;
}

// ── CSS / SCSS regex-based extractor ───────────────────────

const _CSS_CUSTOM_PROP_RE = /^\s*(--[\w-]+)\s*:/gm;
const _CSS_KEYFRAMES_RE = /@keyframes\s+([\w-]+)/g;
const _CSS_MEDIA_RE = /@media\s+([^{]+)/g;
const _CSS_SELECTOR_RE = /^([.#]?[\w][\w-]*(?:\s*,\s*[.#]?[\w][\w-]*)*)\s*\{/gm;
const _SCSS_VAR_RE = /^\s*\$([\w-]+)\s*:/gm;
const _SCSS_MIXIN_RE = /@mixin\s+([\w-]+)/g;
const _SCSS_INCLUDE_RE = /@include\s+([\w-]+)/g;
const _SCSS_EXTEND_RE = /@extend\s+([.#][\w-]+)/g;
const _SCSS_USE_RE = /@(?:use|forward)\s+['"]([^'"]+)['"]/g;

function _extractCssSymbols(filePath, source) {
  const symbols = [];
  const seen = new Set();
  const isScss = filePath.endsWith('.scss');

  function add(name, kind, startLine, signature) {
    const key = `${name}:${kind}:${startLine}`;
    if (seen.has(key)) return;
    seen.add(key);
    symbols.push({
      name,
      kind,
      language: isScss ? 'scss' : 'css',
      file: filePath,
      qualified_name: name,
      signature: signature || '',
      start_line: startLine,
      end_line: startLine,
      start_byte: 0,
      end_byte: 0,
      docstring: '',
      body_preview: '',
      parent_name: '',
    });
  }

  function getLine(index) {
    return source.substring(0, index).split('\n').length;
  }

  // CSS custom properties (--my-var)
  for (const match of source.matchAll(_CSS_CUSTOM_PROP_RE)) {
    add(match[1], 'custom_property', getLine(match.index), match[0].trim());
  }

  // @keyframes
  for (const match of source.matchAll(_CSS_KEYFRAMES_RE)) {
    add(match[1], 'keyframes', getLine(match.index), match[0].trim());
  }

  // @media queries
  for (const match of source.matchAll(_CSS_MEDIA_RE)) {
    const condition = match[1].trim();
    add(`@media ${condition}`, 'media_query', getLine(match.index), match[0].trim());
  }

  // CSS selectors (top-level — lines starting with selector before {)
  for (const match of source.matchAll(_CSS_SELECTOR_RE)) {
    const selector = match[1].trim();
    // Skip @-rules, comments, properties, and empty selectors
    if (!selector || selector.startsWith('@') || selector.startsWith('//') || selector.startsWith('/*')) continue;
    // Skip property-like patterns (word: value;) that aren't class/id selectors
    if (/^\s*[\w-]+\s*:/.test(selector) && !selector.startsWith('.') && !selector.startsWith('#')) continue;
    add(selector, 'selector', getLine(match.index), selector);
  }

  // SCSS-specific patterns
  if (isScss) {
    // $variables
    for (const match of source.matchAll(_SCSS_VAR_RE)) {
      add(`$${match[1]}`, 'scss_variable', getLine(match.index), match[0].trim());
    }

    // @mixin definitions
    for (const match of source.matchAll(_SCSS_MIXIN_RE)) {
      add(match[1], 'mixin', getLine(match.index), match[0].trim());
    }

    // @include references
    for (const match of source.matchAll(_SCSS_INCLUDE_RE)) {
      add(match[1], 'include', getLine(match.index), match[0].trim());
    }

    // @extend references
    for (const match of source.matchAll(_SCSS_EXTEND_RE)) {
      add(match[1], 'extend', getLine(match.index), match[0].trim());
    }

    // @use / @forward
    for (const match of source.matchAll(_SCSS_USE_RE)) {
      add(match[1], 'import', getLine(match.index), match[0].trim());
    }
  }

  return symbols;
}

// ── Config / shell regex-based extractors ──────────────────

function _makeRegexSymbol(filePath, source, language) {
  const symbols = [];
  const seen = new Set();
  function add(name, kind, index, signature) {
    const startLine = source.substring(0, index).split('\n').length;
    const key = `${name}:${kind}:${startLine}`;
    if (seen.has(key)) {return;}
    seen.add(key);
    symbols.push({
      name,
      kind,
      language,
      file: filePath,
      qualified_name: name,
      signature: signature || '',
      start_line: startLine,
      end_line: startLine,
      start_byte: index,
      end_byte: index + String(signature || name).length,
      docstring: '',
      body_preview: '',
      parent_name: '',
    });
  }
  return { symbols, add };
}

function _extractBashSymbols(filePath, source) {
  const { symbols, add } = _makeRegexSymbol(filePath, source, 'bash');
  const functionRe = /^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*(?:\(\))?\s*\{/gm;
  const varRe = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=/gm;
  for (const match of source.matchAll(functionRe)) {
    add(match[1], 'function', match.index, match[0].trim());
  }
  for (const match of source.matchAll(varRe)) {
    add(match[1], 'env_var', match.index, match[0].trim());
  }
  return symbols;
}

function _extractJsonSymbols(filePath, source) {
  const { symbols, add } = _makeRegexSymbol(filePath, source, 'json');
  const keyRe = /"([^"\n]+)"\s*:/g;
  for (const match of source.matchAll(keyRe)) {
    const key = match[1];
    if (key.length <= 80) {
      add(key, 'config_key', match.index, match[0].trim());
    }
  }
  return symbols;
}

function _extractYamlSymbols(filePath, source) {
  const { symbols, add } = _makeRegexSymbol(filePath, source, 'yaml');
  const keyRe = /^(\s*)([A-Za-z0-9_.-]+)\s*:/gm;
  for (const match of source.matchAll(keyRe)) {
    const depth = Math.floor((match[1] || '').length / 2);
    add(match[2], depth === 0 ? 'config_section' : 'config_key', match.index, match[0].trim());
  }
  return symbols;
}

/**
 * Extract call expressions from a file using AST parsing.
 * Returns array of { callee, line, is_method, receiver, full_path }.
 * - receiver: the object part of a member call (e.g., 'this', 'super', 'obj', or null for direct calls)
 * - full_path: the complete callee text (e.g., 'this.method', 'obj.method', 'foo')
 */
function _walkCallees(root, _SKIP) {
  const callees = [];
  const seen = new Set();

  function walk(node) {
    if (node.type === 'call_expression') {
      const calleeNode = node.child(0);
      if (calleeNode) {
        if (calleeNode.type === 'identifier' || calleeNode.type === 'import') {
          const name = calleeNode.text;
          if (!_SKIP.has(name)) {
            const key = `${name}:${node.startPosition.row + 1}`;
            if (!seen.has(key)) {
              seen.add(key);
              const entry = {
                callee: name,
                line: node.startPosition.row + 1,
                is_method: false,
                receiver: null,
                full_path: name,
              };
              // Capture require('module') and import('module') paths
              if (name === 'require' || name === 'import') {
                const argsNode = node.childForFieldName('arguments');
                if (argsNode) {
                  for (const ac of argsNode.children) {
                    if (ac.type === 'string') {
                      entry.module_path = ac.text.replace(/^["']|["']$/g, '');
                      break;
                    }
                  }
                }
              }
              // Mark eval()/Function() as dynamic
              if (name === 'eval' || name === 'Function') {
                entry.is_dynamic = true;
              }
              callees.push(entry);
            }
          }
        } else if (calleeNode.type === 'member_expression') {
          const propNode = calleeNode.child(calleeNode.childCount - 1);
          const objNode = calleeNode.child(0);
          if (propNode && (propNode.type === 'property_identifier' || propNode.type === 'identifier')) {
            const name = propNode.text;
            if (!_SKIP.has(name)) {
              const key = `${name}:${node.startPosition.row + 1}`;
              if (!seen.has(key)) {
                seen.add(key);
                let receiver = null;
                if (objNode) {
                  receiver = objNode.text;
                }
                const full_path = receiver ? `${receiver}.${name}` : name;
                const entry = {
                  callee: name,
                  line: node.startPosition.row + 1,
                  is_method: true,
                  receiver,
                  full_path,
                };
                // Capture require('module') path
                if (name === 'require') {
                  const argsNode = node.childForFieldName('arguments');
                  if (argsNode) {
                    for (const ac of argsNode.children) {
                      if (ac.type === 'string') {
                        entry.module_path = ac.text.replace(/^["']|["']$/g, '');
                        break;
                      }
                    }
                  }
                }
                if (name === 'eval' || name === 'Function') {
                  entry.is_dynamic = true;
                }
                callees.push(entry);
              }
            }
          }
        }
      }
    }

    if (node.type === 'new_expression') {
      for (const child of node.children) {
        if (child.type === 'identifier' || child.type === 'type_identifier') {
          const name = child.text;
          const key = `new_${name}:${node.startPosition.row + 1}`;
          if (!seen.has(key)) {
            seen.add(key);
            callees.push({
              callee: name,
              line: node.startPosition.row + 1,
              is_method: false,
              receiver: null,
              full_path: `new ${name}`,
            });
          }
          break;
        }
      }
    }

    // Dynamic import() — import('./path')
    if (node.type === 'import_expression') {
      for (const child of node.children) {
        if (child.type === 'string') {
          const modPath = child.text.replace(/^["']|["']$/g, '');
          const key = `import:${modPath}:${node.startPosition.row + 1}`;
          if (!seen.has(key)) {
            seen.add(key);
            callees.push({
              callee: 'import',
              line: node.startPosition.row + 1,
              is_method: false,
              receiver: null,
              full_path: 'import',
              module_path: modPath,
            });
          }
          break;
        }
      }
    }

    // Tagged template literals — styled.button`...`, html`...`
    if (node.type === 'tagged_template_expression') {
      const tag = node.child(0);
      if (tag) {
        let name = '';
        if (tag.type === 'identifier') {
          name = tag.text;
        } else if (tag.type === 'member_expression') {
          const parts = [];
          for (const c of tag.children) {
            if (c.type === 'identifier' || c.type === 'property_identifier') {
              parts.push(c.text);
            }
          }
          name = parts.join('.');
        }
        if (name) {
          const key = `tagged:${name}:${node.startPosition.row + 1}`;
          if (!seen.has(key)) {
            seen.add(key);
            callees.push({
              callee: name,
              line: node.startPosition.row + 1,
              is_method: false,
              receiver: null,
              full_path: name,
              is_tagged_template: true,
            });
          }
        }
      }
    }

    for (const child of node.children) {
      walk(child);
    }
  }

  walk(root);
  return callees;
}

function extractCalleesFromContent(filePath, content) {
  if (!_ready) {
    return [];
  }
  const ext = path.extname(filePath).toLowerCase();
  const langConfig = LANGUAGE_MAP[ext];
  if (!langConfig || langConfig.languageName === 'sql') {
    return [];
  }

  const parser = _parsers[langConfig.parserKey];
  if (!parser) {
    return [];
  }

  const tree = parser.parse(content);
  const result = _walkCallees(tree.rootNode, SKIP_CALLEE_NAMES);
  tree.delete();
  return result;
}

function extractCallees(filePath) {
  if (!_ready) {
    return [];
  }
  const ext = path.extname(filePath).toLowerCase();
  const langConfig = LANGUAGE_MAP[ext];
  if (!langConfig || langConfig.languageName === 'sql') {
    return [];
  }

  const parser = _parsers[langConfig.parserKey];
  if (!parser) {
    return [];
  }

  let source;
  try {
    source = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    console.error(`[parse-code] Failed to read ${filePath}: ${e.message}`);
    return [];
  }

  const tree = parser.parse(source);
  const result = _walkCallees(tree.rootNode, SKIP_CALLEE_NAMES);
  tree.delete();
  return result;
}

module.exports = { init, isReady, parseFile, parseContent, extractCallees, extractCalleesFromContent, info };
