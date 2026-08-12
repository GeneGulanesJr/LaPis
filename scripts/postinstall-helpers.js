'use strict';

// Testable helpers extracted from postinstall.js so the HTML grammar copy and
// its verification logic can be unit-tested without spawning a child process.
//
// Design goals:
//  - Pure w.r.t. the filesystem: every path is passed in, no magic globals.
//  - Idempotent: never overwrites an existing, non-empty destination unless
//    `force` is set. Re-running `npm install` is a no-op once the grammar is
//    in place.
//  - Never silent: missing source, missing destination directory, a failed
//    copy, or a missing/empty file after copy all emit a clear warning to a
//    caller-supplied `warn` sink (stderr in production) and are reported in
//    the returned result object.

const fs = require('fs');
const path = require('path');

const DEFAULT_HTML_SRC_REL = path.join('tree-sitter-html', 'tree-sitter-html.wasm');
const DEFAULT_HTML_DEST_NAME = 'tree-sitter-html.wasm';

// Minimum size in bytes below which a .wasm file is treated as truncated/corrupt.
// The real HTML grammar is ~18KB; anything tiny is a failed or partial copy.
const MIN_GRAMMAR_BYTES = 1024;

/**
 * Copy a single bundled WASM grammar from a source path to a destination
 * directory, verifying the destination afterwards. Never overwrites an existing
 * non-empty destination unless `opts.force` is true.
 *
 * @param {object} opts
 * @param {string} opts.grammarDir        Destination directory (must already exist; warned if not).
 * @param {string} opts.src               Absolute path to the source .wasm file.
 * @param {string} opts.destName          Filename to write under grammarDir.
 * @param {(msg: string) => void} [opts.warn]  Warning sink (defaults to no-op).
 * @param {boolean} [opts.force]          Overwrite an existing non-empty destination.
 * @param {object} [opts.fs]              Inject fs for testing.
 * @returns {{copied: boolean, skipped: boolean, ok: boolean, reason?: string}}
 */
function copyGrammar(opts) {
  const fsys = opts.fs || fs;
  const warn = typeof opts.warn === 'function' ? opts.warn : () => {};
  const grammarDir = opts.grammarDir;
  const src = opts.src;
  const destName = opts.destName;
  const dest = path.join(grammarDir, destName);

  // 1. Destination directory must exist. If it does not, there is nowhere to
  //    write — warn loudly rather than failing silently.
  if (!fsys.existsSync(grammarDir)) {
    warn(`postinstall: destination directory missing, skipping grammar copy: ${grammarDir}`);
    return { copied: false, skipped: true, ok: false, reason: 'dest_dir_missing' };
  }

  // 2. Source must exist and be non-trivially sized. A missing/empty source
  //    usually means the grammar npm package layout changed upstream.
  if (!fsys.existsSync(src)) {
    warn(`postinstall: grammar source not found, skipping copy: ${src}`);
    return { copied: false, skipped: true, ok: false, reason: 'src_missing' };
  }
  let srcSize = 0;
  try {
    srcSize = fsys.statSync(src).size;
  } catch (err) {
    warn(`postinstall: could not stat grammar source ${src}: ${err && err.message}`);
    return { copied: false, skipped: true, ok: false, reason: 'src_stat_failed' };
  }
  if (srcSize < MIN_GRAMMAR_BYTES) {
    warn(`postinstall: grammar source looks empty/truncated (${srcSize} bytes), skipping copy: ${src}`);
    return { copied: false, skipped: true, ok: false, reason: 'src_empty' };
  }

  // 3. Idempotency: do not clobber an existing non-empty destination. Only
  //    overwrite when explicitly forced (e.g. a stale/failed copy we want to
  //    repair). An existing-but-too-small destination is treated as stale and
  //    repaired only when forced; otherwise warned.
  if (fsys.existsSync(dest)) {
    let destSize = 0;
    try {
      destSize = fsys.statSync(dest).size;
    } catch (err) {
      warn(`postinstall: could not stat existing grammar ${dest}: ${err && err.message}`);
      destSize = -1;
    }
    if (destSize >= MIN_GRAMMAR_BYTES && !opts.force) {
      return { copied: false, skipped: true, ok: true, reason: 'already_present' };
    }
    if (destSize < MIN_GRAMMAR_BYTES && !opts.force) {
      warn(
        `postinstall: existing grammar looks stale/truncated (${destSize} bytes), not overwriting without --force: ${dest}`,
      );
      return { copied: false, skipped: false, ok: false, reason: 'dest_stale' };
    }
    // fall through: force === true -> overwrite
  }

  // 4. Perform the copy.
  try {
    fsys.copyFileSync(src, dest);
  } catch (err) {
    warn(`postinstall: failed to copy grammar ${src} -> ${dest}: ${err && err.message}`);
    return { copied: false, skipped: false, ok: false, reason: 'copy_failed' };
  }

  // 5. Verify the destination actually exists and is non-trivially sized.
  //    This catches failed copies that did not throw (rare, but possible on
  //    some FS / permission edge cases) and partial writes.
  if (!fsys.existsSync(dest)) {
    warn(`postinstall: grammar copy reported success but destination is missing: ${dest}`);
    return { copied: true, skipped: false, ok: false, reason: 'dest_missing_after_copy' };
  }
  let destSize = 0;
  try {
    destSize = fsys.statSync(dest).size;
  } catch (err) {
    warn(`postinstall: grammar copied but could not stat destination ${dest}: ${err && err.message}`);
    return { copied: true, skipped: false, ok: false, reason: 'dest_stat_failed' };
  }
  if (destSize < MIN_GRAMMAR_BYTES) {
    warn(`postinstall: grammar copy produced a truncated file (${destSize} bytes): ${dest}`);
    return { copied: true, skipped: false, ok: false, reason: 'dest_truncated' };
  }

  return { copied: true, skipped: false, ok: true, reason: 'copied' };
}

/**
 * Convenience wrapper for the HTML grammar copy used by postinstall.js.
 *
 * @param {object} opts
 * @param {string} opts.root            Repo root (where node_modules/ and grammars/ live).
 * @param {(msg: string) => void} [opts.warn]
 * @param {object} [opts.fs]
 * @param {boolean} [opts.force]
 * @returns {{copied: boolean, skipped: boolean, ok: boolean, reason?: string}}
 */
function copyHtmlGrammar(opts) {
  const fsys = opts.fs || fs;
  const grammarDir = path.join(opts.root, 'grammars');
  const src = path.join(opts.root, 'node_modules', DEFAULT_HTML_SRC_REL);
  return copyGrammar({
    grammarDir,
    src,
    destName: DEFAULT_HTML_DEST_NAME,
    warn: opts.warn,
    force: opts.force,
    fs: fsys,
  });
}

module.exports = {
  copyGrammar,
  copyHtmlGrammar,
  DEFAULT_HTML_SRC_REL,
  DEFAULT_HTML_DEST_NAME,
  MIN_GRAMMAR_BYTES,
};
