// Python scope builder — walks a tree-sitter AST and extracts scope bindings.
// Covers: named_import, from_import, wildcard_import, declaration, parameter,
//         Assignment, destructure, decorator.

const { addBinding, dedupBindings } = require('./shared');

function buildPythonScopeBindings(tree, _source, _filePath) {
  const bindings = [];

  function walk(node, scopeDepth) {
    if (!node) {
      return;
    }
    const type = node.type;

    switch (type) {
      // ── Import statements ──────────────────────────────────
      case 'import_statement': {
        handleImportStatement(node);
        break;
      }
      case 'import_from_statement': {
        handleFromImportStatement(node);
        break;
      }

      // ── Function declarations ──────────────────────────────
      case 'function_definition': {
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
          // Parameters
          
  return (node.childForFieldName('parameters'));
})(),
        body = (() => {
if (params) {
            extractPyParameters(params, scopeDepth + 1);
          }
          // Walk body at deeper scope
          
  return (node.childForFieldName('body'));
})();if (body) {
          walkChildren(body, scopeDepth + 1);
        }
        return;
      }

      // ── Class declarations ─────────────────────────────────
      case 'class_definition': {
        const nameNode = node.childForFieldName('name'),
        decorator = (() => {

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
          // Decorators
          
  return (node.childForFieldName('decorator'));
})(),
        body = (() => {
if (decorator) {
            handleDecorator(decorator, bindings, scopeDepth);
          }
          
  return (node.childForFieldName('body'));
})();if (body) {
          walkChildren(body, scopeDepth + 1);
        }
        return;
      }

      // ── Decorated definition ───────────────────────────────
      case 'decorated_definition': {
        // Walk decorators then the definition
        walkChildren(node, scopeDepth);
        return;
      }

      // ── Decorator ──────────────────────────────────────────
      case 'decorator': {
        handleDecorator(node, scopeDepth);
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

  function handleImportStatement(node) {
    const lineNum = node.startPosition.row + 1,
      endLine = node.endPosition.row + 1;
    // Import foo, bar
    // Import foo as baz
    let child = node.firstChild;
    while (child) {
      if (child.type === 'dotted_name' || child.type === 'aliased_import') {
        if (child.type === 'aliased_import') {
          const nameNode = child.childForFieldName('alias') || findLastIdentifier(child),
            origNode = child.childForFieldName('name') || child.firstChild;
          if (nameNode) {
            addBinding(bindings, {
              name: nameNode.text,
              kind: 'named_import',
              origin: 'external_package',
              sourceModule: origNode ? origNode.text : null,
              sourceName: origNode ? origNode.text : null,
              lineStart: lineNum,
              lineEnd: endLine,
              scopeDepth: 0,
              byteStart: child.startIndex,
              byteEnd: child.endIndex,
            });
          }
        } else {
          addBinding(bindings, {
            name: child.text.split('.').pop(),
            kind: 'named_import',
            origin: 'external_package',
            sourceModule: child.text,
            sourceName: child.text.split('.').pop(),
            lineStart: lineNum,
            lineEnd: endLine,
            scopeDepth: 0,
            byteStart: child.startIndex,
            byteEnd: child.endIndex,
          });
        }
      }
      child = child.nextSibling;
    }
  }

  function handleFromImportStatement(node) {
    const lineNum = node.startPosition.row + 1,
      endLine = node.endPosition.row + 1,
      // Find module name: from foo.bar import baz
      moduleNode = node.childForFieldName('module_name'),
      modulePath = moduleNode ? moduleNode.text : null,
    isPackage = modulePath ? (!modulePath.startsWith('.')) : undefined;
    if (!modulePath) {
      return;
    }

    // Find imported names
    let child = node.firstChild;
    while (child) {
      if (child.type === 'wildcard_import') {
        // From foo import *
        addBinding(bindings, {
          name: '*',
          kind: 'wildcard_import',
          origin: isPackage ? 'external_package' : 'external_file',
          sourceModule: modulePath,
          sourceName: '*',
          lineStart: lineNum,
          lineEnd: endLine,
          scopeDepth: 0,
          byteStart: child.startIndex,
          byteEnd: child.endIndex,
        });
      } else if (child.type === 'dotted_name' || child.type === 'identifier') {
        // Simple import name (not wildcard, not module_name)
        if (!moduleNode || child.id !== moduleNode.id) {
          addBinding(bindings, {
            name: child.text,
            kind: 'named_import',
            origin: isPackage ? 'external_package' : 'external_file',
            sourceModule: modulePath,
            sourceName: child.text,
            lineStart: lineNum,
            lineEnd: endLine,
            scopeDepth: 0,
            byteStart: child.startIndex,
            byteEnd: child.endIndex,
          });
        }
      } else if (child.type === 'aliased_import') {
        const aliasNode = child.childForFieldName('alias') || findLastIdentifier(child),
          nameNode = child.childForFieldName('name') || child.firstChild;
        if (aliasNode) {
          addBinding(bindings, {
            name: aliasNode.text,
            kind: 'named_import',
            origin: isPackage ? 'external_package' : 'external_file',
            sourceModule: modulePath,
            sourceName: nameNode ? nameNode.text : null,
            lineStart: lineNum,
            lineEnd: endLine,
            scopeDepth: 0,
            byteStart: child.startIndex,
            byteEnd: child.endIndex,
          });
        }
      } else if (child.type === 'import_list' || child.type === 'parenthesized_import_list') {
        // Handle import lists: from foo import (bar, baz)
        let importChild = child.firstChild;
        while (importChild) {
          if (importChild.type === 'identifier') {
            addBinding(bindings, {
              name: importChild.text,
              kind: 'named_import',
              origin: isPackage ? 'external_package' : 'external_file',
              sourceModule: modulePath,
              sourceName: importChild.text,
              lineStart: lineNum,
              lineEnd: endLine,
              scopeDepth: 0,
              byteStart: importChild.startIndex,
              byteEnd: importChild.endIndex,
            });
          } else if (importChild.type === 'aliased_import') {
            const aliasNode = importChild.childForFieldName('alias') || findLastIdentifier(importChild),
              nameNode = importChild.childForFieldName('name') || importChild.firstChild;
            if (aliasNode) {
              addBinding(bindings, {
                name: aliasNode.text,
                kind: 'named_import',
                origin: isPackage ? 'external_package' : 'external_file',
                sourceModule: modulePath,
                sourceName: nameNode ? nameNode.text : null,
                lineStart: lineNum,
                lineEnd: endLine,
                scopeDepth: 0,
                byteStart: importChild.startIndex,
                byteEnd: importChild.endIndex,
              });
            }
          }
          importChild = importChild.nextSibling;
        }
      }
      child = child.nextSibling;
    }
  }

  function handleDecorator(node, scopeDepth) {
    // @some_decorator
    const lineNum = node.startPosition.row + 1,
      endLine = node.endPosition.row + 1;
    let child = node.firstChild;
    while (child) {
      if (child.type === 'identifier' || child.type === 'attribute') {
        const name = child.type === 'attribute' ? child.text.split('.').pop() : child.text;
        addBinding(bindings, {
          name,
          kind: 'decorator',
          origin: 'external_file',
          sourceModule: null,
          sourceName: null,
          lineStart: lineNum,
          lineEnd: endLine,
          scopeDepth,
          byteStart: child.startIndex,
          byteEnd: child.endIndex,
        });
      }
      child = child.nextSibling;
    }
  }

  function extractPyParameters(params, scopeDepth) {
    let child = params.firstChild;
    while (child) {
      if (child.type === 'identifier') {
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
      } else if (child.type === 'typed_parameter' || child.type === 'default_parameter') {
        const nameNode = child.childForFieldName('name') || child.firstChild;
        if (nameNode && nameNode.type === 'identifier') {
          addBinding(bindings, {
            name: nameNode.text,
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
      } else if (child.type === 'list_splat_pattern') {
        // *Args
        const nameNode = child.firstChild;
        if (nameNode && nameNode.type === 'identifier') {
          addBinding(bindings, {
            name: nameNode.text,
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
      } else if (child.type === 'dictionary_splat_pattern') {
        // **Kwargs
        const nameNode = child.firstChild;
        if (nameNode && nameNode.type === 'identifier') {
          addBinding(bindings, {
            name: nameNode.text,
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
      }
      child = child.nextSibling;
    }
  }

  function findLastIdentifier(node) {
    let last = null,
      child = node.firstChild;
    while (child) {
      if (child.type === 'identifier') {
        last = child;
      }
      child = child.nextSibling;
    }
    return last;
  }

  if (tree && tree.rootNode) {
    walk(tree.rootNode, 0);
  }

  return dedupBindings(bindings);
}

module.exports = { buildPythonScopeBindings };
