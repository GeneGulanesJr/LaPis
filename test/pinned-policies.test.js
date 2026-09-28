import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadPinnedPolicies,
  parsePinnedPolicies,
  _clearPolicyCache,
} from '../extensions/memory-layer/host/pinned-policies.ts';

describe('parsePinnedPolicies (pure)', () => {
  it('returns [] for non-string input', () => {
    expect(parsePinnedPolicies(null)).toEqual([]);
    expect(parsePinnedPolicies(undefined)).toEqual([]);
    expect(parsePinnedPolicies(42)).toEqual([]);
    expect(parsePinnedPolicies('')).toEqual([]);
  });

  it('returns [] when no pinned-policies section exists', () => {
    const md = '# Other heading\n\n- just a list\n';
    expect(parsePinnedPolicies(md)).toEqual([]);
  });

  it('extracts bullets from a section anchored by "pinned policies"', () => {
    const md = `# Other section
Some prose before.

**PINNED POLICIES (2026-09-25):**

- **Spelling policy:** read-back, then corrected read-back, then letter-spell.
- **Confirmation policy:** confirm the summary exactly once per call.

Some text after the section.
`;
    const policies = parsePinnedPolicies(md);
    expect(policies).toHaveLength(2);
    expect(policies[0]).toMatchObject({
      title: 'Spelling policy',
      text: 'read-back, then corrected read-back, then letter-spell.',
    });
    expect(policies[1]).toMatchObject({
      title: 'Confirmation policy',
      text: 'confirm the summary exactly once per call.',
    });
  });

  it('strips parenthetical qualifiers from the title (FINAL_SPELLING_ATTEMPT_V2 — AMENDED round 7)', () => {
    const md = `**PINNED POLICIES:**

- **Spelling policy (PINNED, FINAL_SPELLING_ATTEMPT_V2 — AMENDED round 7):** letter-by-letter.
`;
    const policies = parsePinnedPolicies(md);
    expect(policies).toHaveLength(1);
    expect(policies[0].title).toBe('Spelling policy');
    expect(policies[0].id).toBe('spelling-policy');
  });

  it('folds indented continuation lines into the bullet text', () => {
    const md = `**PINNED POLICIES:**

- **Spelling policy:** read-back then
  letter-spell then
  confirm once.
- **Other:** short text.
`;
    const policies = parsePinnedPolicies(md);
    expect(policies).toHaveLength(2);
    expect(policies[0].text).toMatch(/letter-spell/);
    expect(policies[0].text).toMatch(/confirm once/);
  });

  it('skips bullets without a bold header', () => {
    const md = `**PINNED POLICIES:**

- plain bullet without bold header
- **Real policy:** actual content
`;
    const policies = parsePinnedPolicies(md);
    expect(policies).toHaveLength(1);
    expect(policies[0].title).toBe('Real policy');
  });

  it('is case-insensitive for the section anchor', () => {
    const md = `**pinned policies:**

- **Foo:** bar.
`;
    expect(parsePinnedPolicies(md)).toHaveLength(1);
  });

  it('returns slugified id', () => {
    const md = `**PINNED POLICIES:**

- **Door Shift Times:** patient not answering doors collect shift times.
`;
    const policies = parsePinnedPolicies(md);
    expect(policies[0].id).toBe('door-shift-times');
  });
});

describe('loadPinnedPolicies (cwd-driven)', () => {
  let cwd;
  let agentsPath;

  beforeEach(() => {
    _clearPolicyCache();
    cwd = mkdtempSync(join(tmpdir(), 'pinned-policies-'));
    agentsPath = join(cwd, 'AGENTS.md');
  });

  it('returns [] when AGENTS.md does not exist', () => {
    expect(loadPinnedPolicies(cwd)).toEqual([]);
  });

  it('returns [] when AGENTS.md has no pinned-policies section', () => {
    writeFileSync(agentsPath, '# Other heading\n- not a policy\n');
    expect(loadPinnedPolicies(cwd)).toEqual([]);
  });

  it('returns parsed policies when AGENTS.md has a section', () => {
    writeFileSync(
      agentsPath,
      `**PINNED POLICIES:**

- **Spelling:** letter-by-letter.
- **Confirmation:** exactly once.
`,
    );
    const policies = loadPinnedPolicies(cwd);
    expect(policies).toHaveLength(2);
    expect(policies[0].title).toBe('Spelling');
    expect(policies[1].title).toBe('Confirmation');
  });

  it('caches results by mtime within a single cwd', () => {
    writeFileSync(
      agentsPath,
      `**PINNED POLICIES:**

- **Foo:** bar.
`,
    );
    const first = loadPinnedPolicies(cwd);
    expect(first).toHaveLength(1);

    // Re-read with no file change: returns cached result
    const second = loadPinnedPolicies(cwd);
    expect(second).toBe(first); // same array reference (cached)
  });

  it('re-reads when AGENTS.md mtime changes', () => {
    writeFileSync(
      agentsPath,
      `**PINNED POLICIES:**

- **Foo:** bar.
`,
    );
    const first = loadPinnedPolicies(cwd);
    expect(first[0].title).toBe('Foo');

    // Append a new policy; mtime changes
    writeFileSync(
      agentsPath,
      `**PINNED POLICIES:**

- **Foo:** bar.
- **Baz:** qux.
`,
    );
    const second = loadPinnedPolicies(cwd);
    expect(second).toHaveLength(2);
    expect(second[1].title).toBe('Baz');
  });

  it('caches independently per cwd', () => {
    const cwd2 = mkdtempSync(join(tmpdir(), 'pinned-policies-2-'));
    const agentsPath2 = join(cwd2, 'AGENTS.md');

    writeFileSync(
      agentsPath,
      `**PINNED POLICIES:**

- **Foo:** bar.
`,
    );
    writeFileSync(
      agentsPath2,
      `**PINNED POLICIES:**

- **X:** y.
- **Z:** w.
`,
    );

    const a = loadPinnedPolicies(cwd);
    const b = loadPinnedPolicies(cwd2);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);
  });

  it('never throws on unreadable / missing files', () => {
    // cwd doesn't exist on disk
    const ghostCwd = join(cwd, 'does-not-exist');
    expect(() => loadPinnedPolicies(ghostCwd)).not.toThrow();
    expect(loadPinnedPolicies(ghostCwd)).toEqual([]);
  });
});
