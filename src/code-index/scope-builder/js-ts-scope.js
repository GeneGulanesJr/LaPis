// JS/TS scope builder — walks a tree-sitter AST and extracts scope bindings.
// Covers: named_import, default_import, namespace_import, require, destructure_import,
//         Re-export, declaration, destructure_local, parameter, class_member, dynamic_import.

const { addBinding, dedupBindings } = require('./shared');

/**
 * Build scope bindings from a tree-sitter AST for JS/TS files.
 * @param {object} tree - tree-sitter tree
 * @param {string} source - source code
 * @param {string} [_filePath] - reserved/unused (kept for builder-map arity parity)
 * @returns {Array} array of binding objects
 */
function buildJsTsScopeBindings(tree, source, _filePath) {
  const bindings = [];

  function walk(node, scopeDepth, lineStart, lineEnd) {
    if (!node) {
      return;
    }

    const type = node.type,
      // Track scope boundaries
      currentDepth = scopeDepth,
      currentLineStart = lineStart,
      currentLineEnd = lineEnd;

    switch (type) {
      // ── Import statements ──────────────────────────────────
      case 'import_statement': {
        handleImportStatement(node);
        break;
      }

      // ── Re-exports ─────────────────────────────────────────
      case 'export_statement': {
        handleExportStatement(node);
        break;
      }

      // ── Function/arrow declarations ────────────────────────
      case 'function_declaration':
      case 'function':
      case 'generator_function':
      case 'generator_function_declaration': {
        const nameNode = node.childForFieldName('name'),
          params = (() => {
            if (nameNode) {
              const startLine = node.startPosition.row + 1,
                endLine = node.endPosition.row + 1;
              addBinding(bindings, {
                name: nameNode.text,
                kind: 'declaration',
                origin: 'local',
                sourceModule: null,
                sourceName: null,
                lineStart: startLine,
                lineEnd: endLine,
                scopeDepth: currentDepth,
                byteStart: node.startIndex,
                byteEnd: node.endIndex,
              });
            }
            // Parameters create bindings at function scope

            return node.childForFieldName('parameters');
          })(),
          body = (() => {
            if (params) {
              extractParameters(params, currentDepth + 1, node.startPosition.row + 1, node.endPosition.row + 1);
            }
            // Body creates deeper scope

            return node.childForFieldName('body');
          })();
        if (body) {
          walkChildren(body, currentDepth + 1, node.startPosition.row + 1, node.endPosition.row + 1);
        }
        return; // Don't walk children again
      }

      // ── Arrow functions ────────────────────────────────────
      case 'arrow_function': {
        const params = node.childForFieldName('parameters'),
          body = (() => {
            if (params) {
              extractParameters(params, currentDepth + 1, node.startPosition.row + 1, node.endPosition.row + 1);
            }

            return node.childForFieldName('body');
          })();
        if (body) {
          walkChildren(body, currentDepth + 1, node.startPosition.row + 1, node.endPosition.row + 1);
        }
        return;
      }

      // ── Variable declarations ──────────────────────────────
      case 'variable_declarator': {
        handleVariableDeclarator(node, currentDepth);
        // Walk the value for nested functions
        const value = node.childForFieldName('value');
        if (value) {
          walk(value, currentDepth, currentLineStart, currentLineEnd);
        }
        return;
      }

      case 'lexical_declaration':
      case 'variable_declaration': {
        // Walk children (variable_declarator nodes)
        walkChildren(node, currentDepth, currentLineStart, currentLineEnd);
        return;
      }

      // ── Class declarations ─────────────────────────────────
      case 'class_declaration':
      case 'class': {
        const nameNode = node.childForFieldName('name'),
          body = (() => {
            if (nameNode) {
              addBinding(bindings, {
                name: nameNode.text,
                kind: 'declaration',
                origin: 'local',
                sourceModule: null,
                sourceName: null,
                lineStart: node.startPosition.row + 1,
                lineEnd: node.endPosition.row + 1,
                scopeDepth: currentDepth,
                byteStart: node.startIndex,
                byteEnd: node.endIndex,
              });
            }
            // Walk class body for methods

            return node.childForFieldName('body');
          })();
        if (body) {
          walkClassBody(body, currentDepth + 1);
        }
        return;
      }

      // ── Method definitions in classes ──────────────────────
      case 'method_definition':
      case 'public_field_definition':
      case 'private_field_definition':
      case 'abstract_method_signature':
      case 'method_signature': {
        const nameNode = node.childForFieldName('name'),
          params = (() => {
            if (nameNode) {
              addBinding(bindings, {
                name: nameNode.text,
                kind: 'class_member',
                origin: 'local',
                sourceModule: null,
                sourceName: null,
                lineStart: node.startPosition.row + 1,
                lineEnd: node.endPosition.row + 1,
                scopeDepth: currentDepth,
                byteStart: node.startIndex,
                byteEnd: node.endIndex,
              });
            }
            // Parameters in methods

            return node.childForFieldName('parameters');
          })(),
          body = (() => {
            if (params) {
              extractParameters(params, currentDepth + 1, node.startPosition.row + 1, node.endPosition.row + 1);
            }

            return node.childForFieldName('body');
          })();
        if (body) {
          walkChildren(body, currentDepth + 1, node.startPosition.row + 1, node.endPosition.row + 1);
        }
        return;
      }

      // ── For loops (let/const in loop creates block scope) ──
      case 'for_statement':
      case 'for_in_statement':
      case 'for_of_statement': {
        // Walk the initializer which may contain variable declarations
        walkChildren(node, currentDepth + 1, node.startPosition.row + 1, node.endPosition.row + 1);
        return;
      }

      // ── Block scope ────────────────────────────────────────
      case 'statement_block':
      case 'block': {
        walkChildren(node, currentDepth + 1, node.startPosition.row + 1, node.endPosition.row + 1);
        return;
      }

      // ── Catch clause (error variable) ──────────────────────
      case 'catch_clause': {
        // Walk body, not the catch binding (error variable is a minor scope feature)
        const body = node.childForFieldName('body');
        if (body) {
          walkChildren(body, currentDepth + 1, node.startPosition.row + 1, node.endPosition.row + 1);
        }
        return;
      }

      default:
        break;
    }

    // Default: walk children at same scope depth
    walkChildren(node, currentDepth, currentLineStart, currentLineEnd);
  }

  function walkChildren(node, depth, lineStart, lineEnd) {
    if (!node) {
      return;
    }
    let child = node.firstChild;
    while (child) {
      walk(child, depth, lineStart, lineEnd);
      child = child.nextNamedSibling || child.nextSibling;
    }
  }

  function walkClassBody(body, depth) {
    let child = body.firstChild;
    while (child) {
      const type = child.type;
      if (
        type === 'method_definition' ||
        type === 'public_field_definition' ||
        type === 'private_field_definition' ||
        type === 'abstract_method_signature' ||
        type === 'method_signature' ||
        type === 'static_block' ||
        type === 'getter_definition' ||
        type === 'setter_definition'
      ) {
        walk(child, depth, body.startPosition.row + 1, body.endPosition.row + 1);
      }
      child = child.nextSibling;
    }
  }

  // ── Import handling ─────────────────────────────────────

  function handleImportStatement(node) {
    const lineNum = node.startPosition.row + 1,
      endLine = node.endPosition.row + 1,
      // Find the source module
      sourceStr = findStringNode(node),
      modulePath = sourceStr ? sourceStr : undefined,
      isPackage = sourceStr ? !modulePath.startsWith('.') && !modulePath.startsWith('/') : undefined,
      _hasDefaultImport = false,
      _hasNamespaceImport = false,
      _hasNamedImports = false;
    if (!sourceStr) {
      return;
    }

    // Check for default import: import foo from '...'
    let child = node.firstChild;

    while (child) {
      const t = child.type;
      if (t === 'identifier') {
        // Default import: import foo from '...'
        hasDefaultImport = true;
        addBinding(bindings, {
          name: child.text,
          kind: 'default_import',
          origin: isPackage ? 'external_package' : 'external_file',
          sourceModule: modulePath,
          sourceName: 'default',
          lineStart: lineNum,
          lineEnd: endLine,
          scopeDepth: 0,
          byteStart: child.startIndex,
          byteEnd: child.endIndex,
        });
      } else if (t === 'namespace_import' || t === 'import_namespace_clause') {
        // Import * as foo from '...'
        hasNamespaceImport = true;
        const nameNode = child.childForFieldName('name') || findIdentifierNode(child);
        if (nameNode) {
          addBinding(bindings, {
            name: nameNode.text,
            kind: 'namespace_import',
            origin: isPackage ? 'external_package' : 'external_file',
            sourceModule: modulePath,
            sourceName: '*',
            lineStart: lineNum,
            lineEnd: endLine,
            scopeDepth: 0,
            byteStart: nameNode.startIndex,
            byteEnd: nameNode.endIndex,
          });
        }
      } else if (t === 'named_imports' || t === 'import_clause') {
        // Handle the import_clause which may contain named_imports, default, or namespace
        handleImportClause(child, modulePath, isPackage, lineNum, endLine);
      }
      child = child.nextSibling;
    }
  }

  function handleImportClause(clause, modulePath, isPackage, lineNum, endLine) {
    let child = clause.firstChild;
    while (child) {
      const t = child.type;
      if (t === 'identifier') {
        // Default import inside clause (shouldn't normally happen, but handle it)
        addBinding(bindings, {
          name: child.text,
          kind: 'default_import',
          origin: isPackage ? 'external_package' : 'external_file',
          sourceModule: modulePath,
          sourceName: 'default',
          lineStart: lineNum,
          lineEnd: endLine,
          scopeDepth: 0,
          byteStart: child.startIndex,
          byteEnd: child.endIndex,
        });
      } else if (t === 'named_imports') {
        // { foo, bar as baz }
        let specChild = child.firstChild;
        while (specChild) {
          if (specChild.type === 'import_specifier') {
            const nameNode = specChild.childForFieldName('name'),
              // The alias (as clause) uses 'alias' field in some grammars
              aliasNode = specChild.childForFieldName('alias');
            let localName = null;
            if (aliasNode) {
              localName = aliasNode.text;
            } else if (nameNode) {
              localName = nameNode.text;
            }
            {
              const originalName = nameNode ? nameNode.text : localName;
              if (localName) {
                addBinding(bindings, {
                  name: localName,
                  kind: 'named_import',
                  origin: isPackage ? 'external_package' : 'external_file',
                  sourceModule: modulePath,
                  sourceName: originalName,
                  lineStart: lineNum,
                  lineEnd: endLine,
                  scopeDepth: 0,
                  byteStart: specChild.startIndex,
                  byteEnd: specChild.endIndex,
                });
              }
            }
          }
          specChild = specChild.nextSibling;
        }
      } else if (t === 'namespace_import') {
        const nameNode = child.childForFieldName('name') || findIdentifierNode(child);
        if (nameNode) {
          addBinding(bindings, {
            name: nameNode.text,
            kind: 'namespace_import',
            origin: isPackage ? 'external_package' : 'external_file',
            sourceModule: modulePath,
            sourceName: '*',
            lineStart: lineNum,
            lineEnd: endLine,
            scopeDepth: 0,
            byteStart: nameNode.startIndex,
            byteEnd: nameNode.endIndex,
          });
        }
      }
      child = child.nextSibling;
    }
  }

  function handleExportStatement(node) {
    const lineNum = node.startPosition.row + 1,
      endLine = node.endPosition.row + 1;

    // Check for re-export: export { foo } from './bar'
    let child = node.firstChild;
    while (child) {
      if (child.type === 'export_clause') {
        // Check if there's a 'from' clause — if so, it's a re-export
        const sourceStr = findStringNode(node);
        if (sourceStr) {
          const isPackage = !sourceStr.startsWith('.') && !sourceStr.startsWith('/');
          let specChild = child.firstChild;
          while (specChild) {
            if (specChild.type === 'export_specifier') {
              const nameNode = specChild.childForFieldName('name'),
                aliasNode = specChild.childForFieldName('alias'),
                localName = nameNode ? nameNode.text : null,
                exportedName = aliasNode ? aliasNode.text : localName;
              if (exportedName) {
                addBinding(bindings, {
                  name: exportedName,
                  kind: 're_export',
                  origin: isPackage ? 'external_package' : 'external_file',
                  sourceModule: sourceStr,
                  sourceName: localName,
                  lineStart: lineNum,
                  lineEnd: endLine,
                  scopeDepth: 0,
                  byteStart: specChild.startIndex,
                  byteEnd: specChild.endIndex,
                });
              }
            }
            specChild = specChild.nextSibling;
          }
        }
      }
      // Export * from '...'
      if (child.type === 'export_all_clause' || child.type === 'namespace_import') {
        // Re-export all — we don't enumerate individual names at parse time
        // This is handled by the multi-pass resolver
      }
      // Export default function foo() — extract foo as declaration
      if (
        child.type === 'function_declaration' ||
        child.type === 'class_declaration' ||
        child.type === 'arrow_function'
      ) {
        walk(child, 0, lineNum, endLine);
        return;
      }
      // Export { foo } (without from) — just an export marker, the binding exists from declaration
      child = child.nextSibling;
    }
  }

  function handleVariableDeclarator(node, scopeDepth) {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) {
      return;
    }

    const lineNum = node.startPosition.row + 1,
      endLine = node.endPosition.row + 1,
      // Check if the value is a require() call
      value = node.childForFieldName('value'),
      requireInfo = value ? extractRequireInfo(value) : null;

    if (nameNode.type === 'identifier') {
      if (requireInfo) {
        addBinding(bindings, {
          name: nameNode.text,
          kind: 'require',
          origin: requireInfo.isPackage ? 'external_package' : 'external_file',
          sourceModule: requireInfo.modulePath,
          sourceName: '*',
          lineStart: lineNum,
          lineEnd: endLine,
          scopeDepth,
          byteStart: nameNode.startIndex,
          byteEnd: nameNode.endIndex,
        });
      } else {
        addBinding(bindings, {
          name: nameNode.text,
          kind: 'declaration',
          origin: 'local',
          sourceModule: null,
          sourceName: null,
          lineStart: lineNum,
          lineEnd: endLine,
          scopeDepth,
          byteStart: nameNode.startIndex,
          byteEnd: nameNode.endIndex,
        });
      }
    } else if (nameNode.type === 'object_pattern') {
      // Const { foo, bar } = require('./baz') or const { foo, bar } = obj
      const destructureInfo = value ? extractRequireInfo(value) : null;
      extractDestructuredBindings(nameNode, scopeDepth, lineNum, endLine, destructureInfo);
    } else if (nameNode.type === 'array_pattern') {
      // Const [a, b] = ...
      extractArrayDestructure(nameNode, scopeDepth, lineNum, endLine, requireInfo);
    }
  }

  function destructureOrigin(requireInfo) {
    if (!requireInfo) {
      return 'local';
    }
    return requireInfo.isPackage ? 'external_package' : 'external_file';
  }

  function extractDestructuredBindings(pattern, scopeDepth, lineNum, endLine, requireInfo) {
    let child = pattern.firstChild;
    while (child) {
      if (child.type === 'shorthand_property_identifier' || child.type === 'property_identifier') {
        const kind = requireInfo ? 'destructure_import' : 'destructure_local',
          origin = destructureOrigin(requireInfo);
        addBinding(bindings, {
          name: child.text,
          kind,
          origin,
          sourceModule: requireInfo ? requireInfo.modulePath : null,
          sourceName: requireInfo ? child.text : null,
          lineStart: lineNum,
          lineEnd: endLine,
          scopeDepth,
          byteStart: child.startIndex,
          byteEnd: child.endIndex,
        });
      } else if (child.type === 'pair_pattern') {
        // { foo: bar } — the value is the local name
        const valueNode = child.childForFieldName('value'),
          keyNode = child.childForFieldName('key');
        if (valueNode && valueNode.type === 'identifier') {
          const kind = requireInfo ? 'destructure_import' : 'destructure_local',
            origin = destructureOrigin(requireInfo);
          addBinding(bindings, {
            name: valueNode.text,
            kind,
            origin,
            sourceModule: requireInfo ? requireInfo.modulePath : null,
            sourceName: keyNode ? keyNode.text : null,
            lineStart: lineNum,
            lineEnd: endLine,
            scopeDepth,
            byteStart: child.startIndex,
            byteEnd: child.endIndex,
          });
        }
      } else if (child.type === 'rest_pattern') {
        // ...rest
        const nameNode = child.childForFieldName('name') || findIdentifierNode(child);
        if (nameNode) {
          const kind = requireInfo ? 'destructure_import' : 'destructure_local',
            origin = destructureOrigin(requireInfo);
          addBinding(bindings, {
            name: nameNode.text,
            kind,
            origin,
            sourceModule: requireInfo ? requireInfo.modulePath : null,
            sourceName: null,
            lineStart: lineNum,
            lineEnd: endLine,
            scopeDepth,
            byteStart: child.startIndex,
            byteEnd: child.endIndex,
          });
        }
      }
      child = child.nextSibling;
    }
  }

  function extractArrayDestructure(pattern, scopeDepth, lineNum, endLine, requireInfo) {
    let child = pattern.firstChild;
    while (child) {
      if (child.type === 'identifier') {
        const kind = requireInfo ? 'destructure_import' : 'destructure_local',
          origin = destructureOrigin(requireInfo);
        addBinding(bindings, {
          name: child.text,
          kind,
          origin,
          sourceModule: requireInfo ? requireInfo.modulePath : null,
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

  function extractParameters(params, scopeDepth, lineStart, lineEnd) {
    let child = params.firstChild;
    while (child) {
      if (child.type === 'identifier') {
        addBinding(bindings, {
          name: child.text,
          kind: 'parameter',
          origin: 'local',
          sourceModule: null,
          sourceName: null,
          lineStart,
          lineEnd,
          scopeDepth,
          byteStart: child.startIndex,
          byteEnd: child.endIndex,
        });
      } else if (child.type === 'rest_pattern') {
        const nameNode = child.childForFieldName('name') || findIdentifierNode(child);
        if (nameNode) {
          addBinding(bindings, {
            name: nameNode.text,
            kind: 'parameter',
            origin: 'local',
            sourceModule: null,
            sourceName: null,
            lineStart,
            lineEnd,
            scopeDepth,
            byteStart: child.startIndex,
            byteEnd: child.endIndex,
          });
        }
      } else if (child.type === 'object_pattern') {
        extractDestructuredBindings(child, scopeDepth, lineStart, lineEnd, null);
      } else if (child.type === 'array_pattern') {
        extractArrayDestructure(child, scopeDepth, lineStart, lineEnd, null);
      } else if (child.type === 'assignment_pattern') {
        // Default parameter: foo = 'bar' — the name is the left side
        const left = child.childForFieldName('left') || child.firstChild;
        if (left && left.type === 'identifier') {
          addBinding(bindings, {
            name: left.text,
            kind: 'parameter',
            origin: 'local',
            sourceModule: null,
            sourceName: null,
            lineStart,
            lineEnd,
            scopeDepth,
            byteStart: child.startIndex,
            byteEnd: child.endIndex,
          });
        } else if (left && left.type === 'object_pattern') {
          extractDestructuredBindings(left, scopeDepth, lineStart, lineEnd, null);
        }
      } else if (child.type === 'type_annotation' || child.type === 'optional_type_annotation') {
        // TypeScript: skip type annotations in parameter lists
      }
      child = child.nextSibling;
    }
  }

  // ── Helper: find a string literal node ─────────────────

  function findStringNode(node) {
    let child = node.firstChild;
    while (child) {
      if (child.type === 'string' || child.type === 'string_literal') {
        // Strip quotes
        const text = child.text;
        return text.slice(1, -1);
      }
      const found = findStringNode(child);
      if (found) {
        return found;
      }
      child = child.nextSibling;
    }
    return null;
  }

  function findIdentifierNode(node) {
    let child = node.firstChild;
    while (child) {
      if (child.type === 'identifier') {
        return child;
      }
      const found = findIdentifierNode(child);
      if (found) {
        return found;
      }
      child = child.nextSibling;
    }
    return null;
  }

  function extractRequireInfo(valueNode) {
    // Check if this is a require('...') call
    if (valueNode.type === 'call_expression') {
      const func = valueNode.childForFieldName('function');
      if (func && func.type === 'identifier' && func.text === 'require') {
        const args = valueNode.childForFieldName('arguments');
        if (args) {
          const firstArg = args.namedChildren ? args.namedChildren[0] : null;
          if (!firstArg) {
            let child = args.firstChild;
            while (child) {
              if (child.type === 'string' || child.type === 'string_literal') {
                const modulePath = child.text.slice(1, -1),
                  isPackage = !modulePath.startsWith('.') && !modulePath.startsWith('/');
                return { modulePath, isPackage };
              }
              child = child.nextSibling;
            }
          } else if (firstArg.type === 'string' || firstArg.type === 'string_literal') {
            const modulePath = firstArg.text.slice(1, -1),
              isPackage = !modulePath.startsWith('.') && !modulePath.startsWith('/');
            return { modulePath, isPackage };
          }
        }
      }
    }
    return null;
  }

  // ── Main execution ─────────────────────────────────────

  if (tree && tree.rootNode) {
    walk(tree.rootNode, 0, 1, source.split('\n').length);
  }

  return dedupBindings(bindings);
}

module.exports = { buildJsTsScopeBindings };
