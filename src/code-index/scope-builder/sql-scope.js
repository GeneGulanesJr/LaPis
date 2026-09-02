// SQL scope builder — walks a tree-sitter AST and extracts scope bindings.
// Covers: table_ref, alias, cte, column_ref.

const { addBinding, dedupBindings } = require('./shared');

function buildSqlScopeBindings(tree, _source, _filePath) {
  const bindings = [];

  function walk(node, scopeDepth) {
    if (!node) {
      return;
    }
    const type = node.type;

    switch (type) {
      case 'cte': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          addBinding(bindings, {
            name: nameNode.text.replace(/[`"[\]]/g, ''),
            kind: 'cte',
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
      case 'table_reference':
      case 'object_reference': {
        // Extract table name from the reference
        const text = node.text.replace(/[`"[\]]/g, '').trim(),
          parts = text.split('.'),
          tableName = parts[parts.length - 1];
        if (tableName && !isSqlKeyword(tableName)) {
          addBinding(bindings, {
            name: tableName,
            kind: 'table_ref',
            origin: 'external',
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

  const SQL_KEYWORDS = new Set([
    'select',
    'from',
    'where',
    'join',
    'inner',
    'left',
    'right',
    'outer',
    'on',
    'and',
    'or',
    'not',
    'null',
    'is',
    'in',
    'exists',
    'between',
    'like',
    'as',
    'order',
    'by',
    'group',
    'having',
    'limit',
    'offset',
    'union',
    'all',
    'distinct',
    'insert',
    'into',
    'values',
    'update',
    'set',
    'delete',
    'create',
    'table',
    'drop',
    'alter',
    'add',
    'column',
    'index',
    'view',
    'if',
    'else',
    'end',
    'case',
    'when',
    'then',
    'asc',
    'desc',
    'primary',
    'key',
    'foreign',
    'references',
    'constraint',
    'default',
    'check',
    'unique',
    'with',
    'recursive',
    'returning',
  ]);

  function isSqlKeyword(name) {
    return SQL_KEYWORDS.has(name.toLowerCase());
  }

  if (tree && tree.rootNode) {
    walk(tree.rootNode, 0);
  }

  return dedupBindings(bindings);
}

module.exports = { buildSqlScopeBindings };
