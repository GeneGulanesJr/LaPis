// Verifier-evasion rules: compare a file's old and new text and report added
// escape hatches (pragma Assume, SPARK_Mode Off, sorry, ...) and removed or
// weakened contracts. Pure functions only; git access lives in ./index.js.

const path = require('path');

const CONTRACT_START_RE =
  /\b(?:Pre|Post)(?:'Class)?\s*=>|\bContract_Cases\s*=>|\bpragma\s+(?:Precondition|Postcondition|Contract_Cases)\b/gi;

// Mode 'added'            → flag lines matching `re` that are new (line multiset
//                           diff, so a moved line is not new but an edited one is).
// Mode 'contract-added'   → flag new whole contracts matching `re`.
// Mode 'contract-removed' → flag when the file holds fewer contracts than before
//                           (net count, so moving a contract is not a removal).
// Mode 'contract-changed' → flag old contracts that no longer exist verbatim.
// Mode 'any'              → flag any changed line at all.
// Contracts are compared whole, however many lines they span.
const RULES = [
  {
    id: 'spark-assume',
    severity: 'high',
    lang: 'ada',
    mode: 'added',
    re: /\bpragma\s+Assume\b/gi,
    message: 'pragma Assume added: GNATprove takes it as true without proof.',
  },
  {
    id: 'spark-mode-off',
    severity: 'high',
    lang: 'ada',
    mode: 'added',
    re: /\bSPARK_Mode\s*(?:=>\s*Off\b|\(\s*Off\s*\))/gi,
    message: 'SPARK_Mode Off added: this code is no longer analyzed.',
  },
  {
    id: 'spark-annotate',
    severity: 'warning',
    lang: 'ada',
    mode: 'added',
    re: /\bAnnotate\s*(?:=>\s*)?\(\s*GNATprove\b/gi,
    message: 'GNATprove annotation added: a check may now be justified instead of proved.',
  },
  {
    id: 'post-true',
    severity: 'high',
    lang: 'ada',
    mode: 'contract-added',
    re: /^Post(?:'Class)?\s*=>\s*\(?\s*True\s*\)?$/i,
    message: 'Post => True added: the postcondition promises nothing.',
  },
  {
    id: 'pre-false',
    severity: 'high',
    lang: 'ada',
    mode: 'contract-added',
    re: /^Pre(?:'Class)?\s*=>\s*\(?\s*False\s*\)?$/i,
    message: 'Pre => False added: the subprogram can never be called, so its proof is vacuous.',
  },
  {
    id: 'contract-removed',
    severity: 'high',
    lang: 'ada',
    mode: 'contract-removed',
    message: 'Fewer Pre/Post/Contract_Cases than before: a contract was removed.',
  },
  {
    id: 'contract-changed',
    severity: 'warning',
    lang: 'ada',
    exts: ['.ads'],
    mode: 'contract-changed',
    message: 'Contract changed in a spec: needs human review.',
  },
  {
    id: 'project-file-changed',
    severity: 'warning',
    lang: 'gpr',
    mode: 'any',
    re: null,
    message: 'GNAT project file changed: check it does not shrink what GNATprove analyzes.',
  },
  {
    id: 'lean-sorry',
    severity: 'high',
    lang: 'lean',
    mode: 'added',
    re: /\b(?:sorry|admit)\b/g,
    message: 'sorry/admit added: the proof is incomplete.',
  },
  {
    id: 'lean-axiom',
    severity: 'high',
    lang: 'lean',
    mode: 'added',
    re: /^\s*(?:@\[[^\]]*\]\s*)?(?:(?:private|protected|noncomputable)\s+)*axiom\b/gm,
    message: 'New axiom: it is assumed, not proved.',
  },
  {
    id: 'lean-native-decide',
    severity: 'high',
    lang: 'lean',
    mode: 'added',
    re: /\bnative_decide\b/g,
    message: 'native_decide added: trusts the compiler instead of the kernel.',
  },
];

const LANG_BY_EXT = { '.ads': 'ada', '.adb': 'ada', '.adc': 'ada', '.gpr': 'gpr', '.lean': 'lean' };

function languageOf(filePath) {
  return LANG_BY_EXT[path.extname(filePath).toLowerCase()] || null;
}

// Drop `--` comments and empty out string literals ("pragma Assume" in a
// message is not a pragma). Character literals like '"' are skipped.
function stripCommentsAndStrings(line) {
  let inString = false,
    out = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (!inString && c === "'" && line[i + 2] === "'") {
      out += line.slice(i, i + 3);
      i += 2;
    } else if (c === '"') {
      inString = !inString;
      out += c;
    } else if (!inString && c === '-' && line[i + 1] === '-') {
      return out;
    } else if (!inString) {
      out += c;
    }
  }
  return out;
}

// Code lines with comments removed, keeping 1-based line numbers.
function codeLines(text, lang) {
  let source = text || '';
  if (lang === 'lean') {
    // shortcut: nested /- -/ block comments are treated as flat.
    source = source.replace(/\/-[\s\S]*?-\//g, (m) => m.replace(/[^\n]/g, ' '));
  }
  return source.split(/\r?\n/).map((raw, i) => ({
    line: i + 1,
    code: stripCommentsAndStrings(raw).replace(/\s+/g, ' ').trim(),
  }));
}

function countMatches(re, s) {
  re.lastIndex = 0;
  return (s.match(re) || []).length;
}

// Items of `from` that are not in `against` (multiset difference on `key`, or
// on `code` when there is no key).
function linesNotIn(from, against) {
  const remaining = new Map(),
    out = [];
  for (const l of against) {
    const k = l.key ?? l.code;
    remaining.set(k, (remaining.get(k) || 0) + 1);
  }
  for (const l of from) {
    const k = l.key ?? l.code,
      n = remaining.get(k) || 0;
    if (n > 0) {
      remaining.set(k, n - 1);
    } else {
      out.push(l);
    }
  }
  return out;
}

// Each Ada contract as one normalized item, from its keyword to the `,` `;` or
// `is` that ends it at paren depth 0 (or the `)` closing an enclosing call).
function contracts(lines) {
  const text = lines.map((l) => l.code).join('\n'),
    out = [];
  CONTRACT_START_RE.lastIndex = 0;
  let m;
  while ((m = CONTRACT_START_RE.exec(text))) {
    let depth = 0,
      i = m.index + m[0].length;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === '(') {
        depth++;
      } else if (c === ')') {
        if (depth === 0) {
          break;
        }
        depth--;
      } else if (
        depth === 0 &&
        (c === ',' || c === ';' || (/^is(?!\w)/i.test(text.slice(i, i + 3)) && /\W/.test(text[i - 1])))
      ) {
        break;
      }
    }
    const code = text.slice(m.index, i).replace(/\s+/g, ' ').trim();
    out.push({ line: lines[text.slice(0, m.index).split('\n').length - 1].line, code, key: code.toLowerCase() });
    CONTRACT_START_RE.lastIndex = Math.max(i, m.index + 1); // nested keywords belong to this contract
  }
  return out;
}

function finding(rule, file, l) {
  return {
    rule: rule.id,
    severity: rule.severity,
    file,
    line: l ? l.line : null,
    text: l ? l.code : '',
    message: rule.message,
  };
}

/**
 * Scan one changed file. `oldText` is '' for an added file, `newText` is '' for
 * a deleted one. Returns findings (not yet filtered by the allowlist).
 */
function scanFilePair({ file, oldPath, oldText, newText }) {
  const lang = languageOf(file) || languageOf(oldPath || '');
  if (!lang) {
    return [];
  }
  const ext = path.extname(file).toLowerCase(),
    oldLines = codeLines(oldText, lang).filter((l) => l.code),
    newLines = codeLines(newText, lang).filter((l) => l.code),
    added = linesNotIn(newLines, oldLines),
    removed = linesNotIn(oldLines, newLines),
    oldContracts = lang === 'ada' ? contracts(oldLines) : [],
    newContracts = lang === 'ada' ? contracts(newLines) : [],
    addedContracts = linesNotIn(newContracts, oldContracts),
    removedContracts = linesNotIn(oldContracts, newContracts),
    findings = [];

  for (const rule of RULES) {
    if (rule.lang !== lang || (rule.exts && !rule.exts.includes(ext))) {
      continue;
    }
    if (rule.mode === 'added') {
      for (const l of added) {
        if (countMatches(rule.re, l.code) > 0) {
          findings.push(finding(rule, file, l));
        }
      }
    } else if (rule.mode === 'contract-added') {
      for (const c of addedContracts) {
        if (rule.re.test(c.code)) {
          findings.push(finding(rule, file, c));
        }
      }
    } else if (rule.mode === 'contract-removed') {
      if (newContracts.length < oldContracts.length) {
        findings.push({ ...finding(rule, file, removedContracts[0] || null), old_line: true });
      }
    } else if (rule.mode === 'contract-changed') {
      if (findings.some((f) => f.rule === 'contract-removed')) {
        continue; // already reported as the stronger finding
      }
      for (const c of removedContracts) {
        findings.push({ ...finding(rule, file, c), old_line: true });
      }
    } else if (rule.mode === 'any' && (added.length || removed.length)) {
      findings.push(finding(rule, file, added[0] || null));
    }
  }
  return findings;
}

/**
 * Validate a parsed allowlist: an array of { rule, file, reason } with a
 * non-empty reason. Returns { entries } or { error }.
 */
function validateAllowlist(raw) {
  if (!Array.isArray(raw)) {
    return { error: 'allowlist must be a JSON array of { rule, file, reason }' };
  }
  const known = new Set(RULES.map((r) => r.id));
  for (const [i, e] of raw.entries()) {
    if (!e || typeof e.rule !== 'string' || typeof e.file !== 'string') {
      return { error: `allowlist entry ${i}: needs string "rule" and "file"` };
    }
    if (!known.has(e.rule)) {
      return { error: `allowlist entry ${i}: unknown rule "${e.rule}"` };
    }
    if (typeof e.reason !== 'string' || !e.reason.trim()) {
      return { error: `allowlist entry ${i} (${e.rule} ${e.file}): "reason" is required` };
    }
  }
  return { entries: raw.map((e) => ({ ...e, file: e.file.replace(/\\/g, '/') })) };
}

function applyAllowlist(findings, entries) {
  return findings.map((f) => {
    const hit = entries.find((e) => e.rule === f.rule && e.file === f.file);
    return hit ? { ...f, allowed: true, reason: hit.reason } : f;
  });
}

module.exports = { RULES, languageOf, scanFilePair, validateAllowlist, applyAllowlist, stripCommentsAndStrings };
