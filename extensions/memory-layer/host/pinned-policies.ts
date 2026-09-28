// extensions/memory-layer/host/pinned-policies.ts
// AGENTS.md pinned-policy parser for the post-compact Jev integration.
//
// loadPinnedPolicies(cwd) reads the project's AGENTS.md (cwd/AGENTS.md),
// extracts the pinned-policies section, and returns [{ id, title, text }]
// — one entry per policy bullet. Cached per-path by mtime so re-reads only
// happen when the file actually changes. Robust to drift: a missing or
// unreadable AGENTS.md (or no pinned-policies section) returns [] with a
// single stderr warning per path. Never throws.
//
// The pure-text half, parsePinnedPolicies(md), is exported for tests and
// for call sites that already hold the markdown in hand. Mirrors the shape
// of RetellMCP/qa/pinned-policies.mjs but is cwd-driven (no hardcoded repo
// root) since memory-layer runs against arbitrary project cwds.

import { statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type PinnedPolicy = {
  id: string;
  title: string;
  text: string;
};

/** Per-path cache: path -> { mtimeMs, policies }. */
const cache = new Map<string, { mtimeMs: number; policies: PinnedPolicy[] }>();

/** Warn-once set keyed by path. */
const warned = new Set<string>();

/** Test hook — drop the cache so the next loadPinnedPolicies() re-reads. */
export function _clearPolicyCache(): void {
  cache.clear();
  warned.clear();
}

function warnOnce(agentsPath: string, message: string): void {
  if (warned.has(agentsPath)) return;
  warned.add(agentsPath);
  console.error(message);
}

/** "Spelling policy" -> "spelling-policy". */
function slugify(s: string): string {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Parse the pinned-policies bullets out of AGENTS.md text. Pure function.
 *
 * The section is anchored on any line mentioning "PINNED POLICIES" (today:
 * "**PINNED POLICIES (2026-08-14 evening):**"; tolerant of a future
 * "# Pinned policies" heading). Inside the section each `- **Title...:** ...`
 * bullet is one policy; indented continuation lines fold into that bullet's
 * text. The section ends at the first column-0 line that is not a bullet.
 * Never throws; returns [] when the section or its bullets are absent.
 */
export function parsePinnedPolicies(md: unknown): PinnedPolicy[] {
  if (typeof md !== 'string' || !md.trim()) return [];
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => /pinned policies/i.test(l));
  if (start === -1) return [];

  // Collect bullet blocks: `- **...` starts a block; indented lines and
  // blank lines continue it; a column-0 non-bullet line ends the section.
  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^- /.test(line)) {
      current = [line];
      blocks.push(current);
    } else if (current && /^\s/.test(line)) {
      current.push(line);
    } else if (current && line.trim() === '') {
      current.push(line);
    } else if (current) {
      break;
    }
  }

  const policies: PinnedPolicy[] = [];
  for (const block of blocks) {
    const joined = block.join(' ');
    const m = /^- \*\*(.+?)\*\*\s*(.*)$/.exec(joined);
    if (!m) continue;
    // Strip a trailing colon from the captured title (AGENTS.md writes
    // "**Title:** text"; tolerate "**Title** text" too).
    const rawTitle = m[1].replace(/:\s*$/, '').trim();
    const text = String(m[2] ?? '').replace(/\s+/g, ' ').trim();
    // Strip parenthetical qualifiers: "(PINNED)",
    // "(PINNED, FINAL_SPELLING_ATTEMPT_V2 — AMENDED round 7)".
    const cleanTitle = rawTitle.replace(/\s*\([^)]*\)/g, '').trim() || rawTitle;
    policies.push({ id: slugify(cleanTitle), title: cleanTitle, text });
  }
  return policies;
}

/**
 * Load the pinned policies from `<cwd>/AGENTS.md`, cached by mtime per path.
 *
 * @param cwd Project working directory; AGENTS.md is read from this path.
 * @returns {PinnedPolicy[]} [] on any failure (missing file, unreadable, no
 *   section) with a single stderr warning per path.
 */
export function loadPinnedPolicies(cwd: string): PinnedPolicy[] {
  if (!cwd) return [];
  const agentsPath = join(cwd, 'AGENTS.md');
  let mtimeMs: number;
  try {
    mtimeMs = statSync(agentsPath).mtimeMs;
  } catch (e) {
    warnOnce(
      agentsPath,
      `⚠ pinned-policies: could not stat ${agentsPath} (${(e as Error).message}) — no pinned policies loaded`,
    );
    return [];
  }

  const hit = cache.get(agentsPath);
  if (hit && hit.mtimeMs === mtimeMs) return hit.policies;

  let md: string;
  try {
    md = readFileSync(agentsPath, 'utf8');
  } catch (e) {
    warnOnce(
      agentsPath,
      `⚠ pinned-policies: could not read ${agentsPath} (${(e as Error).message}) — no pinned policies loaded`,
    );
    return [];
  }

  const policies = parsePinnedPolicies(md);
  if (policies.length === 0) {
    warnOnce(
      agentsPath,
      `⚠ pinned-policies: no "Pinned policies" section found in ${agentsPath}`,
    );
  }
  cache.set(agentsPath, { mtimeMs, policies });
  return policies;
}
