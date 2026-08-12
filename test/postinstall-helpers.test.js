// Tests for the postinstall grammar copy + verification helper.
//
// The repo runs vitest with `globals: true` (see vitest.config.mjs), so
// describe/it/expect are available without importing — matching every other
// test file under test/. Do not `require('vitest')`; that throws under CJS.
const { copyGrammar, copyHtmlGrammar, MIN_GRAMMAR_BYTES } = require('../scripts/postinstall-helpers');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Payload well above MIN_GRAMMAR_BYTES so size guards fire only on purpose.
const VALID_WASM = Buffer.alloc(MIN_GRAMMAR_BYTES + 4096, 0x00);

function makeFixture({ srcBytes = VALID_WASM, destBytes = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-postinstall-'));
  const grammarDir = path.join(root, 'grammars');
  fs.mkdirSync(grammarDir, { recursive: true });
  const src = path.join(root, 'source', 'tree-sitter-html.wasm');
  fs.mkdirSync(path.dirname(src), { recursive: true });
  fs.writeFileSync(src, srcBytes);
  const dest = path.join(grammarDir, 'tree-sitter-html.wasm');
  if (destBytes !== null) fs.writeFileSync(dest, destBytes);
  return { root, grammarDir, src, destName: 'tree-sitter-html.wasm', dest };
}

describe('postinstall grammar copy + verification', () => {
  let warns;

  beforeEach(() => {
    warns = [];
  });

  it('copies the grammar and verifies the destination afterwards', () => {
    const f = makeFixture();
    const res = copyGrammar({ ...f, warn: (m) => warns.push(m) });
    expect(res.copied).toBe(true);
    expect(res.skipped).toBe(false);
    expect(res.ok).toBe(true);
    expect(res.reason).toBe('copied');
    expect(fs.existsSync(f.dest)).toBe(true);
    expect(fs.statSync(f.dest).size).toBe(VALID_WASM.length);
    expect(warns).toHaveLength(0);
  });

  it('is idempotent: preserves an existing non-empty destination (no overwrite)', () => {
    const existing = Buffer.alloc(MIN_GRAMMAR_BYTES + 123, 0xab);
    const f = makeFixture({ destBytes: existing });
    const mtimeBefore = fs.statSync(f.dest).mtimeMs;
    const res = copyGrammar({ ...f, warn: (m) => warns.push(m) });
    expect(res.copied).toBe(false);
    expect(res.skipped).toBe(true);
    expect(res.ok).toBe(true);
    expect(res.reason).toBe('already_present');
    // Untouched: same bytes, same mtime.
    expect(fs.readFileSync(f.dest)).toEqual(existing);
    expect(fs.statSync(f.dest).mtimeMs).toBe(mtimeBefore);
    expect(warns).toHaveLength(0);
  });

  it('warns and skips when the source grammar is missing', () => {
    const f = makeFixture();
    fs.rmSync(f.src);
    const res = copyGrammar({ ...f, warn: (m) => warns.push(m) });
    expect(res.copied).toBe(false);
    expect(res.skipped).toBe(true);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('src_missing');
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/source not found/i);
  });

  it('warns and skips when the destination directory is missing', () => {
    const f = makeFixture();
    fs.rmSync(f.grammarDir, { recursive: true, force: true });
    const res = copyGrammar({ ...f, warn: (m) => warns.push(m) });
    expect(res.copied).toBe(false);
    expect(res.skipped).toBe(true);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('dest_dir_missing');
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/destination directory missing/i);
  });

  it('warns on a truncated/empty source and does not copy', () => {
    const f = makeFixture({ srcBytes: Buffer.alloc(16, 0x00) });
    const res = copyGrammar({ ...f, warn: (m) => warns.push(m) });
    expect(res.copied).toBe(false);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('src_empty');
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/empty\/truncated/i);
  });

  it('warns about a stale/truncated destination and does NOT overwrite without force', () => {
    const stale = Buffer.alloc(8, 0x00);
    const f = makeFixture({ destBytes: stale });
    const res = copyGrammar({ ...f, warn: (m) => warns.push(m) });
    expect(res.copied).toBe(false);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('dest_stale');
    // The stale file is left in place (no silent repair without force).
    expect(fs.readFileSync(f.dest)).toEqual(stale);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/stale\/truncated/i);
  });

  it('repairs a stale destination when force=true', () => {
    const stale = Buffer.alloc(8, 0x00);
    const f = makeFixture({ destBytes: stale });
    const res = copyGrammar({ ...f, warn: (m) => warns.push(m), force: true });
    expect(res.copied).toBe(true);
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(f.dest)).toEqual(VALID_WASM);
    expect(warns).toHaveLength(0);
  });

  it('detects a copy that silently failed to produce the destination', () => {
    const f = makeFixture();
    // Fake fs: source + grammarDir exist; copyFileSync is a no-op; the
    // destination never appears, so post-copy verification must catch it.
    const fakeFs = {
      existsSync: (p) => p === f.src || p === f.grammarDir,
      statSync: () => ({ size: VALID_WASM.length }),
      copyFileSync: () => {
        /* swallow: simulate silent failure */
      },
    };
    const res = copyGrammar({ ...f, warn: (m) => warns.push(m), fs: fakeFs, force: true });
    expect(res.copied).toBe(true);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('dest_missing_after_copy');
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/reported success but destination is missing/i);
  });

  it('detects a copy that produced a truncated destination', () => {
    const f = makeFixture();
    // Seed a real stale destination so the helper takes the copy path; then
    // make post-copy stat report a truncated size to exercise verification.
    fs.writeFileSync(f.dest, Buffer.alloc(8, 0x00));
    let copied = false;
    const fakeFs = {
      existsSync: (p) => fs.existsSync(p),
      statSync: (p) => {
        // Source is valid; before copy the dest is stale; after copy it reads
        // back as truncated (4 bytes).
        if (p === f.src) return { size: VALID_WASM.length };
        return { size: copied ? 4 : 8 };
      },
      copyFileSync: () => {
        copied = true;
      },
    };
    const res = copyGrammar({ ...f, warn: (m) => warns.push(m), fs: fakeFs, force: true });
    expect(res.copied).toBe(true);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('dest_truncated');
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/truncated file/i);
  });

  it('copyHtmlGrammar wires root -> node_modules/tree-sitter-html -> grammars/', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-pi-html-'));
    fs.mkdirSync(path.join(root, 'grammars'), { recursive: true });
    const src = path.join(root, 'node_modules', 'tree-sitter-html', 'tree-sitter-html.wasm');
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.writeFileSync(src, VALID_WASM);
    const dest = path.join(root, 'grammars', 'tree-sitter-html.wasm');

    const res = copyHtmlGrammar({ root, warn: (m) => warns.push(m) });
    expect(res.ok).toBe(true);
    expect(res.copied).toBe(true);
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.statSync(dest).size).toBe(VALID_WASM.length);
  });

  it('copyHtmlGrammar warns when node_modules/tree-sitter-html is absent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lapis-pi-html-'));
    fs.mkdirSync(path.join(root, 'grammars'), { recursive: true });
    const res = copyHtmlGrammar({ root, warn: (m) => warns.push(m) });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('src_missing');
    expect(warns).toHaveLength(1);
  });
});
