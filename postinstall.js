#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { copyHtmlGrammar } = require('./scripts/postinstall-helpers');

const root = __dirname;
const nm = (...p) => path.join(root, 'node_modules', ...p);

// Copy the bundled tree-sitter-html.wasm grammar into ./grammars.
//
// The copy is idempotent (an existing, non-trivial destination is preserved)
// but never silent: a missing source, a missing grammars/ directory, a failed
// copy, or a missing/truncated destination after copy each emit a clear
// warning to stderr and are reflected in the returned result. See
// scripts/postinstall-helpers.js for the testable implementation.
//
// Grammar ownership split (see docs/MODULE_MAP.md):
//   - HTML   -> copied here from the tree-sitter-html npm package at install.
//   - JS/TS/SQL -> fetched/renamed by scripts/fetch-grammars.sh (dev tooling).
//   - Go/Python/Rust (and other) WASM grammars are committed to ./grammars.
(function copyHtmlGrammarStep() {
  copyHtmlGrammar({ root, warn: (m) => console.error(m) });
})();

// Patch transitive vulnerabilities that `overrides` cannot reach.
//
// @earendil-works/pi-coding-agent (a devDependency) ships an
// npm-shrinkwrap.json that pins vulnerable versions of two packages:
//   - brace-expansion@5.0.6  (high, DoS — GHSA-3jxr-9vmj-r5cp)
//   - protobufjs@7.6.4       (moderate, DoS — GHSA-j3f2-48v5-ccww)
// A published shrinkwrap takes precedence over the root project's `overrides`,
// so the root overrides + devDependency on the safe versions give us correct
// top-level copies, and we copy those over the nested vulnerable copies and
// rewrite the matching package-lock.json entries so `npm audit` reports the fix.
//
// This runs after `npm install` finishes writing package-lock.json (and on
// every `npm ci`), so the subsequent `npm audit` reflects safe versions. It
// no-ops when the nested paths are absent — e.g. for end users installing this
// package, since pi-coding-agent is a devDependency they never receive.
(function patchTransitiveVulns() {
  const SAFE = {
    'brace-expansion': {
      version: '5.0.9',
      resolved: 'https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.9.tgz',
      integrity: 'sha512-ScQ4IuvIEF1TMlP7Zt+vjJ//9zlPb2SDcxWxM3bk8s6t6GGdJ7KO1dCcTidOPJKePW30LE/2cT7wCyPho9/Wxg==',
    },
    protobufjs: {
      version: '7.6.5',
      resolved: 'https://registry.npmjs.org/protobufjs/-/protobufjs-7.6.5.tgz',
      integrity: 'sha512-/FPD0nUc9jH6rfFjji9IBqOz4pcSE3CsT1m7Ep6Mdb0LxSUMj8hgl6GomOvZzpNpAqqGaXA0P3VSrZLFzIhQrw==',
    },
  };

  // Locate every nested copy of a target package under node_modules and return
  // the directory paths. Skips the top-level node_modules/<pkg> copy (which is
  // already the safe, override-controlled version and our patch source).
  function findNestedCopies(pkg) {
    const results = [];
    function visitNodeModules(nmDir) {
      let entries = [];
      try {
        entries = fs.readdirSync(nmDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const child = path.join(nmDir, entry.name);
        if (entry.name === pkg) {
          const rel = path.relative(nm(), child);
          if (rel !== pkg && rel.includes(path.sep)) results.push(child);
        }
        // Descend into nested node_modules (regular and scoped packages).
        if (entry.name.startsWith('@')) {
          let scopeEntries = [];
          try {
            scopeEntries = fs.readdirSync(child, { withFileTypes: true });
          } catch {}
          for (const se of scopeEntries) {
            if (!se.isDirectory()) continue;
            const scopedNm = path.join(child, se.name, 'node_modules');
            if (fs.existsSync(scopedNm)) visitNodeModules(scopedNm);
          }
        } else {
          const childNm = path.join(child, 'node_modules');
          if (fs.existsSync(childNm)) visitNodeModules(childNm);
        }
      }
    }
    visitNodeModules(nm());
    return results;
  }

  let lockPath;
  let lock = null;
  try {
    lockPath = path.join(root, 'package-lock.json');
    if (fs.existsSync(lockPath)) lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    lock = null;
  }

  let lockChanged = false;

  for (const [pkg, safe] of Object.entries(SAFE)) {
    const safeSrc = nm(pkg);
    const nestedDirs = findNestedCopies(pkg);
    if (!nestedDirs.length) continue;

    let filesPatched = false;
    if (fs.existsSync(safeSrc)) {
      for (const dir of nestedDirs) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          fs.cpSync(safeSrc, dir, { recursive: true, force: true });
          filesPatched = true;
        } catch {}
      }
    }

    // Keep package-lock.json in sync with the patched files so `npm audit`
    // reports the safe versions. Only rewrite entries we actually fixed.
    if (lock && lock.packages) {
      for (const key of Object.keys(lock.packages)) {
        if (!key.endsWith(`node_modules/${pkg}`)) continue;
        if (key === `node_modules/${pkg}`) continue; // top-level, already safe
        const entry = lock.packages[key];
        if (entry && filesPatched && entry.version !== safe.version) {
          entry.version = safe.version;
          entry.resolved = safe.resolved;
          entry.integrity = safe.integrity;
          lockChanged = true;
        }
      }
    }
  }

  if (lockChanged && lockPath) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
    } catch {}
  }
})();

process.exit(0);
