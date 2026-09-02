// Rust scope builder — walks a tree-sitter AST and extracts scope bindings.
// Covers: use, declaration, let_binding, impl_method, type_declaration.

const { addBinding, dedupBindings } = require('./shared');

function buildRustScopeBindings(tree, _source, _filePath) {
  const bindings = [];

  function walk(node, scopeDepth) {
    if (!node) {
      return;
    }
    const type = node.type;

    switch (type) {
      // ── Use declarations ───────────────────────────────────
      case 'use_declaration': {
        handleUseDeclaration(node);
        break;
      }

      // ── Function declarations ──────────────────────────────
      case 'function_item': {
        const nameNode = node.childForFieldName('name'),
        params = (() => {

          if (nameNode) {
            addBinding(bindings, {
              name: nameNode.text,
              kind: 'declaration',
              origin: 'local',
              sourceModule: null,
              sourceName: null,
              lineStart: node.startPosition.row + 1,
              lineEnd: node.endPosition.row + 1,
              scopeDepth,
              byteStart: node.startIndex,
              byteEnd: node.endIndex,
            });
          }
          
  return (node.childForFieldName('parameters'));
})(),
        body = (() => {
if (params) {
            extractRustParameters(params, scopeDepth + 1);
          }
          
  return (node.childForFieldName('body'));
})();if (body) {
          walkChildren(body, scopeDepth + 1);
        }
        return;
      }

      // ── Struct/Enum/Type declarations ──────────────────────
      case 'struct_item':
      case 'enum_item':
      case 'type_item':
      case 'trait_item': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          addBinding(bindings, {
            name: nameNode.text,
            kind: 'type_declaration',
            origin: 'local',
            sourceModule: null,
            sourceName: null,
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            scopeDepth,
            byteStart: node.startIndex,
            byteEnd: node.endIndex,
          });
        }
        break;
      }

      // ── Impl block ─────────────────────────────────────────
      case 'impl_item': {
        // Walk the body for method declarations
        const body = node.childForFieldName('body');
        if (body) {
          walkChildren(body, scopeDepth + 1);
        }
        return;
      }

      // ── Let bindings ───────────────────────────────────────
      case 'let_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode && nameNode.type === 'identifier') {
          addBinding(bindings, {
            name: nameNode.text,
            kind: 'let_binding',
            origin: 'local',
            sourceModule: null,
            sourceName: null,
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            scopeDepth,
            byteStart: nameNode.startIndex,
            byteEnd: nameNode.endIndex,
          });
        }
        break;
      }

      default:
        break;
    }

    walkChildren(node, scopeDepth);
  }

  function walkChildren(node, depth) {
    if (!node) {
      return;
    }
    let child = node.firstChild;
    while (child) {
      walk(child, depth);
      child = child.nextSibling;
    }
  }

  function handleUseDeclaration(node) {
    const lineNum = node.startPosition.row + 1,
      endLine = node.endPosition.row + 1,
      // Use foo::bar::baz
      // Use foo::bar::{Baz, Qux}
      arg = node.childForFieldName('argument');
    if (!arg) {
      return;
    }

    extractUsePath(arg, lineNum, endLine);
  }

  function extractUsePath(node, lineNum, endLine) {
    if (node.type === 'use_list') {
      // Use foo::{bar, baz}
      let child = node.firstChild;
      while (child) {
        if (child.type !== ',' && child.type !== '{' && child.type !== '}') {
          extractUsePath(child, lineNum, endLine);
        }
        child = child.nextSibling;
      }
    } else if (node.type === 'scoped_identifier' || node.type === 'identifier') {
      const fullPath = node.text,
        isInternal = fullPath.startsWith('crate::') || fullPath.startsWith('self::') || fullPath.startsWith('super::'),
        parts = fullPath.split('::'),
        lastName = parts[parts.length - 1];

      addBinding(bindings, {
        name: lastName,
        kind: 'use',
        origin: isInternal ? 'internal_module' : 'external_package',
        sourceModule: fullPath,
        sourceName: lastName,
        lineStart: lineNum,
        lineEnd: endLine,
        scopeDepth: 0,
        byteStart: node.startIndex,
        byteEnd: node.endIndex,
      });
    } else if (node.type === 'use_wildcard') {
      // Use foo::*
      addBinding(bindings, {
        name: '*',
        kind: 'use',
        origin: 'unresolved',
        sourceModule: null,
        sourceName: '*',
        lineStart: lineNum,
        lineEnd: endLine,
        scopeDepth: 0,
        byteStart: node.startIndex,
        byteEnd: node.endIndex,
      });
    } else if (node.type === 'use_as_clause') {
      // Use foo::bar as baz
      const aliasNode = node.childForFieldName('alias'),
        nameNode = node.childForFieldName('name') || node.firstChild;
      if (aliasNode) {
        const path = nameNode ? nameNode.text : '',
          isInternal = path.startsWith('crate::') || path.startsWith('self::') || path.startsWith('super::');
        addBinding(bindings, {
          name: aliasNode.text,
          kind: 'use',
          origin: isInternal ? 'internal_module' : 'external_package',
          sourceModule: path,
          sourceName: path ? path.split('::').pop() : null,
          lineStart: lineNum,
          lineEnd: endLine,
          scopeDepth: 0,
          byteStart: node.startIndex,
          byteEnd: node.endIndex,
        });
      }
    }
  }

  function extractRustParameters(params, scopeDepth) {
    let child = params.firstChild;
    while (child) {
      if (child.type === 'parameter') {
        // Regular parameter: may have pattern and type
        const pattern = child.childForFieldName('pattern');
        if (pattern && pattern.type === 'identifier') {
          addBinding(bindings, {
            name: pattern.text,
            kind: 'parameter',
            origin: 'local',
            sourceModule: null,
            sourceName: null,
            lineStart: params.startPosition.row + 1,
            lineEnd: params.endPosition.row + 1,
            scopeDepth,
            byteStart: child.startIndex,
            byteEnd: child.endIndex,
          });
        }
      } else if (child.type === 'self_parameter') {
        // &self or self
        addBinding(bindings, {
          name: 'self',
          kind: 'parameter',
          origin: 'local',
          sourceModule: null,
          sourceName: null,
          lineStart: params.startPosition.row + 1,
          lineEnd: params.endPosition.row + 1,
          scopeDepth,
          byteStart: child.startIndex,
          byteEnd: child.endIndex,
        });
      } else if (child.type === 'variadic_parameter') {
        // .. (rust variadic)
      } else if (child.type === 'identifier') {
        addBinding(bindings, {
          name: child.text,
          kind: 'parameter',
          origin: 'local',
          sourceModule: null,
          sourceName: null,
          lineStart: params.startPosition.row + 1,
          lineEnd: params.endPosition.row + 1,
          scopeDepth,
          byteStart: child.startIndex,
          byteEnd: child.endIndex,
        });
      }
      child = child.nextSibling;
    }
  }

  if (tree && tree.rootNode) {
    walk(tree.rootNode, 0);
  }

  return dedupBindings(bindings);
}

module.exports = { buildRustScopeBindings };
