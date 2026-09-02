// Go scope builder — walks a tree-sitter AST and extracts scope bindings.
// Covers: named_import, dot_import, declaration, receiver_param, type_declaration, var_declaration.

const { addBinding, dedupBindings } = require('./shared');

function buildGoScopeBindings(tree, _source, _filePath) {
  const bindings = [];

  function walk(node, scopeDepth) {
    if (!node) {
      return;
    }
    const type = node.type;

    switch (type) {
      // ── Import declarations ────────────────────────────────
      case 'import_declaration': {
        handleImportDeclaration(node);
        break;
      }

      // ── Function declarations ──────────────────────────────
      case 'function_declaration': {
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
            extractGoParameters(params, scopeDepth + 1);
          }
          
  return (node.childForFieldName('body'));
})();if (body) {
          walkChildren(body, scopeDepth + 1);
        }
        return;
      }

      // ── Method declarations ────────────────────────────────
      case 'method_declaration': {
        const nameNode = node.childForFieldName('name'),
        receiver = (() => {

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
          // Receiver
          
  return (node.childForFieldName('receiver'));
})();if (receiver) {
          extractGoReceiver(receiver, scopeDepth + 1);
        }
        const params = node.childForFieldName('parameters'),
        body = (() => {

          if (params) {
            extractGoParameters(params, scopeDepth + 1);
          }
          
  return (node.childForFieldName('body'));
})();if (body) {
          walkChildren(body, scopeDepth + 1);
        }
        return;
      }

      // ── Type declarations ──────────────────────────────────
      case 'type_declaration': {
        let child = node.firstChild;
        while (child) {
          if (child.type === 'type_spec') {
            const nameNode = child.childForFieldName('name');
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
                byteStart: child.startIndex,
                byteEnd: child.endIndex,
              });
            }
          }
          child = child.nextSibling;
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

  function handleImportDeclaration(node) {
    const lineNum = node.startPosition.row + 1,
      endLine = node.endPosition.row + 1;

    let child = node.firstChild;
    while (child) {
      if (child.type === 'import_spec') {
        handleImportSpec(child, lineNum, endLine);
      } else if (child.type === 'import_spec_list') {
        let specChild = child.firstChild;
        while (specChild) {
          if (specChild.type === 'import_spec') {
            handleImportSpec(specChild, lineNum, endLine);
          }
          specChild = specChild.nextSibling;
        }
      }
      child = child.nextSibling;
    }
  }

  function handleImportSpec(spec, lineNum, endLine) {
    const pathNode = spec.childForFieldName('path'),
    importPath = pathNode ? (pathNode.text.replace(/^"|"$/g, '')) : undefined,
    isInternal = pathNode ? (importPath.startsWith('./') || importPath.startsWith('../') || importPath.startsWith('/')) : undefined,
    nameNode = pathNode ? (spec.childForFieldName('name')) : undefined;
    if (!pathNode) {
      return;
    }
    if (nameNode) {
      const nameText = nameNode.text;
      if (nameText === '.') {
        // Dot import
        addBinding(bindings, {
          name: '*',
          kind: 'dot_import',
          origin: isInternal ? 'internal_package' : 'external_package',
          sourceModule: importPath,
          sourceName: '*',
          lineStart: lineNum,
          lineEnd: endLine,
          scopeDepth: 0,
          byteStart: spec.startIndex,
          byteEnd: spec.endIndex,
        });
      } else if (nameText === '_') {
        // Blank import — side effects only, no binding
      } else {
        // Aliased import
        addBinding(bindings, {
          name: nameText,
          kind: 'named_import',
          origin: isInternal ? 'internal_package' : 'external_package',
          sourceModule: importPath,
          sourceName: null,
          lineStart: lineNum,
          lineEnd: endLine,
          scopeDepth: 0,
          byteStart: spec.startIndex,
          byteEnd: spec.endIndex,
        });
      }
    } else {
      // Default import — package name inferred from path
      const pkgName = importPath.split('/').pop();
      addBinding(bindings, {
        name: pkgName,
        kind: 'named_import',
        origin: isInternal ? 'internal_package' : 'external_package',
        sourceModule: importPath,
        sourceName: null,
        lineStart: lineNum,
        lineEnd: endLine,
        scopeDepth: 0,
        byteStart: spec.startIndex,
        byteEnd: spec.endIndex,
      });
    }
  }

  function extractGoParameters(params, scopeDepth) {
    let child = params.firstChild;
    while (child) {
      if (child.type === 'parameter_list') {
        let paramChild = child.firstChild;
        while (paramChild) {
          if (paramChild.type === 'identifier') {
            addBinding(bindings, {
              name: paramChild.text,
              kind: 'parameter',
              origin: 'local',
              sourceModule: null,
              sourceName: null,
              lineStart: params.startPosition.row + 1,
              lineEnd: params.endPosition.row + 1,
              scopeDepth,
              byteStart: paramChild.startIndex,
              byteEnd: paramChild.endIndex,
            });
          } else if (paramChild.type === 'parameter_declaration') {
            const nameNode = paramChild.childForFieldName('name');
            if (nameNode) {
              addBinding(bindings, {
                name: nameNode.text,
                kind: 'parameter',
                origin: 'local',
                sourceModule: null,
                sourceName: null,
                lineStart: params.startPosition.row + 1,
                lineEnd: params.endPosition.row + 1,
                scopeDepth,
                byteStart: paramChild.startIndex,
                byteEnd: paramChild.endIndex,
              });
            }
          }
          paramChild = paramChild.nextSibling;
        }
      }
      child = child.nextSibling;
    }
  }

  function extractGoReceiver(receiver, scopeDepth) {
    // (r *Receiver) or (r Receiver)
    let child = receiver.firstChild;
    while (child) {
      if (child.type === 'parameter_list') {
        let paramChild = child.firstChild;
        while (paramChild) {
          if (paramChild.type === 'parameter_declaration') {
            const nameNode = paramChild.childForFieldName('name');
            if (nameNode) {
              addBinding(bindings, {
                name: nameNode.text,
                kind: 'receiver_param',
                origin: 'local',
                sourceModule: null,
                sourceName: null,
                lineStart: receiver.startPosition.row + 1,
                lineEnd: receiver.endPosition.row + 1,
                scopeDepth,
                byteStart: paramChild.startIndex,
                byteEnd: paramChild.endIndex,
              });
            }
          }
          paramChild = paramChild.nextSibling;
        }
      }
      child = child.nextSibling;
    }
  }

  if (tree && tree.rootNode) {
    walk(tree.rootNode, 0);
  }

  return dedupBindings(bindings);
}

module.exports = { buildGoScopeBindings };
