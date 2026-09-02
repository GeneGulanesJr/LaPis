// HTML scope builder — walks a tree-sitter AST for DOM-aware scope bindings.
// Covers: element_id, css_class, script_src, link_href, component_ref.

const { addBinding, dedupBindings } = require('./shared');

function getTagName(tagNode) {
  for (const ch of tagNode.children) {
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
      attrs.push({ name, value });
    }
  }
  return attrs;
}

function buildHtmlScopeBindingsAst(tree, _source) {
  const bindings = [],
    root = tree.rootNode;

  function walk(node, depth) {
    if (!node) {
      return;
    }

    if (node.type === 'element' || node.type === 'script_element' || node.type === 'style_element') {
      let startTag = null;
      for (const ch of node.children) {
        if (ch.type === 'start_tag' || ch.type === 'self_closing_tag') {
          startTag = ch;
          break;
        }
      }

      if (startTag) {
        const tagName = getTagName(startTag).toLowerCase(),
          attrs = getAttrs(startTag),
          sl = startTag.startPosition.row + 1,
          el = node.endPosition ? node.endPosition.row + 1 : sl,
          sb = startTag.startIndex,
          eb = node.endIndex,
        isCustom = (() => {

  
          for (const attr of attrs) {
            if (attr.name === 'id' && attr.value) {
              addBinding(bindings, {
                name: attr.value,
                kind: 'element_id',
                origin: 'local',
                sourceModule: null,
                sourceName: null,
                lineStart: sl,
                lineEnd: el,
                scopeDepth: depth,
                byteStart: sb,
                byteEnd: eb,
              });
            }
          }
  
          for (const attr of attrs) {
            if (attr.name === 'class' && attr.value) {
              for (const cls of attr.value.split(/\s+/).filter(Boolean)) {
                addBinding(bindings, {
                  name: cls,
                  kind: 'css_class',
                  origin: 'local',
                  sourceModule: null,
                  sourceName: null,
                  lineStart: sl,
                  lineEnd: el,
                  scopeDepth: depth,
                  byteStart: sb,
                  byteEnd: eb,
                });
              }
            }
          }
  
          if (tagName === 'script') {
            for (const attr of attrs) {
              if (attr.name === 'src' && attr.value) {
                addBinding(bindings, {
                  name: attr.value,
                  kind: 'script_src',
                  origin: 'external_file',
                  sourceModule: attr.value,
                  sourceName: null,
                  lineStart: sl,
                  lineEnd: el,
                  scopeDepth: depth,
                  byteStart: sb,
                  byteEnd: eb,
                });
              }
            }
          }
  
          if (tagName === 'link') {
            for (const attr of attrs) {
              if (attr.name === 'href' && attr.value) {
                addBinding(bindings, {
                  name: attr.value,
                  kind: 'link_href',
                  origin: 'external_file',
                  sourceModule: attr.value,
                  sourceName: null,
                  lineStart: sl,
                  lineEnd: sl,
                  scopeDepth: depth,
                  byteStart: sb,
                  byteEnd: eb,
                });
              }
            }
          }
  
          
  return (tagName.includes('-') || /^[A-Z]/.test(getTagName(startTag)));
})();if (isCustom) {
          addBinding(bindings, {
            name: getTagName(startTag),
            kind: 'component_ref',
            origin: 'local',
            sourceModule: null,
            sourceName: null,
            lineStart: sl,
            lineEnd: el,
            scopeDepth: depth,
            byteStart: sb,
            byteEnd: eb,
          });
        }
      }

      for (const ch of node.children) {
        if (ch.type === 'element' || ch.type === 'script_element' || ch.type === 'style_element') {
          walk(ch, depth + 1);
        }
      }
      return;
    }

    for (const ch of node.children) {
      walk(ch, depth);
    }
  }

  walk(root, 0);
  return dedupBindings(bindings);
}

function buildHtmlScopeBindingsRegex(source) {
  const bindings = [],
    lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i],
      lineNum = i + 1,
      scriptSrcMatch = line.match(/\bsrc\s*=\s*["']([^"']+)["']/i),
    idMatch = (() => {

      if (scriptSrcMatch && /<script/i.test(line)) {
        addBinding(bindings, {
          name: scriptSrcMatch[1],
          kind: 'script_src',
          origin: 'external_file',
          sourceModule: scriptSrcMatch[1],
          sourceName: null,
          lineStart: lineNum,
          lineEnd: lineNum,
          scopeDepth: 0,
          byteStart: null,
          byteEnd: null,
        });
      }
  
      
  return (line.match(/\bid\s*=\s*["']([^"']+)["']/i));
})(),
    classMatch = (() => {
if (idMatch) {
        addBinding(bindings, {
          name: idMatch[1],
          kind: 'element_id',
          origin: 'local',
          sourceModule: null,
          sourceName: null,
          lineStart: lineNum,
          lineEnd: lineNum,
          scopeDepth: 0,
          byteStart: null,
          byteEnd: null,
        });
      }
  
      
  return (line.match(/\bclass\s*=\s*["']([^"']+)["']/i));
})();if (classMatch) {
      for (const cls of classMatch[1].split(/\s+/).filter(Boolean)) {
        addBinding(bindings, {
          name: cls,
          kind: 'css_class',
          origin: 'local',
          sourceModule: null,
          sourceName: null,
          lineStart: lineNum,
          lineEnd: lineNum,
          scopeDepth: 0,
          byteStart: null,
          byteEnd: null,
        });
      }
    }
  }
  return dedupBindings(bindings);
}

function buildHtmlScopeBindings(tree, source, _filePath) {
  if (tree && tree.rootNode && typeof tree.rootNode.childCount === 'number') {
    return buildHtmlScopeBindingsAst(tree, source);
  }
  return buildHtmlScopeBindingsRegex(source);
}

module.exports = { buildHtmlScopeBindings };
