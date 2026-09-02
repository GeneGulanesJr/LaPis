/**
 * Ast-patterns.js — Anti-pattern detection via symbol body scanning
 *
 * 10 preset detectors + custom DSL for pattern queries.
 * Scans indexed symbol bodies against anti-pattern rules.
 * Hybrid: symbol body retrieval from indexed bytes + regex detection.
 */

// ══════════════════════════════════════════════════════════
// PRESET DETECTORS
// ══════════════════════════════════════════════════════════

const PRESET_DETECTORS = [
  {
    id: 'empty_catch',
    category: 'error_handling',
    description: 'catch block with empty body',
    severity: 'warning',
    detect(symbol, _db) {
      if (!symbol.body_preview) {
        return null;
      }
      // Match empty catch blocks: catch (...) { }
      const re = /catch\s*\([^)]*\)\s*\{\s*\}/g,
        matches = [...symbol.body_preview.matchAll(re)];
      if (matches.length === 0) {
        return null;
      }
      return {
        count: matches.length,
        lines: matches.map((m) => {
          const preceding = symbol.body_preview.substring(0, m.index);
          return preceding.split('\n').length + symbol.start_line - 1;
        }),
      };
    },
  },
  {
    id: 'empty_function',
    category: 'quality',
    description: 'Function with empty body — possible stub or forgotten implementation',
    severity: 'warning',
    detect(symbol, db) {
      // Check symbol_complexity for zero lines
      if (symbol.kind !== 'function' && symbol.kind !== 'method') {
        return null;
      }
      try {
        const row = db.prepare('SELECT lines_of_code FROM symbol_complexity WHERE symbol_id = ?').get(symbol.id);
        if (row && row.lines_of_code === 0) {
          return { lines_of_code: 0 };
        }
      } catch {}
      // Fallback: check body_preview
      if (symbol.body_preview != null && symbol.body_preview.trim().length === 0) {
        return { lines_of_code: 0 };
      }
      return null;
    },
  },
  {
    id: 'deeply_nested',
    category: 'complexity',
    description: 'Nesting depth ≥ 5',
    severity: 'warning',
    detect(symbol, db) {
      try {
        const row = db.prepare('SELECT nesting_depth FROM symbol_complexity WHERE symbol_id = ?').get(symbol.id);
        if (row && row.nesting_depth >= 5) {
          return { nesting_depth: row.nesting_depth };
        }
      } catch {}
      return null;
    },
  },
  {
    id: 'nested_loops',
    category: 'performance',
    description: '≥ 3 nested loops',
    severity: 'warning',
    detect(symbol, _db) {
      if (!symbol.body_preview) {
        return null;
      }
      // Count loop keywords at different indentation levels as rough nesting proxy
      const lines = symbol.body_preview.split('\n'),
        loopRe = /\b(for|while|do)\b/;
      let maxNesting = 0,
        currentNesting = 0;

      for (const line of lines) {
        const trimmed = line.trim();
        if (loopRe.test(trimmed)) {
          const indent = line.length - trimmed.length;
          if (indent > 0) {
            currentNesting++;
          } else {
            currentNesting = 1;
          }
          maxNesting = Math.max(maxNesting, currentNesting);
        }
      }
      if (maxNesting >= 3) {
        return { loop_nesting_depth: maxNesting };
      }
      return null;
    },
  },
  {
    id: 'god_function',
    category: 'complexity',
    description: 'Function body ≥ 100 lines',
    severity: 'info',
    detect(symbol, db) {
      try {
        const row = db.prepare('SELECT lines_of_code FROM symbol_complexity WHERE symbol_id = ?').get(symbol.id);
        if (row && row.lines_of_code >= 100) {
          return { lines_of_code: row.lines_of_code };
        }
      } catch {}
      // Fallback: compute from start/end lines
      const loc = symbol.end_line - symbol.start_line + 1;
      if (loc >= 100) {
        return { lines_of_code: loc };
      }
      return null;
    },
  },
  {
    id: 'eval_exec',
    category: 'security',
    description: 'Usage of eval(), Function(), or new Function()',
    severity: 'error',
    detect(symbol, _db) {
      if (!symbol.body_preview) {
        return null;
      }
      const patterns = [/\beval\s*\(/g, /\bnew\s+Function\s*\(/g, /\bFunction\s*\(/g],
        allMatches = [];
      for (const re of patterns) {
        const matches = [...symbol.body_preview.matchAll(re)];
        for (const m of matches) {
          const preceding = symbol.body_preview.substring(0, m.index),
            line = preceding.split('\n').length + symbol.start_line - 1;
          allMatches.push({ pattern: m[0], line });
        }
      }
      if (allMatches.length === 0) {
        return null;
      }
      return { occurrences: allMatches };
    },
  },
  {
    id: 'hardcoded_secret',
    category: 'security',
    description: 'Hardcoded strings matching password/api_key/secret patterns',
    severity: 'error',
    detect(symbol, _db) {
      if (!symbol.body_preview) {
        return null;
      }
      const secretRe = /(['"`])(.*?(?:password|api[_-]?key|secret|token).*?)\1/gi,
        matches = [...symbol.body_preview.matchAll(secretRe)];
      if (matches.length === 0) {
        return null;
      }
      return {
        occurrences: matches.map((m) => ({
          value: m[2].length > 40 ? `${m[2].substring(0, 40)}...` : m[2],
          line: symbol.body_preview.substring(0, m.index).split('\n').length + symbol.start_line - 1,
        })),
      };
    },
  },
  {
    id: 'todo_fixme',
    category: 'maintenance',
    description: 'TODO/FIXME/HACK comments',
    severity: 'info',
    detect(symbol, _db) {
      if (!symbol.body_preview) {
        return null;
      }
      const commentRe = /\/\/\s*(TODO|FIXME|HACK)\b[^\n]*/gi,
        matches = [...symbol.body_preview.matchAll(commentRe)];
      if (matches.length === 0) {
        return null;
      }
      return {
        items: matches.map((m) => ({
          type: m[1].toUpperCase(),
          text: m[0].trim(),
          line: symbol.body_preview.substring(0, m.index).split('\n').length + symbol.start_line - 1,
        })),
      };
    },
  },
  {
    id: 'magic_number',
    category: 'maintenance',
    description: 'Unexplained numeric literals (not 0, 1, -1, 2)',
    severity: 'info',
    detect(symbol, _db) {
      if (!symbol.body_preview) {
        return null;
      }
      // Match numeric literals that aren't common constants
      const numRe = /(?<![a-zA-Z0-9_.])(\d{2,}|[3-9]\b|(?<!\d)-[3-9]\b)(?![a-zA-Z0-9_.])/g,
        matches = [...symbol.body_preview.matchAll(numRe)],
        suspicious = !(matches.length === 0) ? matches.filter((m) => parseInt(m[0]) > 99) : undefined;
      if (matches.length === 0) {
        return null;
      }
      // Only flag if there are many or they're suspicious
      if (suspicious.length === 0 && matches.length < 5) {
        return null;
      }
      return {
        count: matches.length,
        notable: suspicious.slice(0, 5).map((m) => ({
          value: parseInt(m[0]),
          line: symbol.body_preview.substring(0, m.index).split('\n').length + symbol.start_line - 1,
        })),
      };
    },
  },
  {
    id: 'reassigned_param',
    category: 'quality',
    description: 'Function parameter reassigned within body',
    severity: 'warning',
    detect(symbol, _db) {
      if (!symbol.signature || !symbol.body_preview) {
        return null;
      }
      // Extract parameter names from signature
      const paramRe = /\(([^)]*)\)/,
        sigMatch = symbol.signature.match(paramRe),
        params = sigMatch
          ? sigMatch[1]
              .split(',')
              .map((p) => p.trim().split(/[:=]/)[0].trim())
              .filter(Boolean)
          : undefined,
        reassigned = sigMatch && !(params.length === 0) ? [] : undefined;
      if (!sigMatch) {
        return null;
      }

      if (params.length === 0) {
        return null;
      }

      for (const param of params) {
        const assignRe = new RegExp(`\\b${param}\\s*=(?!=)`, 'g'),
          matches = [...symbol.body_preview.matchAll(assignRe)];
        for (const m of matches) {
          const line = symbol.body_preview.substring(0, m.index).split('\n').length + symbol.start_line - 1;
          reassigned.push({ param, line });
        }
      }
      if (reassigned.length === 0) {
        return null;
      }
      return { reassigned };
    },
  },
];

// ══════════════════════════════════════════════════════════
// CUSTOM DSL PARSER
// ══════════════════════════════════════════════════════════

/**
 * Parse custom pattern string: "type:value"
 * Types: call, string, nesting, lines
 */
function parseCustomPattern(raw) {
  const colonIdx = raw.indexOf(':'),
    type = !(colonIdx === -1) ? raw.substring(0, colonIdx) : undefined,
    value = !(colonIdx === -1) ? raw.substring(colonIdx + 1) : undefined;
  if (colonIdx === -1) {
    return { error: `Invalid pattern: ${raw} (expected type:value)` };
  }

  switch (type) {
    case 'call': {
      const re = new RegExp(`\\b${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`, 'g');
      return {
        detect(symbol) {
          if (!symbol.body_preview) {
            return null;
          }
          const matches = [...symbol.body_preview.matchAll(re)];
          if (matches.length === 0) {
            return null;
          }
          return { count: matches.length };
        },
      };
    }
    case 'string': {
      let regex;
      try {
        regex = new RegExp(value, 'g');
      } catch (e) {
        return { error: `Invalid regex in string pattern: ${e.message}` };
      }
      return {
        detect(symbol) {
          if (!symbol.body_preview) {
            return null;
          }
          const matches = [...symbol.body_preview.matchAll(regex)];
          if (matches.length === 0) {
            return null;
          }
          return { count: matches.length };
        },
      };
    }
    case 'nesting': {
      const depth = parseInt(value);
      if (isNaN(depth)) {
        return { error: `Invalid nesting depth: ${value}` };
      }
      return {
        detect(symbol, db) {
          try {
            const row = db.prepare('SELECT nesting_depth FROM symbol_complexity WHERE symbol_id = ?').get(symbol.id);
            if (row && row.nesting_depth >= depth) {
              return { nesting_depth: row.nesting_depth };
            }
          } catch {}
          return null;
        },
      };
    }
    case 'lines': {
      const threshold = parseInt(value);
      if (isNaN(threshold)) {
        return { error: `Invalid line count: ${value}` };
      }
      return {
        detect(symbol) {
          const loc = symbol.end_line - symbol.start_line + 1;
          if (loc >= threshold) {
            return { lines_of_code: loc };
          }
          return null;
        },
      };
    }
    default:
      return { error: `Unknown pattern type: ${type}. Valid: call, string, nesting, lines` };
  }
}

// ══════════════════════════════════════════════════════════
// MAIN SCANNER
// ══════════════════════════════════════════════════════════

/**
 * Scan repo symbols against anti-pattern detectors.
 *
 * @param {object} db — SQLite handle
 * @param {number} repoId — code_repos.id
 * @param {object} opts
 * @param {string} [opts.category] — preset category filter (or 'all')
 * @param {string[]} [opts.patterns] — custom DSL patterns
 * @param {number} [opts.limit] — max results (default 200)
 * @returns {object} { matches, symbols_scanned, symbols_with_body, detectors_used };
 *                   the native-DB guard path also returns `error`.
 */
function scanAstPatterns(db, repoId, opts = {}) {
  const { category = 'all', patterns: customPatterns = [], limit = 200 } = opts,
    detectors = !(!db || typeof db.prepare !== 'function') ? [] : undefined;

  // Guard: require native db
  if (!db || typeof db.prepare !== 'function') {
    return {
      matches: [],
      symbols_scanned: 0,
      symbols_with_body: 0,
      detectors_used: 0,
      error: 'Native SQLite backend required',
    };
  }

  // Build detector list

  // Add preset detectors filtered by category
  for (const d of PRESET_DETECTORS) {
    if (category === 'all' || d.category === category) {
      detectors.push({ ...d, source: 'preset' });
    }
  }

  // Add custom DSL patterns
  for (const raw of customPatterns) {
    const parsed = parseCustomPattern(raw);
    if (!parsed.error) {
      detectors.push({
        id: `custom:${raw}`,
        category: 'custom',
        description: `Custom pattern: ${raw}`,
        severity: 'info',
        detect: parsed.detect,
        source: 'custom',
      });
    }
  }

  if (detectors.length === 0) {
    // Return empty if no detectors match the category
    return { matches: [], symbols_scanned: 0, detectors_used: 0 };
  }

  // Get all symbols in repo
  const symbols = db
      .prepare(
        'SELECT id, name, kind, body_preview, signature, start_line, end_line, file_path FROM code_symbols WHERE repo_id = ?',
      )
      .all(repoId),
    // Get symbol IDs with body data for confidence calculation
    symbolsWithBody = symbols.filter((s) => s.body_preview && s.body_preview.trim().length > 0),
    matches = [];

  for (const symbol of symbols) {
    for (const detector of detectors) {
      try {
        const result = detector.detect(symbol, db);
        if (result) {
          matches.push({
            symbol_id: symbol.id,
            symbol: symbol.name,
            kind: symbol.kind,
            file: symbol.file_path,
            line: symbol.start_line,
            detector: detector.id,
            category: detector.category,
            severity: detector.severity,
            description: detector.description,
            details: result,
            has_body: Boolean(symbol.body_preview),
          });

          if (matches.length >= limit) {
            break;
          }
        }
      } catch {
        // Skip detector errors for individual symbols
      }
    }
    if (matches.length >= limit) {
      break;
    }
  }

  return {
    matches,
    symbols_scanned: symbols.length,
    symbols_with_body: symbolsWithBody.length,
    detectors_used: detectors.length,
  };
}

// ══════════════════════════════════════════════════════════
// EXPORTS
// ══════════════════════════════════════════════════════════

module.exports = {
  PRESET_DETECTORS,
  scanAstPatterns,
  parseCustomPattern,
};
