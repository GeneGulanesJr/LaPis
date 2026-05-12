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
 * Supported: .js/.mjs/.cjs, .ts/.mts/.cts, .tsx, .sql
 */

const path = require('path');
const fs = require('fs');
const _wtsPath = path.resolve(__dirname, 'node_modules', 'web-tree-sitter', 'web-tree-sitter.cjs');

const GRAMMAR_DIR = path.resolve(__dirname, 'grammars');

// Language map: file extension → { grammarFile, languageName, parserKey }
const LANGUAGE_MAP = {
  '.js': { grammarFile: 'javascript.wasm', languageName: 'javascript', parserKey: 'javascript' },
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
  // SQL grammar not bundled — .sql files use regex parsing when sql.wasm is available
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
  if (_ready) {return;}
  if (_initPromise) {return _initPromise;}

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
function parseFile(filePath) {
  if (!_ready) {return [];}

  const ext = path.extname(filePath).toLowerCase();
  const langConfig = LANGUAGE_MAP[ext];
  if (!langConfig) {return [];}

  const parser = _parsers[langConfig.parserKey];
  if (!parser) {return [];}

  let source;
  try {
    source = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    console.error(`[parse-code] Failed to read ${filePath}: ${e.message}`);
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
  return firstLine.length > 200 ? `${firstLine.slice(0, 197)  }...` : firstLine;
}

function _getDocstring(node) {
  if (!node.parent) {return '';}
  // Find index manually — WASM node objects don't support indexOf reference equality
  const parent = node.parent;
  let idx = -1;
  for (let i = 0; i < parent.childCount; i++) {
    if (parent.child(i).id === node.id) {
      idx = i;
      break;
    }
  }
  if (idx <= 0) {return '';}
  const prev = parent.child(idx - 1);
  if (prev.type === 'comment') {
    let text = prev.text;
    if (text.startsWith('/**')) {text = text.slice(3);}
    else if (text.startsWith('/*')) {text = text.slice(2);}
    if (text.endsWith('*/')) {text = text.slice(0, -2);}
    const lines = text.split('\n');
    const cleaned = [];
    for (let line of lines) {
      line = line.trim();
      if (line.startsWith('* ')) {line = line.slice(2);}
      else if (line === '*') {line = '';}
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
      if (bodyLines.length >= maxLines) {break;}
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
    if (current.type === 'class_declaration') {
      for (const child of current.children) {
        if (child.type === 'identifier' || child.type === 'type_identifier') {return child.text;}
      }
    }
    if (current.type === 'object') {
      const varDecl = current.parent;
      if (varDecl && varDecl.type === 'variable_declarator') {
        for (const child of varDecl.children) {
          if (child.type === 'identifier') {return child.text;}
        }
      }
    }
    if (current.type === 'assignment_expression') {
      const left = current.child(0);
      if (left && (left.type === 'identifier' || left.type === 'member_expression')) {return left.text;}
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
        if (hc.type === 'type_identifier' || hc.type === 'identifier') {return hc.text;}
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
            if (!parentName) {parentName = _getContextName(node);}
          } else if (kind === 'class') {
            const extendsClass = _getExtendsClass(node);
            if (extendsClass) {parentName = extendsClass;}
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
    } else if (_VARIABLE_FUNCTION_NODES.has(node.type) && depth === 0) {
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
            const parentName = _getParentClassName(node);
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
    } else if (node.type === 'variable_declarator' && depth === 0) {
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
          const parentName = _getParentClassName(node);
          const lineText = sourceStr
            .substring(node.startIndex, Math.min(node.startIndex + 200, sourceStr.length))
            .split('\n')[0];
          const sig = (parent ? sourceStr.substring(parent.startIndex, parent.endIndex) : lineText).split('\n')[0];
          symbols.push({
            name,
            kind,
            language: languageName,
            file: filePath,
            signature: sig.length > 200 ? `${sig.slice(0, 197)  }...` : sig,
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
        if (child.type === 'field_identifier') {name = child.text;}
        // Receiver is in the first parameter_list
        if (child.type === 'parameter_list' && child.text.startsWith('(') && !receiver) {
          // Walk into parameter_declaration to find the type
          for (const pc of child.children) {
            if (pc.type === 'parameter_declaration') {
              for (const pcc of pc.children) {
                if (pcc.type === 'pointer_type') {
                  // Extract type from inside *Type
                  for (const pccc of pcc.children) {
                    if (pccc.type === 'type_identifier') {receiver = pccc.text;}
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
        const key = `${receiver ? `${receiver  }.` : ''}${name}:function:${node.startIndex}`;
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
          if (child.type === 'type_identifier' && !implName) {implName = child.text;}
          else if (child.type === 'type_identifier' && implName && !implTarget) {implTarget = child.text;}
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
              if (child.type === 'type_identifier' && child.text !== name) {parentName = child.text;}
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
      if (sig.length > 200) {sig = sig.slice(0, 197) + '...';}

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

/**
 * Extract call expressions from a file using AST parsing.
 * Returns array of { callee, line, is_method, receiver, full_path }.
 * - receiver: the object part of a member call (e.g., 'this', 'super', 'obj', or null for direct calls)
 * - full_path: the complete callee text (e.g., 'this.method', 'obj.method', 'foo')
 */
function extractCallees(filePath) {
  if (!_ready) {return [];}
  const ext = path.extname(filePath).toLowerCase();
  const langConfig = LANGUAGE_MAP[ext];
  if (!langConfig || langConfig.languageName === 'sql') {return [];}

  const _SKIP = new Set([
    'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'try', 'catch', 'finally',
    'class', 'function', 'return', 'throw', 'new', 'typeof', 'instanceof', 'void',
    'delete', 'in', 'of', 'yield', 'await', 'async', 'export', 'import', 'from',
    'const', 'let', 'var', 'true', 'false', 'null', 'undefined', 'this', 'super',
    'constructor', 'extends', 'static', 'get', 'set',
  ]);

  const parser = _parsers[langConfig.parserKey];
  if (!parser) {return [];}

  let source;
  try {
    source = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    console.error(`[parse-code] Failed to read ${filePath}: ${e.message}`);
    return [];
  }

  const tree = parser.parse(source);
  const root = tree.rootNode;
  const callees = [];
  const seen = new Set();

  function walk(node) {
    if (node.type === 'call_expression') {
      const calleeNode = node.child(0);
      if (calleeNode) {
        if (calleeNode.type === 'identifier') {
          const name = calleeNode.text;
          if (!_SKIP.has(name)) {
            const key = `${name}:${node.startPosition.row + 1}`;
            if (!seen.has(key)) {
              seen.add(key);
              callees.push({
                callee: name,
                line: node.startPosition.row + 1,
                is_method: false,
                receiver: null,
                full_path: name,
              });
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
                callees.push({
                  callee: name,
                  line: node.startPosition.row + 1,
                  is_method: true,
                  receiver: receiver,
                  full_path: full_path,
                });
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

    for (const child of node.children) {
      walk(child);
    }
  }

  walk(root);
  tree.delete();
  return callees;
}

module.exports = { init, isReady, parseFile, extractCallees, info };
