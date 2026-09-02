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
 * Supported (see LANGUAGE_MAP): JS/TS family (.js/.jsx/.mjs/.cjs, .ts/.mts/.cts,
 * .tsx), Python (.py/.pyw), Go (.go), Rust (.rs), HTML (.html) and SQL (.sql)
 * via web-tree-sitter WASM grammars; bash (.sh/.bash), JSON/JSONC, YAML (.yml),
 * and CSS/SCSS via lightweight regex extractors.
 */

const path = require('path'), fs = require('fs'), { SKIP_CALLEE_NAMES } = require('./utils');



// Resolve web-tree-sitter from the nearest node_modules (handles npm hoisting).
// Falls back to the legacy __dirname-relative path for backward compatibility.
let _wtsPath, _ready = false,
  _initPromise = null,
  _ParserClass = null,
  _LanguageClass = null;
try {
  _wtsPath = require.resolve('web-tree-sitter/web-tree-sitter.cjs', { paths: [__dirname] });
} catch {
  _wtsPath = path.resolve(__dirname, 'node_modules', 'web-tree-sitter', 'web-tree-sitter.cjs');
}

{
const GRAMMAR_DIR = path.resolve(__dirname, 'grammars'),
  // Language map: file extension → { grammarFile, languageName, parserKey }
  LANGUAGE_MAP = {
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
    '.html': { grammarFile: 'tree-sitter-html.wasm', languageName: 'html', parserKey: 'html' },
    '.css': { grammarFile: null, languageName: 'css', extractor: 'regex' },
    '.scss': { grammarFile: null, languageName: 'scss', extractor: 'regex' },
    '.sql': { grammarFile: 'sql.wasm', languageName: 'sql', parserKey: 'sql', extractor: 'sql' },
  }, _parsers = {}, // ParserKey → Parser instance
  _languages = {};

// ── Module state ──

 // ParserKey → Language object

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
      {
const grammarEntries = Object.entries(LANGUAGE_MAP).map(([, config]) => [config.parserKey, config.grammarFile]),
        // Deduplicate by parserKey
        uniqueEntries = [...new Map(grammarEntries).entries()];

      for (const [key, wasmFile] of uniqueEntries) {
        // oxlint-disable-next-line no-continue
        if (!wasmFile || !key) {
          continue;
        } // Skip regex-based extractors (no WASM grammar)
        const wasmPath = path.join(GRAMMAR_DIR, wasmFile);
        if (!fs.existsSync(wasmPath)) {
          // Skip silently — grammar not bundled
          // oxlint-disable-next-line no-continue
          continue;
        }
        try {
          // oxlint-disable-next-line no-await-in-loop
          const lang = await _LanguageClass.load(wasmPath),
          parser = (() => {

            _languages[key] = lang;
            
  return (new _ParserClass());
})();parser.setLanguage(lang);
          _parsers[key] = parser;
        } catch (e) {
          console.error(`[parse-code] Failed to load grammar ${wasmFile}: ${e.message}`);
        }
      }

      _ready = Object.keys(_parsers).length > 0;
      if (!_ready) {
        console.error('[parse-code] No grammars loaded. Code indexing disabled.');
      }
    }
} catch (e) {
      console.error(`[parse-code] Init failed: ${e.message}`);
      _ready = false;
    }
  })();

  return _initPromise;
}



/**
 * Return info about loaded grammars (for debugging).
 */


/**
 * Dispatch raw source to the language-specific extractor.
 * @param {string} filePath used to tag symbols and select the language
 * @param {string} source file contents
 * @param {object|null} parser loaded tree-sitter parser (null for regex extractors)
 * @param {object} langConfig { extractor, languageName, parserKey }
 * @returns {Array<object>} extracted symbols, or `[]` for an unsupported regex language.
 */




/**
 * Parse a source string into symbol objects. Synchronous; call init() first.
 * @param {string} filePath path used to select the language and tag symbols
 * @param {string} content source text
 * @returns {Array<object>} symbols. When not initialized, the extension is
 *                          unsupported, or no WASM grammar is loaded, returns a
 *                          single-element array with kind 'diagnostic' describing
 *                          the reason (not `[]`).
 */


/**
 * Read and parse a single file. Synchronous; call init() first.
 * @param {string} filePath absolute or repo-relative path
 * @returns {Array<object>} symbols (or a 'diagnostic' array when not initialized
 *                          or unsupported). Returns `[]` only when the file
 *                          cannot be read; otherwise delegates to parseContent().
 */










// ═══════════════════════════════════════════════════════════
// JS/TS symbol extraction
// ═══════════════════════════════════════════════════════════

{
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
  },
  _VARIABLE_FUNCTION_NODES = new Set(['arrow_function', 'function_expression']),
  // V5.1: const/let/var declarations that should be extracted as symbols
  _CONST_PATTERN = /^const\s+([A-Z_][A-Z0-9_]*)\s*=/,
  _NAMED_EXPORT_PATTERN = /^export\s+(?:default\s+)?/;















// V5.3: Find containing context name for inner functions/methods


// V5.3: Extract class extends heritage


// V5.3: Scope-creating node types
{
const _SCOPE_NODES = new Set([
  'function_declaration',
  'generator_function_declaration',
  'method_definition',
  'arrow_function',
  'function_expression',
]);


// ═══════════════════════════════════════════════════════════
// Python symbol extraction
// ═══════════════════════════════════════════════════════════

{
const _PY_SYMBOL_NODES = {
    function_definition: 'function',
    class_definition: 'class',
    decorator: 'decorator',
  },
  _PY_SCOPE_NODES = new Set(['function_definition', 'class_definition', 'lambda']), _GO_SYMBOL_NODES = {
  function_declaration: 'function',
  method_declaration: 'function',
  type_declaration: 'type',
};



// ═══════════════════════════════════════════════════════════
// Go symbol extraction
// ═══════════════════════════════════════════════════════════





// ═══════════════════════════════════════════════════════════
// Rust symbol extraction
// ═══════════════════════════════════════════════════════════

{
const _RUST_SYMBOL_NODES = {
    function_item: 'function',
    struct_item: 'class',
    enum_item: 'enum',
    trait_item: 'interface',
    impl_item: 'class',
    type_item: 'type',
    constant_item: 'constant',
    static_item: 'constant',
    mod_item: 'module',
    macro_definition: 'function',
    enum_variant: 'constant',
  },
  _RUST_SCOPE_NODES = new Set(['function_item', 'impl_item', 'closure_expression', 'block']), SQL_STATEMENT_MAP = {
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





// SQL statement types mapped from tree-sitter AST node types




// ── HTML AST-based extractor ──────────────────────────────

{
const _STANDARD_HTML_TAGS = new Set([
    'div',
    'span',
    'p',
    'a',
    'img',
    'input',
    'button',
    'form',
    'table',
    'tr',
    'td',
    'th',
    'ul',
    'ol',
    'li',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'head',
    'body',
    'html',
    'title',
    'meta',
    'link',
    'script',
    'style',
    'header',
    'footer',
    'main',
    'section',
    'article',
    'aside',
    'nav',
    'pre',
    'code',
    'br',
    'hr',
    'label',
    'select',
    'option',
    'textarea',
    'template',
    'slot',
    'iframe',
    'canvas',
    'video',
    'audio',
    'source',
    'noscript',
    'details',
    'summary',
    'dialog',
    'figure',
    'figcaption',
  ]),
  _SEMANTIC_ELEMENTS = new Set([
    'header',
    'footer',
    'main',
    'section',
    'article',
    'aside',
    'nav',
    'figure',
    'figcaption',
    'details',
    'summary',
    'dialog',
    'mark',
    'time',
  ]),
  _HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']),
  _FORM_TAGS = new Set(['input', 'select', 'textarea', 'button', 'form']),
  _RESOURCE_ATTRS = {
    a: ['href'],
    link: ['href'],
    script: ['src'],
    img: ['src'],
    source: ['src'],
    iframe: ['src'],
    video: ['src', 'poster'],
    audio: ['src'],
  }, _CSS_CUSTOM_PROP_RE = /^\s*(--[\w-]+)\s*:/gm,
  _CSS_KEYFRAMES_RE = /@keyframes\s+([\w-]+)/g,
  _CSS_MEDIA_RE = /@media\s+([^{]+)/g,
  _CSS_SELECTOR_RE = /^([.#]?[\w][\w-]*(?:\s*,\s*[.#]?[\w][\w-]*)*)\s*\{/gm,
  _SCSS_VAR_RE = /^\s*\$([\w-]+)\s*:/gm,
  _SCSS_MIXIN_RE = /@mixin\s+([\w-]+)/g,
  _SCSS_INCLUDE_RE = /@include\s+([\w-]+)/g,
  _SCSS_EXTEND_RE = /@extend\s+([.#][\w-]+)/g,
  _SCSS_USE_RE = /@(?:use|forward)\s+['"]([^'"]+)['"]/g;

function _extractHtmlSymbolsAst(filePath, source, parser) {
  const tree = parser.parse(source),
    root = tree.rootNode,
    symbols = [],
    seen = new Set();

  function add(name, kind, startLine, endLine, startByte, endByte, sig, parentName, docstr) {
    const key = `${name}:${kind}:${startLine}:${startByte}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    symbols.push({
      name,
      kind,
      language: 'html',
      file: filePath,
      qualified_name: parentName ? `${parentName} > ${name}` : name,
      signature: sig || '',
      start_line: startLine,
      end_line: endLine,
      start_byte: startByte,
      end_byte: endByte,
      docstring: docstr || '',
      body_preview: '',
      parent_name: parentName || '',
    });
  }

  function getTagName(startTagNode) {
    for (const ch of startTagNode.children) {
      if (ch.type === 'tag_name') {
        return ch.text;
      }
    }
    return '';
  }

  function getAttrs(tagNode) {
    const attrs = [];
    for (const ch of tagNode.children) {
      if (ch.type === 'attribute') {
        let name = '',
          value = '';
        for (const ac of ch.children) {
          if (ac.type === 'attribute_name') {
            name = ac.text;
          }
          if (ac.type === 'quoted_attribute_value') {
            for (const vc of ac.children) {
              if (vc.type === 'attribute_value') {
                value = vc.text;
              }
            }
          }
        }
        attrs.push({ name, value, node: ch });
      }
    }
    return attrs;
  }

  function getTextContent(elementNode) {
    const parts = [];
    function collect(n) {
      if (n.type === 'text') {
        parts.push(n.text.trim());
      }
      for (const c of n.children) {
        collect(c);
      }
    }
    collect(elementNode);
    return parts.filter(Boolean).join(' ').slice(0, 200);
  }

  function ancestorTagNames(node) {
    const tags = [];
    let p = node.parent;
    while (p) {
      if (p.type === 'element') {
        for (const ch of p.children) {
          if (ch.type === 'start_tag') {
            const tn = getTagName(ch);
            if (tn) {
              tags.push(tn);
            }
            break;
          }
        }
      }
      p = p.parent;
    }
    return tags;
  }

  function walk(node, depth) {
    if (node.type === 'element' || node.type === 'script_element' || node.type === 'style_element') {
      let startTag = null,
        endTag = null,
        rawText = null;
      const childElements = [];

      for (const ch of node.children) {
        if (ch.type === 'start_tag') {
          startTag = ch;
        } else if (ch.type === 'end_tag') {
          endTag = ch;
        } else if (ch.type === 'self_closing_tag') {
          startTag = ch;
        } else if (ch.type === 'raw_text') {
          rawText = ch;
        } else if (ch.type === 'element' || ch.type === 'script_element' || ch.type === 'style_element') {
          childElements.push(ch);
        }
      }

      if (startTag) {
        const tagName = getTagName(startTag).toLowerCase(),
          attrs = getAttrs(startTag),
          parentName = ancestorTagNames(node).find(() => true) || '',
          sig = source.substring(startTag.startIndex, Math.min(startTag.endIndex, startTag.startIndex + 200)),
          sl = startTag.startPosition.row + 1,
          el = endTag ? endTag.endPosition.row + 1 : startTag.endPosition.row + 1,
          sb = startTag.startIndex,
          eb = endTag ? endTag.endIndex : startTag.endIndex,
        isCustom = (() => {

  
          for (const attr of attrs) {
            if (attr.name === 'id' && attr.value) {
              add(attr.value, 'id', sl, el, sb, eb, `id="${attr.value}"`, tagName);
            }
          }
  
          for (const attr of attrs) {
            if (attr.name === 'class' && attr.value) {
              for (const cls of attr.value.split(/\s+/).filter(Boolean)) {
                add(cls, 'css_class', sl, el, sb, eb, `class="${cls}"`, tagName);
              }
            }
          }
  
          
  return ((tagName.includes('-') && !_STANDARD_HTML_TAGS.has(tagName)) || /^[A-Z]/.test(getTagName(startTag)));
})(),
        resAttrs = (() => {
if (isCustom) {
            const attrSig = attrs.map((a) => (a.value ? `${a.name}="${a.value}"` : a.name)).join(' ');
            add(getTagName(startTag), 'component', sl, el, sb, eb, `<${getTagName(startTag)} ${attrSig}>`, parentName);
          }
  
          if (_SEMANTIC_ELEMENTS.has(tagName)) {
            const text = getTextContent(node);
            add(`<${tagName}>`, 'element', sl, el, sb, eb, sig, parentName, text);
          }
  
          if (_HEADING_TAGS.has(tagName)) {
            const text = getTextContent(node);
            add(text || `<${tagName}>`, 'heading', sl, el, sb, eb, sig, parentName);
          }
  
          if (tagName === 'meta') {
            let metaName = '',
              metaContent = '';
            for (const attr of attrs) {
              if (attr.name === 'name' || attr.name === 'property') {
                metaName = attr.value;
              }
              if (attr.name === 'content') {
                metaContent = attr.value;
              }
            }
            if (metaName) {
              add(metaName, 'meta', sl, sl, sb, eb, `name="${metaName}" content="${metaContent}"`, '', metaContent);
            }
          }
  
          
  return (_RESOURCE_ATTRS[tagName]);
})();if (resAttrs) {
          for (const attr of attrs) {
            if (resAttrs.includes(attr.name) && attr.value) {
              add(attr.value, 'link_ref', sl, el, sb, eb, `<${tagName} ${attr.name}="${attr.value}">`, tagName);
            }
          }
        }

        if (_FORM_TAGS.has(tagName)) {
          const formAttrs = {};
          for (const attr of attrs) {
            if (
              ['name', 'type', 'action', 'method', 'placeholder', 'required', 'pattern', 'enctype'].includes(attr.name)
            ) {
              formAttrs[attr.name] = attr.value || 'true';
            }
          }
          {
const formSig = Object.entries(formAttrs)
              .map(([k, v]) => `${k}="${v}"`)
              .join(' '),
            fname = formAttrs.name || formAttrs.type || tagName;
          add(fname, 'form_control', sl, el, sb, eb, `<${tagName} ${formSig}>`, parentName);
        }
}

        for (const attr of attrs) {
          if (attr.name === 'role' || attr.name.startsWith('aria-')) {
            add(
              attr.value || attr.name,
              'aria',
              sl,
              sl,
              attr.node.startIndex,
              attr.node.endIndex,
              `${attr.name}="${attr.value}"`,
              tagName,
            );
          }
        }

        for (const attr of attrs) {
          if (attr.name.startsWith('data-')) {
            add(
              attr.name,
              'data_attr',
              sl,
              sl,
              attr.node.startIndex,
              attr.node.endIndex,
              `${attr.name}="${attr.value}"`,
              tagName,
            );
          }
        }

        for (const attr of attrs) {
          if (attr.name === 'itemscope' || attr.name === 'itemtype' || attr.name === 'itemprop') {
            add(
              attr.value || attr.name,
              'microdata',
              sl,
              sl,
              attr.node.startIndex,
              attr.node.endIndex,
              `${attr.name}="${attr.value || ''}"`,
              tagName,
            );
          }
        }
      }

      if (node.type === 'script_element' && rawText) {
        const body = rawText.text.trim();
        if (body) {
          const startTag2 = node.children.find((c) => c.type === 'start_tag'), sl2 = rawText.startPosition.row + 1,
            el2 = rawText.endPosition.row + 1,
            preview = body.split('\n').slice(0, 3).join('\n'),
            sig = preview.length > 200 ? `${preview.slice(0, 197)}...` : preview;
          let scriptType = '';
          if (startTag2) {
            for (const a of getAttrs(startTag2)) {
              if (a.name === 'type') {
                scriptType = a.value;
              }
            }
          }
          
          add(
            `[inline-script:${sl2}]`,
            'script',
            sl2,
            el2,
            rawText.startIndex,
            rawText.endIndex,
            sig,
            '',
            scriptType || 'javascript',
          );
        }
      }

      if (node.type === 'style_element' && rawText) {
        const body = rawText.text.trim();
        if (body) {
          const sl2 = rawText.startPosition.row + 1,
            el2 = rawText.endPosition.row + 1,
            preview = body.split('\n').slice(0, 3).join('\n'),
            sig = preview.length > 200 ? `${preview.slice(0, 197)}...` : preview;
          add(`[inline-style:${sl2}]`, 'style', sl2, el2, rawText.startIndex, rawText.endIndex, sig);
        }
      }

      for (const child of childElements) {
        walk(child, depth + 1);
      }
      return;
    }

    for (const ch of node.children) {
      walk(ch, depth + 1);
    }
  }

  walk(root, 0);
  tree.delete();
  return symbols;
}

// ── CSS / SCSS regex-based extractor ───────────────────────



function _extractCssSymbols(filePath, source) {
  const symbols = [],
    seen = new Set(),
    isScss = filePath.endsWith('.scss');

  function add(name, kind, startLine, signature) {
    const key = `${name}:${kind}:${startLine}`;
    if (seen.has(key)) {
      return;
    }
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
    // oxlint-disable-next-line no-continue
    if (!selector || selector.startsWith('@') || selector.startsWith('//') || selector.startsWith('/*')) {
      continue;
    }
    // Skip property-like patterns (word: value;) that aren't class/id selectors
    // oxlint-disable-next-line no-continue
    if (/^\s*[\w-]+\s*:/.test(selector) && !selector.startsWith('.') && !selector.startsWith('#')) {
      continue;
    }
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
  const symbols = [],
    seen = new Set();
  function add(name, kind, index, signature) {
    const startLine = source.substring(0, index).split('\n').length,
      key = `${name}:${kind}:${startLine}`;
    if (seen.has(key)) {
      return;
    }
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
  const { symbols, add } = _makeRegexSymbol(filePath, source, 'bash'),
    functionRe = /^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*(?:\(\))?\s*\{/gm,
    varRe = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=/gm;
  for (const match of source.matchAll(functionRe)) {
    add(match[1], 'function', match.index, match[0].trim());
  }
  for (const match of source.matchAll(varRe)) {
    add(match[1], 'env_var', match.index, match[0].trim());
  }
  return symbols;
}

function _extractJsonSymbols(filePath, source) {
  const { symbols, add } = _makeRegexSymbol(filePath, source, 'json'),
    keyRe = /"([^"\n]+)"\s*:/g;
  for (const match of source.matchAll(keyRe)) {
    const key = match[1];
    if (key.length <= 80) {
      add(key, 'config_key', match.index, match[0].trim());
    }
  }
  return symbols;
}

function _extractYamlSymbols(filePath, source) {
  const { symbols, add } = _makeRegexSymbol(filePath, source, 'yaml'),
    keyRe = /^(\s*)([A-Za-z0-9_.-]+)\s*:/gm;
  for (const match of source.matchAll(keyRe)) {
    const depth = Math.floor((match[1] || '').length / 2);
    add(match[2], depth === 0 ? 'config_section' : 'config_key', match.index, match[0].trim());
  }
  return symbols;
}

/**
 * Extract call expressions from a file using AST parsing.
 * Returns array of { callee, line, is_method, receiver, full_path }.
 * Entries for `require`/`import` also include `module_path` (the string literal),
 * and entries for `eval`/`Function` also include `is_dynamic: true`.
 * - receiver: the object part of a member call (e.g., 'this', 'super', 'obj', or null for direct calls)
 * - full_path: the complete callee text (e.g., 'this.method', 'obj.method', 'foo')
 */
function _walkCallees(root, _SKIP) {
  const callees = [],
    seen = new Set();

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
        } else if (
          calleeNode.type === 'member_expression' ||
          calleeNode.type === 'selector_expression' ||
          calleeNode.type === 'field_expression'
        ) {
          const propNode = calleeNode.child(calleeNode.childCount - 1),
            objNode = calleeNode.child(0),
            propTypes = ['property_identifier', 'identifier', 'field_identifier', 'name'];
          if (propNode && propTypes.includes(propNode.type)) {
            const name = propNode.text;
            if (!_SKIP.has(name)) {
              const key = `${name}:${node.startPosition.row + 1}`;
              if (!seen.has(key)) {
                seen.add(key);
                let receiver = null;
                if (objNode) {
                  receiver = objNode.text;
                }
                const full_path = receiver ? `${receiver}.${name}` : name,
                  entry = {
                    callee: name,
                    line: node.startPosition.row + 1,
                    is_method: true,
                    receiver,
                    full_path,
                  };
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
        } else if (calleeNode.type === 'scoped_identifier') {
          const name = calleeNode.text.replace(/::/g, '.'),
            lastPart = name.split('.').pop();
          if (lastPart && !_SKIP.has(lastPart)) {
            const key = `${lastPart}:${node.startPosition.row + 1}`;
            if (!seen.has(key)) {
              seen.add(key);
              callees.push({
                callee: lastPart,
                line: node.startPosition.row + 1,
                is_method: false,
                receiver: null,
                full_path: name,
              });
            }
          }
        }
      }
    }

    // Python call node — Python uses 'call' not 'call_expression'
    if (node.type === 'call') {
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
        } else if (calleeNode.type === 'attribute') {
          const attrNode = calleeNode.child(calleeNode.childCount - 1),
            objNode = calleeNode.child(0);
          if (attrNode && attrNode.type === 'identifier') {
            const name = attrNode.text;
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
                  receiver,
                  full_path,
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
          const name = child.text,
            key = `new_${name}:${node.startPosition.row + 1}`;
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
          const modPath = child.text.replace(/^["']|["']$/g, ''),
            key = `import:${modPath}:${node.startPosition.row + 1}`;
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
  const ext = path.extname(filePath).toLowerCase(),
    langConfig = LANGUAGE_MAP[ext],
  parser = !(!langConfig || langConfig.languageName === 'sql') ? (_parsers[langConfig.parserKey]) : undefined,
  tree = !(!langConfig || langConfig.languageName === 'sql') && parser ? (parser.parse(content)) : undefined,
  result = !(!langConfig || langConfig.languageName === 'sql') && parser ? (_walkCallees(tree.rootNode, SKIP_CALLEE_NAMES)) : undefined;
  if (!langConfig || langConfig.languageName === 'sql') {
    return [];
  }

  if (!parser) {
    return [];
  }

  tree.delete();
  return result;
}

function extractCallees(filePath) {
  if (!_ready) {
    return [];
  }
  const ext = path.extname(filePath).toLowerCase(),
    langConfig = LANGUAGE_MAP[ext],
  parser = !(!langConfig || langConfig.languageName === 'sql') ? (_parsers[langConfig.parserKey]) : undefined;
  if (!langConfig || langConfig.languageName === 'sql') {
    return [];
  }

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

  const tree = parser.parse(source),
    result = _walkCallees(tree.rootNode, SKIP_CALLEE_NAMES);
  tree.delete();
  return result;
}

module.exports = { init, isReady, parseFile, parseContent, extractCallees, extractCalleesFromContent, info, parseTree };

/**
 * Parse a file and return the raw tree-sitter tree + parser for scope building.
 * The caller is responsible for calling tree.delete() when done.
 * @param {string} filePath
 * @param {string} content
 * @returns {{ tree: object, parser: object } | null}
 */
function parseTree(filePath, content) {
  if (!_ready) {
    return null;
  }
  const ext = path.extname(filePath).toLowerCase(),
    langConfig = LANGUAGE_MAP[ext],
  parser = langConfig ? (_parsers[langConfig.parserKey]) : undefined,
  tree = langConfig && parser ? (parser.parse(content)) : undefined;
  if (!langConfig) {
    return null;
  }
  if (!parser) {
    return null;
  }
  if (!tree) {
    return null;
  }
  return { tree, parser };
}
function isReady() {
  return _ready;
}
function info() {
  return {
    ready: _ready,
    grammars: Object.keys(_parsers),
    grammarDir: GRAMMAR_DIR,
    availableFiles: fs.existsSync(GRAMMAR_DIR) ? fs.readdirSync(GRAMMAR_DIR).filter((f) => f.endsWith('.wasm')) : [],
  };
}
function _routeToExtractor(filePath, source, parser, langConfig) {
  if (langConfig.extractor === 'regex') {
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
  if (langConfig.languageName === 'html') {
    return _extractHtmlSymbolsAst(filePath, source, parser);
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
  const ext = path.extname(filePath).toLowerCase(),
    langConfig = LANGUAGE_MAP[ext];
  if (!langConfig) {
    return null;
  }
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
  if (!parser) {
    return null;
  }
  return { langConfig, parser };
}
function parseContent(filePath, content) {
  if (!_ready) {
    return [
      {
        name: '',
        kind: 'diagnostic',
        language: '',
        file: filePath,
        signature: 'parse-code not initialized: call init() first',
        qualified_name: '',
        start_line: 0,
        end_line: 0,
        start_byte: 0,
        end_byte: 0,
        docstring: '',
        body_preview: '',
        parent_name: '',
      },
    ];
  }
  const cfg = _getLangConfig(filePath);
  if (!cfg) {
    const ext = path.extname(filePath).toLowerCase(),
      known = ext in LANGUAGE_MAP,
      msg = known
        ? `parse-code: language ${LANGUAGE_MAP[ext].languageName} has no WASM grammar loaded`
        : `parse-code: file extension ${ext || '(none)'} is not supported`;
    return [
      {
        name: '',
        kind: 'diagnostic',
        language: '',
        file: filePath,
        signature: msg,
        qualified_name: '',
        start_line: 0,
        end_line: 0,
        start_byte: 0,
        end_byte: 0,
        docstring: '',
        body_preview: '',
        parent_name: '',
      },
    ];
  }

  const symbols = _routeToExtractor(filePath, content, cfg.parser, cfg.langConfig);
  if (symbols.length === 0 && content.trim().length > 0) {
    return _fallbackExtractSymbols(filePath, content);
  }
  return symbols;
}
function parseFile(filePath) {
  if (!_ready) {
    return [
      {
        name: '',
        kind: 'diagnostic',
        language: '',
        file: filePath,
        signature: 'parse-code not initialized: call init() first',
        qualified_name: '',
        start_line: 0,
        end_line: 0,
        start_byte: 0,
        end_byte: 0,
        docstring: '',
        body_preview: '',
        parent_name: '',
      },
    ];
  }

  const cfg = _getLangConfig(filePath);
  if (!cfg) {
    const ext = path.extname(filePath).toLowerCase(),
      known = ext in LANGUAGE_MAP,
      msg = known
        ? `parse-code: language ${LANGUAGE_MAP[ext].languageName} has no WASM grammar loaded`
        : `parse-code: file extension ${ext || '(none)'} is not supported`;
    return [
      {
        name: '',
        kind: 'diagnostic',
        language: '',
        file: filePath,
        signature: msg,
        qualified_name: '',
        start_line: 0,
        end_line: 0,
        start_byte: 0,
        end_byte: 0,
        docstring: '',
        body_preview: '',
        parent_name: '',
      },
    ];
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
  const ext = path.extname(filePath).toLowerCase(),
    symbols = [],
    seen = new Set(), jsTsExts = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.tsx']);

  

  
  if (jsTsExts.has(ext)) {
    const re =
      /(?:^|\n)\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function\s+(\w+)|(?:class|interface|type|enum)\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=[^;\n]*)/g;
    let match;
    while ((match = re.exec(content)) !== null) {
      const name = match[1] || match[2] || match[3];
      if (name) {
        const kind = _fallbackJsTsKind(content, match),
          line = _getLineFromOffset(content, match.index),
          sig = match[0].trim().split('\n')[0];
        add(name, kind, line, sig, match.index);
      }
    }
  } else if (ext === '.py' || ext === '.pyw') {
    const re = /^(?:async\s+)?(?:def|class)\s+(\w+)/gm;
    let match;
    while ((match = re.exec(content)) !== null) {
      const name = match[1],
        kind = match[0].includes('def ') ? 'function' : 'class',
        line = _getLineFromOffset(content, match.index);
      add(name, kind, line, match[0].trim(), match.index);
    }
  } else if (ext === '.go') {
    const funcRe = /^func\s+(?:\([^)]*\)\s*)?(\w+)/gm,
      typeRe = /^type\s+(\w+)/gm;
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
    const fnRe = /(?:^|\n)\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/g,
      structRe = /(?:^|\n)\s*(?:pub\s+)?struct\s+(\w+)/g,
      enumRe = /(?:^|\n)\s*(?:pub\s+)?enum\s+(\w+)/g,
      traitRe = /(?:^|\n)\s*(?:pub\s+)?trait\s+(\w+)/g;
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
      {
        re: /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?([`\[\]"']?\w+[`\[\]"']?)/gi,
        kind: 'view',
      },
      {
        re: /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?FUNCTION\s+([`\[\]"']?\w+[`\[\]"']?)/gi,
        kind: 'function',
      },
      { re: /\bCREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+([`\[\]"']?\w+[`\[\]"']?)/gi, kind: 'trigger' },
      { re: /\bCREATE\s+PROCEDURE\s+([`\[\]"']?\w+[`\[\]"']?)/gi, kind: 'procedure' },
    ];
    for (const { re, kind: symKind } of sqlPatterns) {
      let match;
      re.lastIndex = 0;
      while ((match = re.exec(content)) !== null) {
        const name = match[1].replace(/[`\[\]"']/g, ''),
          line = _getLineFromOffset(content, match.index);
        add(name, symKind, line, match[0].trim(), match.index);
      }
    }
  }

  return symbols;
function add(name, kind, line, signature, startByte) {
    const key = `${name}:${kind}:${startByte}`;
    if (seen.has(key)) {
      return;
    }
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
}
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
  const text = sourceStr.substring(node.startIndex, node.endIndex),
    firstLine = text.split('\n')[0].trim();
  return firstLine.length > 200 ? `${firstLine.slice(0, 197)}...` : firstLine;
}
function _getDocstring(node) {
  if (!node.parent) {
    return '';
  }

  // Python: docstring is the first expression_statement containing a string in the body
  if (node.type === 'function_definition' || node.type === 'class_definition') {
    const body = node.childForFieldName('body');
    if (body) {
      for (const child of body.children) {
        if (child.type === 'expression_statement') {
          for (const expr of child.children) {
            if (expr.type === 'string') {
              let text = expr.text;
              if (
                (text.startsWith('"""') && text.endsWith('"""')) ||
                (text.startsWith("'''") && text.endsWith("'''"))
              ) {
                text = text.slice(3, -3);
              } else if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
                text = text.slice(1, -1);
              }
              return text.trim();
            }
          }
        }
        break;
      }
    }
    return '';
  }

  // Find index manually — WASM node objects don't support indexOf reference equality
  const parent = node.parent, comments = [];
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

  // Collect consecutive comment nodes preceding this node
  
  for (let i = idx - 1; i >= 0; i--) {
    const prev = parent.child(i);
    if (prev.type === 'comment') {
      comments.unshift(prev);
    } else if (prev.type === 'line_comment') {
      comments.unshift(prev);
    } else {
      break;
    }
  }

  if (comments.length === 0) {
    return '';
  }

  const _prev = parent.child(idx - 1),
    singleComment = comments.length === 1 ? comments[0] : null,
    text = singleComment ? singleComment.text : comments.map((c) => c.text).join('\n');

  // JS/TS block comments: /** ... */ or /* ... */
  if (singleComment && singleComment.type === 'comment') {
    let cleaned = text;
    if (cleaned.startsWith('/**')) {
      cleaned = cleaned.slice(3);
    } else if (cleaned.startsWith('/*')) {
      cleaned = cleaned.slice(2);
    }
    if (cleaned.endsWith('*/')) {
      cleaned = cleaned.slice(0, -2);
    }
    const lines = cleaned.split('\n'),
      result = [];
    for (let line of lines) {
      line = line.trim();
      if (line.startsWith('* ')) {
        line = line.slice(2);
      } else if (line === '*') {
        line = '';
      }
      result.push(line.trim());
    }
    return result.join('\n').trim();
  }

  // Go and Rust line comments: collect consecutive // or /// lines
  if (comments.length > 0 && (comments[0].type === 'comment' || comments[0].type === 'line_comment')) {
    const isDocComment = comments.every((c) => c.text.startsWith('///') || c.text.startsWith('//'));
    if (isDocComment) {
      return comments
        .map((c) => {
          let line = c.text;
          if (line.startsWith('/// ')) {
            line = line.slice(4);
          } else if (line.startsWith('///')) {
            line = line.slice(3);
          } else if (line.startsWith('// ')) {
            line = line.slice(3);
          } else if (line.startsWith('//')) {
            line = line.slice(2);
          }
          return line.trim();
        })
        .join('\n')
        .trim();
    }
  }

  return '';
}
function _getBodyPreview(node, sourceStr, maxLines = 5) {
  const text = sourceStr.substring(node.startIndex, node.endIndex),
    lines = text.split('\n'),
    bodyLines = [];
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
  return node.startPosition.row + 1;
}
function _getEndLineNumber(node) {
  return node.endPosition.row + 1;
}
function _getContextName(node) {
  let current = node.parent;
  while (current) {
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
function _extractJsTsSymbols(filePath, sourceStr, parser, languageName) {
  // Skip tree-sitter parse for files with no recognizable symbol patterns in
  // The first 2048 bytes. Prevents WASM hangs on trivial content like
  // `module.exports = {};` while still parsing files with any realistic code.
  if (
    !/\b(function|class|const|let|var|import|export|interface|type|enum|async|yield|=>|get |set |static )|\w+\s*\(/.test(
      sourceStr.slice(0, 2048),
    )
  ) {
    return [];
  }
  const tree = parser.parse(sourceStr),
    root = tree.rootNode,
    symbols = [],
    seen = new Set();

  function walk(node, depth) {
    if (node.type in _JS_TS_SYMBOL_NODES) {
      const kind = _JS_TS_SYMBOL_NODES[node.type],
        name = _getNodeName(node);
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
            const parentName = _getParentClassName(node),
              qualified = parentName ? `${parentName}.${name}` : name;
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
    } else if (node.type === 'variable_declarator') {
      let name = null,
        kind = 'constant';
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
          const parentName = _getParentClassName(node),
            lineText = sourceStr
              .substring(node.startIndex, Math.min(node.startIndex + 200, sourceStr.length))
              .split('\n')[0],
            sig = (parent ? sourceStr.substring(parent.startIndex, parent.endIndex) : lineText).split('\n')[0];
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
          const name = child.text,
            key = `${name}:export:${node.startIndex}`;
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
              const modPath = ac.text.replace(/^["']|["']$/g, ''),
                key = `${modPath}:dynamic_import:${node.startIndex}`;
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
function _extractPythonSymbols(filePath, sourceStr, parser) {
  const tree = parser.parse(sourceStr),
    root = tree.rootNode,
    symbols = [],
    seen = new Set();

  function walk(node, depth) {
    const kind = _PY_SYMBOL_NODES[node.type],
    childDepth = (() => {

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
            let parentName = '',
              p = node.parent;
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
              docstring: _getDocstring(node),
              body_preview: _getBodyPreview(node, sourceStr),
              parent_name: parentName,
            });
          }
        }
      }
      if (node.type === 'expression_statement' && depth === 0) {
        for (const child of node.children) {
          if (child.type === 'assignment') {
            const left = child.child(0);
            if (left && left.type === 'identifier') {
              const name = left.text;
              // oxlint-disable-next-line no-continue
              if (name === '_' || (name.startsWith('__') && name.endsWith('__'))) {
                continue;
              }
              const right = child.child(2);
              let assignKind = 'constant';
              if (right) {
                if (right.type === 'dictionary' || right.type === 'list' || right.type === 'set') {
                  assignKind = 'constant';
                } else if (right.type === 'call') {
                  const callee = right.child(0);
                  if (callee && callee.type === 'identifier' && callee.text === 'TypedDict') {
                    assignKind = 'type';
                  } else if (callee && callee.type === 'identifier' && callee.text === 'NamedTuple') {
                    assignKind = 'type';
                  }
                } else if (right.type === 'identifier') {
                  assignKind = 'type';
                }
              }
              const key = `${name}:${assignKind}:${node.startIndex}`;
              if (!seen.has(key)) {
                seen.add(key);
                symbols.push({
                  name,
                  kind: assignKind,
                  language: 'python',
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
        }
      }
      if (node.type === 'decorator') {
        const name = node.text.replace(/^@/, '').split('(')[0];
        if (name && !seen.has(`@${name}:decorator:${node.startIndex}`)) {
          seen.add(`@${name}:decorator:${node.startIndex}`);
        }
      }
      if (node.type === 'import_statement' || node.type === 'import_from_statement') {
        const importPath = node.text
            .replace(/^from\s+/, '')
            .split(/\s+import\b/)[0]
            .trim(),
          key = `import:${importPath}:${node.startIndex}`;
        if (!seen.has(key)) {
          seen.add(key);
          symbols.push({
            name: importPath,
            kind: 'import',
            language: 'python',
            file: filePath,
            signature: node.text.split('\n')[0].slice(0, 200),
            qualified_name: importPath,
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
  
      
  return (_PY_SCOPE_NODES.has(node.type) ? depth + 1 : depth);
})();for (const child of node.children) {
      walk(child, childDepth);
    }
  }

  walk(root, 0);
  tree.delete();
  return symbols;
}
function _extractGoSymbols(filePath, sourceStr, parser) {
  const tree = parser.parse(sourceStr),
    root = tree.rootNode,
    symbols = [],
    seen = new Set();

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
            docstring: _getDocstring(node),
            body_preview: _getBodyPreview(node, sourceStr),
            parent_name: '',
          });
        }
      }
    }
    // Method_declaration: func (r Receiver) name(...)
    else if (node.type === 'method_declaration') {
      let name = '',
        receiver = '';
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
            docstring: _getDocstring(node),
            body_preview: _getBodyPreview(node, sourceStr),
            parent_name: receiver,
          });
        }
      }
    }
    // Type_declaration: type Name struct/interface
    else if (node.type === 'type_declaration') {
      for (const child of node.children) {
        if (child.type === 'type_identifier') {
          const name = child.text,
            key = `${name}:type:${node.startIndex}`;
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
              docstring: _getDocstring(node),
              body_preview: '',
              parent_name: '',
            });
          }
        }
      }
    }
    // Var/const declarations at top level
    else if ((node.type === 'var_declaration' || node.type === 'const_declaration') && depth === 0) {
      for (const child of node.children) {
        if (child.type === 'var_spec' || child.type === 'const_spec') {
          let name = '';
          for (const specChild of child.children) {
            if (specChild.type === 'identifier') {
              name = specChild.text;
              break;
            }
          }
          if (name) {
            const kind = node.type === 'const_declaration' ? 'constant' : 'constant',
              key = `${name}:${kind}:${child.startIndex}`;
            if (!seen.has(key)) {
              seen.add(key);
              symbols.push({
                name,
                kind,
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
                docstring: _getDocstring(node),
                body_preview: '',
                parent_name: '',
              });
            }
          }
        }
      }
    }
    // Go import declarations
    if (node.type === 'import_declaration') {
      for (const child of node.children) {
        if (child.type === 'import_spec' || child.type === 'import_spec_list') {
          for (const spec of child.children) {
            if (spec.type === 'import_spec') {
              for (const sc of spec.children) {
                if (sc.type === 'interpreted_string_literal') {
                  const importPath = sc.text.replace(/^"|"$/g, ''),
                    key = `import:${importPath}:${spec.startIndex}`;
                  if (!seen.has(key)) {
                    seen.add(key);
                    symbols.push({
                      name: importPath,
                      kind: 'import',
                      language: 'go',
                      file: filePath,
                      signature: `import "${importPath}"`,
                      qualified_name: importPath,
                      start_line: spec.startPosition.row + 1,
                      end_line: spec.endPosition.row + 1,
                      start_byte: spec.startIndex,
                      end_byte: spec.endIndex,
                      docstring: '',
                      body_preview: '',
                      parent_name: '',
                    });
                  }
                }
              }
            } else if (spec.type === 'interpreted_string_literal') {
              const importPath = spec.text.replace(/^"|"$/g, ''),
                key = `import:${importPath}:${spec.startIndex}`;
              if (!seen.has(key)) {
                seen.add(key);
                symbols.push({
                  name: importPath,
                  kind: 'import',
                  language: 'go',
                  file: filePath,
                  signature: `import "${importPath}"`,
                  qualified_name: importPath,
                  start_line: spec.startPosition.row + 1,
                  end_line: spec.endPosition.row + 1,
                  start_byte: spec.startIndex,
                  end_byte: spec.endIndex,
                  docstring: '',
                  body_preview: '',
                  parent_name: '',
                });
              }
            }
          }
        } else if (child.type === 'interpreted_string_literal') {
          const importPath = child.text.replace(/^"|"$/g, ''),
            key = `import:${importPath}:${child.startIndex}`;
          if (!seen.has(key)) {
            seen.add(key);
            symbols.push({
              name: importPath,
              kind: 'import',
              language: 'go',
              file: filePath,
              signature: `import "${importPath}"`,
              qualified_name: importPath,
              start_line: child.startPosition.row + 1,
              end_line: child.endPosition.row + 1,
              start_byte: child.startIndex,
              end_byte: child.endIndex,
              docstring: '',
              body_preview: '',
              parent_name: '',
            });
          }
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
function _extractRustSymbols(filePath, sourceStr, parser) {
  const tree = parser.parse(sourceStr),
    root = tree.rootNode,
    symbols = [],
    seen = new Set();

  function walk(node, depth) {
    const kind = _RUST_SYMBOL_NODES[node.type];
    if (kind) {
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
        let implName = '',
          implTarget = '';
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
              docstring: _getDocstring(node),
              body_preview: '',
              parent_name: '',
            });
          }
        }
        // Walk into impl_item to find methods at depth+1
        const _childDepth = depth + 1;
        function collectMethods(n) {
          if (n.type === 'function_item' || n.type === 'function_signature_item') {
            let methodName = '';
            for (const mc of n.children) {
              if (mc.type === 'identifier') {
                methodName = mc.text;
                break;
              }
            }
            if (methodName) {
              const key = `${implName}.${methodName}:function:${n.startIndex}`;
              if (!seen.has(key)) {
                seen.add(key);
                symbols.push({
                  name: methodName,
                  kind: 'function',
                  language: 'rust',
                  file: filePath,
                  signature: sourceStr.substring(n.startIndex, Math.min(n.startIndex + 200, n.endIndex)).split('\n')[0],
                  qualified_name: implName ? `${implName}.${methodName}` : methodName,
                  start_line: n.startPosition.row + 1,
                  end_line: n.endPosition.row + 1,
                  start_byte: n.startIndex,
                  end_byte: n.endIndex,
                  docstring: _getDocstring(n),
                  body_preview: _getBodyPreview(n, sourceStr),
                  parent_name: implName,
                });
              }
            }
          } else {
            for (const c of n.children) {
              collectMethods(c);
            }
          }
        }
        collectMethods(node);
        // Don't walk deeper since we already handled methods
        return;
      }
      if (name && kind !== 'constant') {
        const key = `${name}:${kind}:${node.startIndex}`;
        if (!seen.has(key)) {
          seen.add(key);
          let parentName = '';
          if (node.type === 'struct_item') {
            for (const child of node.children) {
              if (child.type === 'type_identifier' && child.text !== name) {
                parentName = child.text;
              }
            }
          } else if (node.type === 'enum_variant') {
            let p = node.parent;
            while (p) {
              if (p.type === 'enum_item') {
                for (const c of p.children) {
                  if (c.type === 'identifier' || c.type === 'type_identifier') {
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
            docstring: _getDocstring(node),
            body_preview: _getBodyPreview(node, sourceStr),
            parent_name: parentName,
          });
        }
      }
    }
    if (node.type === 'use_declaration') {
      const args = node.childForFieldName('argument');
      if (args) {
        const usePath = args.text,
          key = `use:${usePath}:${node.startIndex}`;
        if (!seen.has(key)) {
          seen.add(key);
          symbols.push({
            name: usePath,
            kind: 'import',
            language: 'rust',
            file: filePath,
            signature: sourceStr
              .substring(node.startIndex, Math.min(node.startIndex + 200, node.endIndex))
              .split('\n')[0],
            qualified_name: usePath,
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
  const symbols = [],
    seen = new Set(), patterns = [
    {
      re: /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`\[\]"']?\w+[`\[\]"']?(?:\.[`\[\]"']?\w+[`\[\]"']?)?)/gi,
      kind: 'table',
    },
    {
      re: /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?([`\[\]"']?\w+[`\[\]"']?(?:\.[`\[\]"']?\w+[`\[\]"']?)?)/gi,
      kind: 'view',
    },
    {
      re: /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([`\[\]"']?\w+[`\[\]"']?(?:\.[`\[\]"']?\w+[`\[\]"']?)?)/gi,
      kind: 'index',
    },
    {
      re: /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?FUNCTION\s+([`\[\]"']?\w+[`\[\]"']?(?:\.[`\[\]"']?\w+[`\[\]"']?)?)/gi,
      kind: 'function',
    },
    { re: /\bCREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+([`\[\]"']?\w+[`\[\]"']?)/gi, kind: 'trigger' },
    { re: /\bALTER\s+TABLE\s+([`\[\]"']?\w+[`\[\]"']?(?:\.[`\[\]"']?\w+[`\[\]"']?)?)/gi, kind: 'alter' },
    {
      re: /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([`\[\]"']?\w+[`\[\]"']?(?:\.[`\[\]"']?\w+[`\[\]"']?)?)/gi,
      kind: 'drop',
    },
    { re: /\bINSERT\s+INTO\s+([`\[\]"']?\w+[`\[\]"']?(?:\.[`\[\]"']?\w+[`\[\]"']?)?)/gi, kind: 'insert' },
    { re: /\bUPDATE\s+([`\[\]"']?\w+[`\[\]"']?(?:\.[`\[\]"']?\w+[`\[\]"']?)?)/gi, kind: 'update' },
    { re: /\bDELETE\s+FROM\s+([`\[\]"']?\w+[`\[\]"']?(?:\.[`\[\]"']?\w+[`\[\]"']?)?)/gi, kind: 'delete' },
    { re: /\bCREATE\s+PROCEDURE\s+([`\[\]"']?\w+[`\[\]"']?(?:\.[`\[\]"']?\w+[`\[\]"']?)?)/gi, kind: 'procedure' },
  ],
  selectRe = (() => {

  
    for (const { re, kind } of patterns) {
      let match;
      re.lastIndex = 0;
      while ((match = re.exec(source)) !== null) {
        const rawName = match[1].replace(/[`\[\]"']/g, ''),
          line = getLine(match.index),
          lineEnd = source.indexOf('\n', match.index),
          endByte = lineEnd === -1 ? source.length : lineEnd,
          sig = source.substring(match.index, endByte).trim();
        add(rawName, kind, line, match.index, endByte, sig);
      }
    }
  
    
  return (/\bSELECT\b/gi);
})();

  

  

  let selMatch;
  while ((selMatch = selectRe.exec(source)) !== null) {
    const line = getLine(selMatch.index),
      lineEnd = source.indexOf('\n', selMatch.index),
      endByte = lineEnd === -1 ? source.length : lineEnd,
      sig = source.substring(selMatch.index, endByte).trim();
    add(`SELECT:${line}`, 'select', line, selMatch.index, endByte, sig);
  }

  return symbols;
function add(name, kind, startLine, startByte, endByte, sig) {
    const key = `${name}:${kind}:${startLine}`;
    if (seen.has(key)) {
      return;
    }
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
}
function _extractSqlSymbols(filePath, sourceStr, parser) {
  const tree = parser.parse(sourceStr),
    root = tree.rootNode,
    symbols = [];

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
      const kind = SQL_STATEMENT_MAP[node.type], fullText = node.text;
      let name = getSqlName(node), sig = fullText.split('\n')[0].trim();
      if (!name) {
        name = { select: 'SELECT', insert: 'INSERT', update: 'UPDATE', delete: 'DELETE' }[node.type] || 'UNKNOWN';
      }

      
      
      if (sig.length > 200) {
        sig = `${sig.slice(0, 197)}...`;
      }

      const bodyLines = fullText
          .split('\n')
          .slice(1)
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(0, 5),
        bodyPreview = bodyLines.join('\n');

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
}
}
}
}
}
}
