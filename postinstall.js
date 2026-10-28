#!/usr/bin/env node
const fs = require('fs'),
  path = require('path'),
  root = __dirname,
  nm = (...p) => path.join(root, 'node_modules', ...p);

// Patch transitive vulnerabilities that `overrides` cannot reach.
//
// @earendil-works/pi-coding-agent (a devDependency) ships an
// Npm-shrinkwrap.json that pins vulnerable versions of two packages:
//   - brace-expansion@5.0.6  (high, DoS — GHSA-3jxr-9vmj-r5cp)
// A published shrinkwrap takes precedence over the root project's `overrides`,
// So the root override gives us the correct
// Top-level copies, and we copy those over the nested vulnerable copies and
// Rewrite the matching package-lock.json entries so `npm audit` reports the fix.
//
// This runs after `npm install` finishes writing package-lock.json (and on
// Every `npm ci`), so the subsequent `npm audit` reflects safe versions. It
// No-ops when the nested paths are absent — e.g. for end users installing this
// Package, since pi-coding-agent is a devDependency they never receive.
(function patchTransitiveVulns() {
  const SAFE = {
    'brace-expansion': {
      version: '5.0.9',
      resolved: 'https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.9.tgz',
      integrity: 'sha512-ScQ4IuvIEF1TMlP7Zt+vjJ//9zlPb2SDcxWxM3bk8s6t6GGdJ7KO1dCcTidOPJKePW30LE/2cT7wCyPho9/Wxg==',
    },
  };
  // Only copies at these (vulnerable) versions are patched. Overwriting a
  // Copy at an unrelated version could put a dependent outside its declared
  // Range (#303).
  const VULNERABLE_VERSIONS = new Set(['5.0.6']);

  // Locate every nested copy of a target package under node_modules and return
  // The directory paths. Skips the top-level node_modules/<pkg> copy (which is
  // Already the safe, override-controlled version and our patch source).
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
        if (!entry.isDirectory()) {
          continue;
        }
        const child = path.join(nmDir, entry.name);
        if (entry.name === pkg) {
          const rel = path.relative(nm(), child);
          if (rel !== pkg && rel.includes(path.sep)) {
            results.push(child);
          }
        }
        // Descend into nested node_modules (regular and scoped packages).
        if (entry.name.startsWith('@')) {
          let scopeEntries = [];
          try {
            scopeEntries = fs.readdirSync(child, { withFileTypes: true });
          } catch {}
          for (const se of scopeEntries) {
            if (!se.isDirectory()) {
              continue;
            }
            const scopedNm = path.join(child, se.name, 'node_modules');
            if (fs.existsSync(scopedNm)) {
              visitNodeModules(scopedNm);
            }
          }
        } else {
          const childNm = path.join(child, 'node_modules');
          if (fs.existsSync(childNm)) {
            visitNodeModules(childNm);
          }
        }
      }
    }
    visitNodeModules(nm());
    return results;
  }

  let lockPath,
    lock = null,
    lockChanged = (() => {
      try {
        lockPath = path.join(root, 'package-lock.json');
        if (fs.existsSync(lockPath)) {
          lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        }
      } catch {
        lock = null;
      }

      return false;
    })();
  for (const [pkg, safe] of Object.entries(SAFE)) {
    const safeSrc = nm(pkg),
      nestedDirs = findNestedCopies(pkg);
    if (!nestedDirs.length) {
      continue;
    }

    let filesPatched = false;
    if (fs.existsSync(safeSrc)) {
      for (const dir of nestedDirs) {
        try {
          // Only patch copies whose version is in the known-vulnerable set.
          let currentVersion;
          try {
            currentVersion = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
          } catch {}
          if (currentVersion && !VULNERABLE_VERSIONS.has(currentVersion)) {
            continue;
          }
          // Atomic swap: stage the safe copy, then replace in one rename.
          // The old rm-then-copy pair could leave node_modules without the
          // Package at all if the copy failed partway (ENOSPC/EACCES) — and
          // The bare catch swallowed the evidence (#303).
          const stagedDir = `${dir}.patched-${process.pid}`;
          fs.rmSync(stagedDir, { recursive: true, force: true });
          fs.cpSync(safeSrc, stagedDir, { recursive: true, force: true });
          fs.rmSync(dir, { recursive: true, force: true });
          fs.renameSync(stagedDir, dir);
          filesPatched = true;
        } catch (e) {
          console.error(`[postinstall] failed to patch nested ${pkg} at ${dir}: ${e.message}`);
          try {
            fs.rmSync(`${dir}.patched-${process.pid}`, { recursive: true, force: true });
          } catch {}
        }
      }
    }

    // Keep package-lock.json in sync with the patched files so `npm audit`
    // Reports the safe versions. Only rewrite entries we actually fixed.
    if (lock && lock.packages) {
      for (const key of Object.keys(lock.packages)) {
        if (!key.endsWith(`node_modules/${pkg}`)) {
          continue;
        }
        if (key === `node_modules/${pkg}`) {
          continue;
        } // Top-level, already safe
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
      fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    } catch {}
  }
})();

process.exit(0);
