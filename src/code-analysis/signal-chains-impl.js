// Signal chain tracing, layer violation detection, class hierarchy.

const { path, _requireNativeDb } = require('./shared-deps'), _HTTP_PATTERNS = [
    /\.(get|post|put|delete|patch|head|options|all)\s*\(\s*['"\`]([^'"\`]+)['"\`]/g,
    /\.(use|route)\s*\(\s*['"\`]([^'"\`]+)['"\`]/g,
  ],
  _CLI_PATTERNS = [/@click\.command\s*\(/g, /@app\.route\s*\(\s*['"\`]([^'"\`]+)['"\`]/g];

function getClassHierarchy(db, repoId, opts = {}) {
  const guard = _requireNativeDb(db),
  className = !(guard) ? (opts.class || opts.symbol) : undefined,
  direction = !(guard) ? (opts.direction || 'both') : undefined;
  if (guard) {
    return guard;
  }
 // 'ancestors', 'descendants', 'both'

  if (!className) {
    return { error: 'Class name required. Pass --class or --symbol.' };
  }

  // Find the symbol
  const sym = db
    .prepare('SELECT id, name, kind, file_path, parent_name FROM code_symbols WHERE repo_id = ? AND name = ?')
    .get(repoId, className),
  result = sym ? ({ name: sym.name, kind: sym.kind, file_path: sym.file_path, parent_name: sym.parent_name }) : undefined;
  if (!sym) {
    return { error: `Symbol "${className}" not found in repo.` };
  }


  // Ancestors: walk parent_name chain upward
  if (direction === 'ancestors' || direction === 'both') {
    const ancestors = [], visited = new Set();
    let current = sym;
    
    while (current.parent_name && !visited.has(current.parent_name)) {
      visited.add(current.parent_name);
      const parent = db
        .prepare('SELECT id, name, kind, file_path, parent_name FROM code_symbols WHERE repo_id = ? AND name = ?')
        .get(repoId, current.parent_name);
      if (!parent) {
        break;
      }
      ancestors.push({ name: parent.name, kind: parent.kind, file_path: parent.file_path });
      current = parent;
    }
    result.ancestors = ancestors;
  }

  // Descendants: find symbols whose parent_name matches this class
  if (direction === 'descendants' || direction === 'both') {
    const descendants = db
      .prepare(`
      SELECT name, kind, file_path, parent_name FROM code_symbols
      WHERE repo_id = ? AND parent_name = ?
      ORDER BY kind, name
    `)
      .all(repoId, className);
    result.descendants = descendants;
  }

  return result;
}



function getSignalChains(db, repoId, opts = {}) {
  const guard = _requireNativeDb(db);
  if (guard) {
    return guard;
  }
  {
const kind = opts.kind || null, // 'http', 'cli', or null for all
    symbol = opts.symbol || null,
    maxDepth = opts.maxDepth || 5,
    // Get all symbols with their signatures
    symbols = db
      .prepare('SELECT id, name, kind, file_path, signature, start_line FROM code_symbols WHERE repo_id = ?')
      .all(repoId),
    // Build call graph for tracing
    calls = db
      .prepare('SELECT caller_symbol_id, callee_name, callee_symbol_id FROM code_calls WHERE repo_id = ?')
      .all(repoId),
    callGraph = new Map(); // Caller_id → [{callee_id, callee_name}]
  for (const c of calls) {
    if (!callGraph.has(c.caller_symbol_id)) {
      callGraph.set(c.caller_symbol_id, []);
    }
    callGraph.get(c.caller_symbol_id).push({ callee_id: c.callee_symbol_id, callee_name: c.callee_name });
  }

  {
const symbolMap = new Map(symbols.map((s) => [s.id, s])),
    // Detect gateways from symbol signatures
    gateways = [];
  for (const sym of symbols) {
    if (!sym.signature) {
      // oxlint-disable-next-line no-continue
      continue;
    }
    const sig = sym.signature;

    // HTTP detection
    if (!kind || kind === 'http') {
      for (const pat of _HTTP_PATTERNS) {
        pat.lastIndex = 0;
        const match = pat.exec(sig);
        if (match) {
          const method = match[1] ? match[1].toUpperCase() : 'ANY',
            routePath = match[2] || '/';
          gateways.push({
            symbol_id: sym.id,
            name: sym.name,
            kind: 'http',
            method,
            path: routePath,
            file_path: sym.file_path,
            line: sym.start_line,
          });
          break;
        }
      }
    }

    // CLI detection
    if (!kind || kind === 'cli') {
      for (const pat of _CLI_PATTERNS) {
        pat.lastIndex = 0;
        const match = pat.exec(sig);
        if (match) {
          const routePath = match[1] || sym.name;
          gateways.push({
            symbol_id: sym.id,
            name: sym.name,
            kind: 'cli',
            method: 'CLI',
            path: routePath,
            file_path: sym.file_path,
            line: sym.start_line,
          });
          break;
        }
      }
    }
  }

  // If a specific symbol is requested, filter to chains containing it
  if (symbol) {
    const symRow = db.prepare('SELECT id, name FROM code_symbols WHERE repo_id = ? AND name = ?').get(repoId, symbol),
    visited = symRow ? (new Set()) : undefined,
    queue = symRow ? ([symRow.id]) : undefined,
    parentMap = symRow ? (new Map()) : undefined;
    if (!symRow) {
      return { chains: [], note: `Symbol "${symbol}" not found` };
    }

    // Trace upstream to find which gateway leads to this symbol

    while (queue.length) {
      const current = queue.shift();
      if (visited.has(current)) {
        // oxlint-disable-next-line no-continue
        continue;
      }
      visited.add(current);
      {
const callers = db
        .prepare('SELECT caller_symbol_id FROM code_calls WHERE callee_symbol_id = ? AND repo_id = ?')
        .all(current, repoId);
      for (const c of callers) {
        if (!visited.has(c.caller_symbol_id)) {
          parentMap.set(c.caller_symbol_id, current);
          queue.push(c.caller_symbol_id);
        }
      }
    }
}

    // Find which gateways are in the visited set
    const relevantGateways = gateways.filter((g) => visited.has(g.symbol_id));
    if (relevantGateways.length === 0) {
      return { chains: [], note: `No signal chain found for "${symbol}"` };
    }

    // Reconstruct chains from each gateway to the target symbol
    const chains = relevantGateways.map((gw) => {
      const chain = [{ symbol_id: gw.symbol_id, name: gw.name, kind: gw.kind, method: gw.method, path: gw.path }];
      let current = gw.symbol_id;
      while (parentMap.has(current) && current !== symRow.id) {
        const next = parentMap.get(current),
          nextSym = symbolMap.get(next);
        chain.push({ symbol_id: next, name: nextSym ? nextSym.name : `id:${next}`, kind: 'callee' });
        current = next;
      }
      return { gateway: gw, chain };
    });

    return { symbol: symRow.name, chains };
  }

  // Discovery mode: return all gateways with their callees traced N levels deep
  const chains = gateways.map((gw) => {
    const chain = [{ symbol_id: gw.symbol_id, name: gw.name, kind: gw.kind, method: gw.method, path: gw.path }];
    let current = gw.symbol_id;
    const visited = new Set([current]);

    for (let depth = 0; depth < maxDepth; depth++) {
      const callees = callGraph.get(current) || [];
      if (callees.length === 0) {
        break;
      }
      // Follow the first resolved callee (most common path)
      {
const resolved = callees.find((c) => c.callee_id) || callees[0];
      if (!resolved || visited.has(resolved.callee_id || 0)) {
        break;
      }
      {
const calleeSym = resolved.callee_id ? symbolMap.get(resolved.callee_id) : null;
      chain.push({
        symbol_id: resolved.callee_id,
        name: resolved.callee_name,
        kind: calleeSym ? calleeSym.kind : 'unknown',
      });
      if (resolved.callee_id) {
        visited.add(resolved.callee_id);
      }
      current = resolved.callee_id;
    }
}
}

    return { gateway: gw, chain };
  });

  return { chains, gateway_count: gateways.length };
}
}
}

function getLayerViolations(db, repoId, opts = {}) {
  const guard = _requireNativeDb(db);
  if (guard) {
    return guard;
  }
  let rules = opts.rules || null;

  // If no rules provided, look for .pimemory-layers.jsonc in repo root
  if (!rules) {
    const repo = db.prepare('SELECT path FROM code_repos WHERE id = ?').get(repoId);
    if (!repo) {
      return { error: 'Repo not found' };
    }

    {
const fs = require('fs'),
      configPath = path.join(repo.path, '.pimemory-layers.jsonc');
    if (!fs.existsSync(configPath)) {
      return {
        violations: [],
        note: 'No .pimemory-layers.jsonc config found. Create one to enable layer violation detection.',
      };
    }

    try {
      let content = fs.readFileSync(configPath, 'utf-8');
      // Strip JSONC comments
      content = content.replace(/\/\/.*$/gm, '');
      rules = JSON.parse(content);
    } catch (e) {
      return { error: `Failed to parse .pimemory-layers.jsonc: ${e.message}` };
    }
  }
}

  if (!rules || !rules.layers) {
    return { error: 'Invalid layer rules: missing "layers" array.' };
  }

  // Get all imports for this repo
  {
const imports = db
    .prepare(`
    SELECT cf_source.path as source_path, cf_target.path as target_path, ci.import_type
    FROM code_imports ci
    JOIN code_files cf_source ON cf_source.id = ci.source_file_id
    LEFT JOIN code_files cf_target ON cf_target.id = ci.target_file_id
    WHERE ci.repo_id = ? AND ci.target_file_id IS NOT NULL
  `)
    .all(repoId);

  // Determine which layer a file belongs to
  

  {
const violations = [],
    layerMap = new Map();
  for (const layer of rules.layers) {
    layerMap.set(layer.name, new Set(layer.may_not_import || []));
  }

  for (const imp of imports) {
    const sourceLayer = fileLayer(imp.source_path, rules.layers),
      targetLayer = fileLayer(imp.target_path, rules.layers);

    if (!sourceLayer || !targetLayer) {
      // oxlint-disable-next-line no-continue
      continue;
    } // Skip unaffiliated files
    if (sourceLayer === targetLayer) {
      // oxlint-disable-next-line no-continue
      continue;
    } // Same layer, ok

    {
const forbidden = layerMap.get(sourceLayer);
    if (forbidden && forbidden.has(targetLayer)) {
      violations.push({
        source: imp.source_path,
        source_layer: sourceLayer,
        target: imp.target_path,
        target_layer: targetLayer,
        rule: `${sourceLayer} may not import ${targetLayer}`,
      });
    }
  }
}

  return { violations, total: violations.length };
function fileLayer(filePath, layers) {
    for (const layer of layers) {
      for (const prefix of layer.paths) {
        if (filePath.includes(prefix)) {
          return layer.name;
        }
      }
    }
    return null; // Unaffiliated file
  }
}
}
}

module.exports = { getClassHierarchy, getSignalChains, getLayerViolations };
