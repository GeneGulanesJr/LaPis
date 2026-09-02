'use strict';

/**
 * Minimal line-based YAML editor for Hermes `config.yaml`.
 *
 * Hermes configuration is a small, predictable subset of YAML: 2-space
 * indentation, `key: value` scalars, nested blocks, and dash-prefixed list
 * items. We deliberately avoid a YAML parser dependency and full-file
 * rewrites — a line-based editor preserves comments, ordering, and unknown
 * keys while surgically upserting/removing only the blocks LaPis owns
 * (`mcp_servers.<name>`, `hooks.<event>` entries, `hooks_auto_accept`).
 *
 * Every function is pure: it takes the full config text and returns the new
 * text, which keeps the editor trivially testable and lets callers stage
 * read-modify-write without holding locks.
 */

const fs = require('node:fs'), path = require('node:path'), os = require('node:os'),
  TOP_KEY_RE = /^[A-Za-z0-9_.-]+\s*:/;



function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Quote a scalar for YAML when it isn't a safe bare token. */
function yamlScalar(v) {
  if (/^[A-Za-z0-9_./:+-]+$/.test(v)) {
    return v;
  }
  return `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function splitLines(text) {
  return text.split('\n');
}

function joinLines(ls) {
  return ls.join('\n');
}

/** Collapse 3+ consecutive newlines to a single blank line. */
function squashBlankLines(text) {
  return text.replace(/\n{3,}/g, '\n\n');
}

/** Find the top-level block for `key`: {start, end} (end exclusive) or null. */
function topBlockRange(text, key) {
  const ls = splitLines(text);
  for (let i = 0; i < ls.length; i++) {
    const m = ls[i].match(/^([A-Za-z0-9_.-]+)\s*:/);
    if (m && m[1] === key) {
      let end = ls.length;
      for (let j = i + 1; j < ls.length; j++) {
        if (TOP_KEY_RE.test(ls[j])) {
          end = j;
          break;
        }
      }
      return { start: i, end };
    }
  }
  return null;
}

/** Trailing-blank-aware insertion point just before the end of a top block. */
function insertAt(ls, range) {
  let at = range.end;
  while (at > range.start + 1 && ls[at - 1].trim() === '') {
    at--;
  }
  return at;
}

/**
 * Upsert a `subKey:` block (at `indent` spaces) inside top-level `topKey`.
 * Creates both levels if missing; replaces an existing sub-block wholesale
 * (re-install dedupe). `bodyLines` are relative to the sub-key line
 * (rendered at indent + 2). Other sibling sub-blocks are preserved.
 */
function upsertSubBlock(text, topKey, subKey, bodyLines, indent = 2) {
  const ls = splitLines(text), range = topBlockRange(joinLines(ls), topKey);
  if (!range) {
    const block = [
        `${topKey}:`,
        `${' '.repeat(indent)}${subKey}:`,
        ...bodyLines.map((l) => ' '.repeat(indent + 2) + l),
      ],
      sep = ls.length > 0 && ls[ls.length - 1] !== '' ? [''] : [];
    return squashBlankLines(joinLines([...ls, ...sep, ...block, '']));
  }
  const pad = ' '.repeat(indent),
    subRe = new RegExp(`^${pad}${escapeRegExp(subKey)}\\s*:`), block = [`${pad}${subKey}:`, ...bodyLines.map((l) => ' '.repeat(indent + 2) + l)];
  let subStart = -1, subEnd = range.end;
  for (let i = range.start + 1; i < range.end; i++) {
    if (subRe.test(ls[i])) {
      subStart = i;
      break;
    }
  }
  
  if (subStart === -1) {
    const at = insertAt(ls, range);
    ls.splice(at, 0, ...block);
    return squashBlankLines(joinLines(ls));
  }
  
  for (let i = subStart + 1; i < range.end; i++) {
    if (ls[i].trim() === '') {
      continue;
    }
    const ind = ls[i].match(/^ */)[0].length;
    if (ind <= indent) {
      subEnd = i;
      break;
    }
  }
  ls.splice(subStart, subEnd - subStart, ...block);
  return squashBlankLines(joinLines(ls));
}

/** Remove a `subKey:` block at `indent` inside top-level `topKey`. */
function removeSubBlock(text, topKey, subKey, indent = 2) {
  const ls = splitLines(text),
    range = topBlockRange(text, topKey),
  pad = range ? (' '.repeat(indent)) : undefined,
  subRe = range ? (new RegExp(`^${pad}${escapeRegExp(subKey)}\\s*:`)) : undefined;
  if (!range) {
    return text;
  }
  let subStart = -1, subEnd = range.end;
  for (let i = range.start + 1; i < range.end; i++) {
    if (subRe.test(ls[i])) {
      subStart = i;
      break;
    }
  }
  if (subStart === -1) {
    return text;
  }
  
  for (let i = subStart + 1; i < range.end; i++) {
    if (ls[i].trim() === '') {
      continue;
    }
    const ind = ls[i].match(/^ */)[0].length;
    if (ind <= indent) {
      subEnd = i;
      break;
    }
  }
  ls.splice(subStart, subEnd - subStart);
  return squashBlankLines(joinLines(ls));
}

/** A line counts as empty for pruning when blank or a bare `key:` header. */
function isEmptyLineForPrune(line) {
  const t = line.trim();
  if (t === '') {
    return true;
  }
  return /^[A-Za-z0-9_.-]+:\s*$/.test(t);
}

/** True when a top-level block has no content (only blank/bare-key lines). */
function topBlockEmpty(text, key) {
  const range = topBlockRange(text, key),
  lines = range ? (splitLines(text).slice(range.start + 1, range.end)) : undefined;
  if (!range) {
    return false;
  }
  return lines.every(isEmptyLineForPrune);
}

/**
 * Remove a `subKey:` header at `indent` when it has no content beneath it
 * (only blank lines or deeper bare-key headers with nothing after them).
 */
function removeEmptySubBlock(text, topKey, subKey, indent = 2) {
  const ls = splitLines(text),
    range = topBlockRange(text, topKey),
  pad = range ? (' '.repeat(indent)) : undefined,
  subRe = range ? (new RegExp(`^${pad}${escapeRegExp(subKey)}\\s*:`)) : undefined;
  if (!range) {
    return text;
  }
  let subStart = -1, subEnd = range.end;
  for (let i = range.start + 1; i < range.end; i++) {
    if (subRe.test(ls[i])) {
      subStart = i;
      break;
    }
  }
  if (subStart === -1) {
    return text;
  }
  
  for (let i = subStart + 1; i < range.end; i++) {
    if (/^ {0,2}[A-Za-z0-9_.-]+\s*:/.test(ls[i]) && ls[i].trim() !== '') {
      const ind = ls[i].match(/^ */)[0].length;
      if (ind <= indent) {
        subEnd = i;
        break;
      }
    }
  }
  {
const content = ls.slice(subStart + 1, subEnd);
  if (!content.every(isEmptyLineForPrune)) {
    return text;
  }
  ls.splice(subStart, subEnd - subStart);
  return squashBlankLines(joinLines(ls));
}
}

/** Remove a top-level block and its body. */
function removeTopLevelBlock(text, key) {
  const range = topBlockRange(text, key),
  ls = range ? (splitLines(text)) : undefined;
  if (!range) {
    return text;
  }
  ls.splice(range.start, range.end - range.start);
  return squashBlankLines(joinLines(ls));
}

/**
 * Upsert a dash-list item under `topKey.subKey`. Items whose serialized text
 * contains `marker` are removed first (idempotent re-install), then the new
 * item lines are inserted after the `subKey:` header. `itemLines` are
 * relative to the item (rendered at indent 4). Other items are preserved.
 */
function upsertListItem(text, topKey, subKey, itemLines, marker) {
  const ls = splitLines(removeListItems(text, topKey, subKey, marker)),
  range = topBlockRange(joinLines(ls), topKey),
  items = itemLines.map((l) => `    ${l}`);
  if (!range) {
    const block = [`${topKey}:`, `  ${subKey}:`, ...items],
      sep = ls.length > 0 && ls[ls.length - 1] !== '' ? [''] : [];
    return squashBlankLines(joinLines([...ls, ...sep, ...block, '']));
  }
  let subStart = -1;
  for (let i = range.start + 1; i < range.end; i++) {
    if (/^  [A-Za-z0-9_.-]+\s*:/.test(ls[i]) && ls[i].trim().startsWith(`${subKey}:`)) {
      subStart = i;
      break;
    }
  }
  if (subStart === -1) {
    const at = insertAt(ls, range);
    ls.splice(at, 0, `  ${subKey}:`, ...items);
    return squashBlankLines(joinLines(ls));
  }
  ls.splice(subStart + 1, 0, ...items);
  return squashBlankLines(joinLines(ls));
}

/** Remove every dash-list item under `topKey.subKey` containing `marker`. */
function removeListItems(text, topKey, subKey, marker) {
  const ls = splitLines(text),
    range = topBlockRange(text, topKey), kept = [];
  if (!range) {
    return text;
  }
  let subStart = -1, subEnd = range.end;
  for (let i = range.start + 1; i < range.end; i++) {
    if (/^  [A-Za-z0-9_.-]+\s*:/.test(ls[i]) && ls[i].trim().startsWith(`${subKey}:`)) {
      subStart = i;
      break;
    }
  }
  if (subStart === -1) {
    return text;
  }
  
  for (let i = subStart + 1; i < range.end; i++) {
    if (/^  [A-Za-z0-9_.-]+\s*:/.test(ls[i])) {
      subEnd = i;
      break;
    }
  }
  
  let i = subStart + 1;
  while (i < subEnd) {
    if (/^    - /.test(ls[i])) {
      const itemLines = [ls[i]];
      let j = i + 1;
      while (j < subEnd && (ls[j].startsWith('      ') || ls[j].trim() === '')) {
        itemLines.push(ls[j]);
        j++;
      }
      if (!itemLines.join('\n').includes(marker)) {
        kept.push(...itemLines);
      }
      i = j;
    } else {
      kept.push(ls[i]);
      i++;
    }
  }
  const out = [...ls.slice(0, subStart + 1), ...kept, ...ls.slice(subEnd)];
  return squashBlankLines(joinLines(out));
}

/** Upsert a top-level scalar line `key: value`. */
function upsertScalar(text, key, value) {
  const ls = splitLines(text),
    re = new RegExp(`^${escapeRegExp(key)}\\s*:`), sep = ls.length > 0 && ls[ls.length - 1] !== '' ? [''] : [];
  for (let i = 0; i < ls.length; i++) {
    if (re.test(ls[i])) {
      ls[i] = `${key}: ${value}`;
      return joinLines(ls);
    }
  }
  
  return squashBlankLines(joinLines([...ls, ...sep, `${key}: ${value}`]));
}

/** Remove a top-level scalar line. */
function removeScalar(text, key) {
  const ls = splitLines(text),
    re = new RegExp(`^${escapeRegExp(key)}\\s*:`),
    out = ls.filter((l) => !re.test(l));
  return squashBlankLines(joinLines(out));
}

/** Read a file as text, or '' when absent. */
function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

/** Atomic write (same-dir temp + rename), creating parent dirs. */
function writeTextAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

module.exports = {
  yamlScalar,
  topBlockRange,
  upsertSubBlock,
  removeSubBlock,
  topBlockEmpty,
  removeEmptySubBlock,
  removeTopLevelBlock,
  upsertListItem,
  removeListItems,
  upsertScalar,
  removeScalar,
  readText,
  writeTextAtomic,
};
