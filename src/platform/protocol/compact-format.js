/**
 * Wire-format.js — Compact wire format (MUNCH encoding)
 *
 * Reduces token footprint of homogeneous list responses for Pi's context window.
 * Three modes: json (verbose, default), compact (CSV-packed), auto (use compact if ≥20% savings).
 *
 * Encoding rules:
 * 1. Homogeneous list of objects → tagged CSV with _header + pipe-delimited rows
 * 2. Path prefix interning when ≥3 rows share the same prefix
 * 3. Non-homogeneous results, single results, errors stay as JSON
 * 4. Cell type markers keep decode lossless:
 *    - null/undefined    → `` (empty)          decodes back to null
 *    - boolean           → `!true` / `!false`
 *    - number            → digits              decodes back to Number
 *    - ambiguous string  → `'` + value         decodes back to the literal string
 *    A string is ambiguous when it is empty, starts with the literal or
 *    boolean marker, looks numeric (decode would coerce it), or starts with
 *    an `@` prefix reference it did not receive from interning (decode would
 *    expand it). Everything else encodes verbatim.
 *
 * Lossless round-trip: decode(encode(obj)) === obj
 */

const { estimateTokens } = require('../../../utils');

// ══════════════════════════════════════════════════════════
// ESCAPE/UNESCAPE FOR PIPE DELIMITER
// ══════════════════════════════════════════════════════════

/**
 * Escape a value for pipe-delimited CSV.
 * Strategy: escape backslash first, then pipe.
 * Uses Unicode private-use area to avoid ambiguity: \\ -> \uE000, | -> \uE001.
 * This ensures round-trip is always lossless.
 */
function _escapePipe(val) {
  if (val == null) {
    return '';
  }
  const str = String(val);
  return str.replace(/\\/g, '\uE000').replace(/\|/g, '\uE001');
}

/**
 * Unescape a pipe-escaped value.
 * Reverse: \uE001 -> |, \uE000 -> \
 */
function _unescapePipe(val) {
  return val.replace(/\uE001/g, '|').replace(/\uE000/g, '\\');
}

// Marker prefixing a cell whose value must decode back as a literal string
// (as opposed to null / boolean / Number coercion).
const LITERAL_MARKER = "'";

/**
 * Encode a single cell value with its type marker (see file header).
 *
 * @param {*} val — raw cell value
 * @param {boolean} hasPrefixes — the column has a prefix map (a leading '@'
 *   would be expanded on decode)
 * @param {boolean} [interned] — the value was just rewritten by interning,
 *   so its leading '@' is intentional and must NOT be marker-escaped
 */
function _encodeCell(val, hasPrefixes, interned = false) {
  if (val == null) {
    return '';
  }
  if (typeof val === 'number') {
    return _escapePipe(String(val));
  }
  if (typeof val === 'boolean') {
    return val ? '!true' : '!false';
  }
  const str = String(val),
    ambiguous =
      str === '' ||
      str.startsWith(LITERAL_MARKER) ||
      str.startsWith('!') ||
      (hasPrefixes && !interned && str.startsWith('@')) ||
      (str.trim() !== '' && !isNaN(str));
  return (ambiguous ? LITERAL_MARKER : '') + _escapePipe(str);
}

/**
 * Decode a single cell value, reversing _encodeCell (and still accepting
 * legacy unmarked cells, which keep the pre-marker coercion behavior).
 */
function _decodeCell(val, prefixList) {
  if (val.startsWith(LITERAL_MARKER)) {
    return val.slice(1);
  }
  if (val === '!true') {
    return true;
  }
  if (val === '!false') {
    return false;
  }
  if (prefixList && val.startsWith('@')) {
    for (let idx = 0; idx < prefixList.length; idx++) {
      const marker = `@${idx}`;
      if (val.startsWith(marker)) {
        return prefixList[idx] + val.slice(marker.length);
      }
    }
  }
  if (val !== '' && val.trim() !== '' && !isNaN(val)) {
    return Number(val);
  }
  return val === '' ? null : val;
}

// ══════════════════════════════════════════════════════════
// COMPACT ENCODING
// ══════════════════════════════════════════════════════════

/**
 * Encode a homogeneous list of objects into compact format.
 *
 * @param {Array<object>} rows — list of homogeneous objects
 * @param {object} opts
 * @param {boolean} [opts.interning=true] — enable path prefix interning
 * @returns {{ _header: string[], _rows: string[], _prefixes?: object, _stripped?: string[], _hoisted?: object }}
 *          compact shape (no _meta); `_prefixes`, `_stripped`, and `_hoisted` are
 *          present only when interning, stripping, or hoisting occurred.
 */
function _encodeList(rows, opts = {}) {
  if (!rows || rows.length === 0) {
    return { _header: [], _rows: [] };
  }

  // Filter out stripped fields from header
  const stripSet = new Set(opts.stripFields || []),
    // Determine header from keys of first row (stable order)
    allKeys = Object.keys(rows[0]).filter((k) => !stripSet.has(k)),
    // Detect and hoist uniform columns (all rows have identical value)
    hoisted = {},
    header = allKeys.filter((col) => {
      const firstVal = JSON.stringify(rows[0][col]),
        allSame = rows.every((r) => JSON.stringify(r[col]) === firstVal);
      if (allSame && rows.length >= 2) {
        hoisted[col] = rows[0][col];
        return false;
      }
      return true;
    }),
    encodedRows = [],
    // Detect path-like columns for prefix interning
    pathColumns = opts.interning !== false ? _findPathColumns(rows, header) : {},
    prefixes = {},
    result = { _header: header, _rows: encodedRows },
    // Attach prefix map if we interned anything
    prefixMap = {};

  // Compute prefixes if any path columns found
  for (const col of Object.keys(pathColumns)) {
    prefixes[col] = _computePrefixes(rows.map((r) => r[col]));
  }

  for (const row of rows) {
    const parts = header.map((key) => {
      let val = row[key],
        interned = false;

      // Apply prefix interning
      if (prefixes[key] && typeof val === 'string') {
        for (const [idx, prefix] of Object.entries(prefixes[key])) {
          if (val.startsWith(`${prefix}/`)) {
            val = `@${idx}${val.slice(prefix.length)}`;
            interned = true;
            break;
          }
        }
      }

      return _encodeCell(val, Boolean(prefixes[key]), interned);
    });
    encodedRows.push(parts.join('|'));
  }

  for (const col of Object.keys(prefixes)) {
    if (prefixes[col].length > 0) {
      prefixMap[col] = prefixes[col];
    }
  }
  if (Object.keys(prefixMap).length > 0) {
    result._prefixes = prefixMap;
  }

  // Record stripped fields for round-trip
  if (stripSet.size > 0) {
    result._stripped = [...stripSet].filter((k) => Object.keys(rows[0]).includes(k));
  }

  // Attach hoisted uniform columns
  if (Object.keys(hoisted).length > 0) {
    result._hoisted = hoisted;
  }

  return result;
}

/**
 * Identify columns whose values look like file paths.
 * Returns { columnName: true } for columns where ≥3 rows share a common prefix.
 */
function _findPathColumns(rows, header) {
  const pathCols = {};
  for (const key of header) {
    const values = rows.map((r) => r[key]).filter((v) => typeof v === 'string');
    if (values.length >= 3) {
      // Check if values look like paths (contain '/' or are file paths)
      const pathLike = values.filter((v) => v.includes('/'));
      if (pathLike.length >= 3) {
        // Check if ≥3 share a common prefix of at least 2 segments
        const prefixes = _computePrefixes(values);
        if (Object.keys(prefixes).length > 0) {
          pathCols[key] = true;
        }
      }
    }
  }
  return pathCols;
}

/**
 * Compute common prefixes for a list of path-like strings.
 * Returns array of unique prefixes sorted by frequency (most common first).
 * A prefix is at least 2 path segments deep and shared by ≥3 values.
 */
function _computePrefixes(values) {
  const prefixCount = new Map();

  for (const val of values) {
    const parts = val.split('/');
    // Try prefixes from 2 segments up to all-but-one segments
    for (let i = 2; i < parts.length; i++) {
      const prefix = parts.slice(0, i).join('/');
      prefixCount.set(prefix, (prefixCount.get(prefix) || 0) + 1);
    }
  }

  // Filter: at least 3 occurrences
  {
    const qualifying = [...prefixCount.entries()].filter(([, count]) => count >= 3).sort((a, b) => b[1] - a[1]), // Most common first
      // Take top prefixes (max 5), avoiding overlaps: pick longer prefixes first
      selected = [],
      covered = new Set();
    for (const [prefix] of qualifying) {
      if (!covered.has(prefix)) {
        selected.push(prefix);
        // Mark all shorter prefixes that are substrings as covered
        for (const [other] of qualifying) {
          if (other !== prefix && prefix.startsWith(`${other}/`)) {
            covered.add(other);
          }
        }
        if (selected.length >= 5) {
          break;
        }
      }
    }

    return selected;
  }
}

// ══════════════════════════════════════════════════════════
// COMPACT DECODING
// ══════════════════════════════════════════════════════════

/**
 * Decode compact format back to original list of objects.
 *
 * @param {{ _header: string[], _rows: string[], _prefixes?: object }} compact
 * @returns {Array<object>} original rows
 */
function _decodeList(compact) {
  if (!compact || !compact._rows || compact._rows.length === 0) {
    return [];
  }

  const header = compact._header || [],
    prefixes = compact._prefixes || {};

  return compact._rows.map((row) => {
    const values = row.split('|').map((v) => _unescapePipe(v)),
      obj = {};
    header.forEach((key, i) => {
      obj[key] = _decodeCell(values[i] || '', prefixes[key]);
    });

    // Restore stripped fields as null
    if (compact._stripped) {
      for (const field of compact._stripped) {
        obj[field] = null;
      }
    }

    // Broadcast hoisted values back to row
    if (compact._hoisted) {
      for (const [key, val] of Object.entries(compact._hoisted)) {
        obj[key] = val;
      }
    }

    return obj;
  });
}

// ══════════════════════════════════════════════════════════
// HOMOGENEITY CHECK
// ══════════════════════════════════════════════════════════

/**
 * Check if a list is homogeneous (all objects have the same keys).
 */
function _isHomogeneous(arr) {
  if (!Array.isArray(arr) || arr.length < 2) {
    return false;
  }
  if (typeof arr[0] !== 'object' || arr[0] === null) {
    return false;
  }

  const keys = Object.keys(arr[0]).sort().join(',');
  for (let i = 1; i < arr.length; i++) {
    if (typeof arr[i] !== 'object' || arr[i] === null) {
      return false;
    }
    if (Object.keys(arr[i]).sort().join(',') !== keys) {
      return false;
    }
  }
  return true;
}

/**
 * Check that every column can be represented losslessly in a pipe-delimited
 * cell: either all its cells are primitives (or null), or the column is
 * uniform across rows (hoisted whole by _encodeList, preserving the object).
 * Columns mixing differing objects/arrays per row would be stringified
 * ("[object Object]") — such lists stay as JSON instead.
 */
function _isCompactable(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return true;
  }
  for (const key of Object.keys(rows[0])) {
    let allPrimitive = true,
      uniform = true;
    const first = JSON.stringify(rows[0][key]);
    for (const row of rows) {
      const v = row[key];
      if (!(v == null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
        allPrimitive = false;
      }
      if (JSON.stringify(v) !== first) {
        uniform = false;
      }
      if (!allPrimitive && !uniform) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Find the first array-like field in the data that's homogeneous.
 * Returns { key, rows } or null.
 */
function _findEncodableList(data) {
  if (!data || typeof data !== 'object') {
    return null;
  }

  // Try common container keys
  const candidates = [];
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value) && _isHomogeneous(value) && _isCompactable(value)) {
      candidates.push({ key, rows: value, len: value.length });
    }
  }

  // Return the largest homogeneous list
  if (candidates.length === 0) {
    return null;
  }
  candidates.sort((a, b) => b.len - a.len);
  return candidates[0];
}

// ══════════════════════════════════════════════════════════
// SIZE ESTIMATION
// ══════════════════════════════════════════════════════════

function _jsonSize(obj) {
  return JSON.stringify(obj).length;
}

function _compactSize(compact) {
  let size = JSON.stringify({ _header: compact._header }).length;
  size += compact._rows.reduce((s, r) => s + r.length + 1, 0); // +1 for pipe or separator
  if (compact._prefixes) {
    size += JSON.stringify({ _prefixes: compact._prefixes }).length;
  }
  return size;
}

// ══════════════════════════════════════════════════════════
// PUBLIC API
// ══════════════════════════════════════════════════════════

/**
 * Encode data payload into compact format.
 *
 * @param {object} data — the analysis payload (object whose array fields get compacted)
 * @param {object} opts
 * @param {boolean} [opts.interning=true] — enable path prefix interning
 * @returns {object} the payload with homogeneous array fields replaced by their
 *                   compact (`_header`/`_rows`) form; the original `data` is returned
 *                   unchanged for non-objects or when nothing was compacted.
 */
function compactResponse(data, opts = {}) {
  if (!data || typeof data !== 'object') {
    return data;
  }

  let modified = false;
  const result = { ...data };

  for (const [key, value] of Object.entries(result)) {
    if (Array.isArray(value) && _isHomogeneous(value) && value.length >= 2 && _isCompactable(value)) {
      result[key] = _encodeList(value, opts);
      modified = true;
    }
  }

  return modified ? result : data;
}

/**
 * Expand compact format back to original JSON.
 *
 * @param {object} compact — the compact payload
 * @returns {object} original expanded payload
 */
function expandResponse(compact) {
  if (!compact || typeof compact !== 'object') {
    return compact;
  }

  const result = { ...compact };
  let modified = false;

  for (const [key, value] of Object.entries(result)) {
    if (value && typeof value === 'object' && value._header && value._rows) {
      result[key] = _decodeList(value);
      modified = true;
    }
  }

  return modified ? result : compact;
}

/**
 * Determine the best format based on estimated savings.
 *
 * @param {object} data — analysis payload
 * @returns {'json'|'compact'} recommended format
 */
function autoFormat(data) {
  const encodable = _findEncodableList(data);
  if (!encodable) {
    return 'json';
  }

  {
    const compact = _encodeList(encodable.rows),
      jsonBytes = _jsonSize(encodable.rows),
      compactBytes = _compactSize(compact),
      // Use compact only if savings ≥ 20%
      ratio = jsonBytes > 0 ? compactBytes / jsonBytes : 1;
    return ratio <= 0.8 ? 'compact' : 'json';
  }
}

// ══════════════════════════════════════════════════════════
// EXPORTS
// ══════════════════════════════════════════════════════════

module.exports = {
  compactResponse,
  expandResponse,
  autoFormat,
  estimateTokens,
  // Internal exports for testing
  _encodeList,
  _decodeList,
  _isHomogeneous,
  _isCompactable,
  _findEncodableList,
  _escapePipe,
  _unescapePipe,
  _computePrefixes,
};
