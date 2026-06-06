# Dashboard TUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Use Sequential mode for planned tasks or Direct mode if subagents aren't available. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/dashboard` command showing memory health in an interactive TUI with bar charts, trust scores, recall rates, dream cycle stats, and code index freshness.

**Architecture:** Three-layer design matching existing patterns — data-access (SQL aggregation) → CLI gateway (command dispatch) → extension (TUI component). Dream cycle stats persisted to `settings` table as a side change.

**Tech Stack:** TypeScript (extension), JavaScript (data-access/CLI), `@earendil-works/pi-tui` (TUI component), SQLite (queries).

**Spec:** `docs/superpowers/specs/2026-06-06-dashboard-tui-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `data-access/dashboard.js` | Create | `getDashboard(deps)` — all aggregation queries |
| `test/data-access-dashboard.test.js` | Create | Tests for `getDashboard` |
| `src/cli/commands/dashboard.js` | Create | CLI router registering `commands.dashboard` |
| `src/cli/gateway.js` | Modify | Import and register dashboard router |
| `src/memory-domain/compaction.js` | Modify | Persist dream stats to settings table |
| `extensions/memory-layer/commands/dashboard.ts` | Create | `/dashboard` extension command with git staleness check |
| `extensions/memory-layer/commands/dashboard-tui.ts` | Create | TUI factory function `{ render, invalidate, handleInput }` |
| `extensions/memory-layer/index.ts` | Modify | Register dashboard command |

---

### Task 1: Data Aggregation — `data-access/dashboard.js`

**Files:**
- Create: `data-access/dashboard.js`
- Test: `test/data-access-dashboard.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/data-access-dashboard.test.js`:

```js
const { getDashboard } = require('../data-access/dashboard');

function mockDeps() {
  return {
    sqlJson: vi.fn(),
    sqlRun: vi.fn(),
  };
}

describe('data-access/dashboard', () => {
  describe('getDashboard', () => {
    it('should return overview with all fields', () => {
      const deps = mockDeps();
      // Each sqlJson call returns data for a different query in sequence
      deps.sqlJson
        .mockReturnValueOnce([{ cnt: 560 }])                          // totalMemories
        .mockReturnValueOnce([{ cnt: 4 }])                             // totalProjects
        .mockReturnValueOnce([{ cnt: 12 }])                            // thisWeekSaved
        .mockReturnValueOnce([{ cnt: 3 }])                             // thisWeekCleaned
        .mockReturnValueOnce([{ avg: 0.78 }])                          // avgTrust
        .mockReturnValueOnce([{ cnt: 34 }])                            // neverRecalled
        .mockReturnValueOnce([{ cnt: 2 }])                             // expiringSoon
        .mockReturnValueOnce([                                         // byType
          { type: 'decision', cnt: 142 },
          { type: 'bugfix', cnt: 89 },
        ])
        .mockReturnValueOnce([{                                        // trust buckets
          high: 80, medium: 30, low: 12, total: 122,
        }])
        .mockReturnValueOnce([{                                        // recall
          totalRecalls: 250, usefulRate: 0.72, uniqueMemoriesHit: 180,
        }])
        .mockReturnValueOnce([{ value: '2026-06-04T10:00:00.000Z' }]) // dream_last_run
        .mockReturnValueOnce([{ value: '47' }])                        // dream_total_cleaned
        .mockReturnValueOnce([{ value: '9' }])                         // dream_run_count
        .mockReturnValueOnce([                                         // codeIndex
          { name: 'PiMemoryExtension', path: '/some/path', file_count: 359, symbol_count: 8874, indexed_at: '2026-06-01', base_head: 'abc123' },
        ]);

      const result = getDashboard(deps);

      expect(result.overview.totalMemories).toBe(560);
      expect(result.overview.totalProjects).toBe(4);
      expect(result.overview.thisWeekSaved).toBe(12);
      expect(result.overview.thisWeekCleaned).toBe(3);
      expect(result.overview.avgTrust).toBe(0.78);
      expect(result.overview.neverRecalled).toBe(34);
      expect(result.overview.expiringSoon).toBe(2);
    });

    it('should return byType array sorted by count desc', () => {
      const deps = mockDeps();
      deps.sqlJson
        .mockReturnValueOnce([{ cnt: 100 }])                           // totalMemories
        .mockReturnValueOnce([{ cnt: 1 }])                              // totalProjects
        .mockReturnValueOnce([{ cnt: 0 }])                              // thisWeekSaved
        .mockReturnValueOnce([{ cnt: 0 }])                              // thisWeekCleaned
        .mockReturnValueOnce([{ avg: null }])                           // avgTrust
        .mockReturnValueOnce([{ cnt: 0 }])                              // neverRecalled
        .mockReturnValueOnce([{ cnt: 0 }])                              // expiringSoon
        .mockReturnValueOnce([                                          // byType
          { type: 'decision', cnt: 50 },
          { type: 'bugfix', cnt: 30 },
          { type: 'discovery', cnt: 20 },
        ])
        .mockReturnValueOnce([{ high: 0, medium: 0, low: 0, total: 0 }]) // trust
        .mockReturnValueOnce([{ totalRecalls: 0, usefulRate: null, uniqueMemoriesHit: 0 }]) // recall
        .mockReturnValueOnce([])                                        // dream_last_run
        .mockReturnValueOnce([])                                        // dream_total_cleaned
        .mockReturnValueOnce([])                                        // dream_run_count
        .mockReturnValueOnce([]);                                       // codeIndex

      const result = getDashboard(deps);
      expect(result.byType).toHaveLength(3);
      expect(result.byType[0].type).toBe('decision');
      expect(result.byType[0].count).toBe(50);
    });

    it('should return trust distribution with none count', () => {
      const deps = mockDeps();
      deps.sqlJson
        .mockReturnValueOnce([{ cnt: 200 }])                           // totalMemories
        .mockReturnValueOnce([{ cnt: 2 }])                              // totalProjects
        .mockReturnValueOnce([{ cnt: 0 }])                              // thisWeekSaved
        .mockReturnValueOnce([{ cnt: 0 }])                              // thisWeekCleaned
        .mockReturnValueOnce([{ avg: 0.9 }])                            // avgTrust
        .mockReturnValueOnce([{ cnt: 10 }])                             // neverRecalled
        .mockReturnValueOnce([{ cnt: 0 }])                              // expiringSoon
        .mockReturnValueOnce([])                                        // byType
        .mockReturnValueOnce([{ high: 80, medium: 30, low: 12, total: 122 }]) // trust
        .mockReturnValueOnce([{ totalRecalls: 0, usefulRate: null, uniqueMemoriesHit: 0 }]) // recall
        .mockReturnValueOnce([])                                        // dream_last_run
        .mockReturnValueOnce([])                                        // dream_total_cleaned
        .mockReturnValueOnce([])                                        // dream_run_count
        .mockReturnValueOnce([]);                                       // codeIndex

      const result = getDashboard(deps);
      expect(result.trust.high).toBe(80);
      expect(result.trust.medium).toBe(30);
      expect(result.trust.low).toBe(12);
      expect(result.trust.none).toBe(200 - 122); // totalMemories - tracked
      expect(result.trust.lowTrustCount).toBe(12);
    });

    it('should return dream stats as null when no settings exist', () => {
      const deps = mockDeps();
      deps.sqlJson
        .mockReturnValueOnce([{ cnt: 0 }])                              // totalMemories
        .mockReturnValueOnce([{ cnt: 0 }])                              // totalProjects
        .mockReturnValueOnce([{ cnt: 0 }])                              // thisWeekSaved
        .mockReturnValueOnce([{ cnt: 0 }])                              // thisWeekCleaned
        .mockReturnValueOnce([{ avg: null }])                           // avgTrust
        .mockReturnValueOnce([{ cnt: 0 }])                              // neverRecalled
        .mockReturnValueOnce([{ cnt: 0 }])                              // expiringSoon
        .mockReturnValueOnce([])                                        // byType
        .mockReturnValueOnce([{ high: 0, medium: 0, low: 0, total: 0 }]) // trust
        .mockReturnValueOnce([{ totalRecalls: 0, usefulRate: null, uniqueMemoriesHit: 0 }]) // recall
        .mockReturnValueOnce([])                                        // dream_last_run
        .mockReturnValueOnce([])                                        // dream_total_cleaned
        .mockReturnValueOnce([])                                        // dream_run_count
        .mockReturnValueOnce([]);                                       // codeIndex

      const result = getDashboard(deps);
      expect(result.dream.lastRun).toBeNull();
      expect(result.dream.totalCleaned).toBeNull();
      expect(result.dream.runCount).toBeNull();
    });

    it('should return codeIndex entries with path and base_head', () => {
      const deps = mockDeps();
      deps.sqlJson
        .mockReturnValueOnce([{ cnt: 0 }])                              // totalMemories
        .mockReturnValueOnce([{ cnt: 0 }])                              // totalProjects
        .mockReturnValueOnce([{ cnt: 0 }])                              // thisWeekSaved
        .mockReturnValueOnce([{ cnt: 0 }])                              // thisWeekCleaned
        .mockReturnValueOnce([{ avg: null }])                           // avgTrust
        .mockReturnValueOnce([{ cnt: 0 }])                              // neverRecalled
        .mockReturnValueOnce([{ cnt: 0 }])                              // expiringSoon
        .mockReturnValueOnce([])                                        // byType
        .mockReturnValueOnce([{ high: 0, medium: 0, low: 0, total: 0 }]) // trust
        .mockReturnValueOnce([{ totalRecalls: 0, usefulRate: null, uniqueMemoriesHit: 0 }]) // recall
        .mockReturnValueOnce([])                                        // dream_last_run
        .mockReturnValueOnce([])                                        // dream_total_cleaned
        .mockReturnValueOnce([])                                        // dream_run_count
        .mockReturnValueOnce([                                          // codeIndex
          { name: 'test-repo', path: '/tmp/test', file_count: 10, symbol_count: 50, indexed_at: '2026-06-01', base_head: 'abc123' },
        ]);

      const result = getDashboard(deps);
      expect(result.codeIndex).toHaveLength(1);
      expect(result.codeIndex[0].name).toBe('test-repo');
      expect(result.codeIndex[0].path).toBe('/tmp/test');
      expect(result.codeIndex[0].base_head).toBe('abc123');
      // isStale is NOT set here — set by extension command handler
      expect(result.codeIndex[0].isStale).toBeUndefined();
    });

    it('should gracefully handle missing expires_at column', () => {
      const deps = mockDeps();
      deps.sqlJson
        .mockReturnValueOnce([{ cnt: 0 }])                              // totalMemories
        .mockReturnValueOnce([{ cnt: 0 }])                              // totalProjects
        .mockReturnValueOnce([{ cnt: 0 }])                              // thisWeekSaved
        .mockReturnValueOnce([{ cnt: 0 }])                              // thisWeekCleaned
        .mockReturnValueOnce([{ avg: null }])                           // avgTrust
        .mockReturnValueOnce([{ cnt: 0 }])                              // neverRecalled
        .mockImplementationOnce(() => { throw new Error('no such column: expires_at'); }) // expiringSoon
        .mockReturnValueOnce([])                                        // byType
        .mockReturnValueOnce([{ high: 0, medium: 0, low: 0, total: 0 }]) // trust
        .mockReturnValueOnce([{ totalRecalls: 0, usefulRate: null, uniqueMemoriesHit: 0 }]) // recall
        .mockReturnValueOnce([])                                        // dream_last_run
        .mockReturnValueOnce([])                                        // dream_total_cleaned
        .mockReturnValueOnce([])                                        // dream_run_count
        .mockReturnValueOnce([]);                                       // codeIndex

      const result = getDashboard(deps);
      expect(result.overview.expiringSoon).toBe(0);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/data-access-dashboard.test.js`
Expected: FAIL — `Cannot find module '../data-access/dashboard'`

- [ ] **Step 3: Write the implementation**

Create `data-access/dashboard.js`:

```js
'use strict';

/**
 * Dashboard aggregation queries — read-only stats from memory DB.
 * All queries use sqlJson; no mutation.
 */
function getDashboard(deps) {
  const { sqlJson } = deps;
  const one = (query, params) => sqlJson(query, params)[0];

  // ── Overview ──────────────────────────────────────────────
  const totalMemories = one('SELECT COUNT(*) as cnt FROM observations WHERE deleted_at IS NULL').cnt;
  const totalProjects = one('SELECT COUNT(DISTINCT project) as cnt FROM observations WHERE deleted_at IS NULL').cnt;
  const thisWeekSaved = one("SELECT COUNT(*) as cnt FROM observations WHERE deleted_at IS NULL AND created_at >= datetime('now', '-7 days')").cnt;
  const thisWeekCleaned = one("SELECT COUNT(*) as cnt FROM observations WHERE deleted_at IS NOT NULL AND deleted_at >= datetime('now', '-7 days')").cnt;
  const avgTrustRow = one('SELECT AVG(trust_score) as avg FROM symbol_links');
  const avgTrust = avgTrustRow.avg ?? null;
  const neverRecalled = one(
    `SELECT COUNT(*) as cnt FROM observations o
     LEFT JOIN (SELECT DISTINCT memory_id FROM recall_log) rl ON rl.memory_id = o.id
     WHERE o.deleted_at IS NULL AND rl.memory_id IS NULL`,
  ).cnt;

  let expiringSoon = 0;
  try {
    expiringSoon = one(
      "SELECT COUNT(*) as cnt FROM observations WHERE expires_at IS NOT NULL AND expires_at < datetime('now', '+7 days') AND deleted_at IS NULL",
    ).cnt;
  } catch (_e) {
    // Column may not exist in older DBs
  }

  // ── By Type ───────────────────────────────────────────────
  const byTypeRaw = sqlJson(
    `SELECT type, COUNT(*) as cnt FROM observations
     WHERE deleted_at IS NULL AND type != 'skill'
     GROUP BY type ORDER BY cnt DESC`,
  );
  const byType = byTypeRaw.map((r) => ({ type: r.type, count: r.cnt }));

  // ── Trust ─────────────────────────────────────────────────
  const trustRow = one(
    `SELECT
       SUM(CASE WHEN trust_score >= 0.8 THEN 1 ELSE 0 END) as high,
       SUM(CASE WHEN trust_score >= 0.5 AND trust_score < 0.8 THEN 1 ELSE 0 END) as medium,
       SUM(CASE WHEN trust_score > 0 AND trust_score < 0.5 THEN 1 ELSE 0 END) as low,
       COUNT(*) as total
     FROM symbol_links`,
  );
  const trust = {
    avg: avgTrust,
    lowTrustCount: trustRow.low || 0,
    distribution: {
      high: trustRow.high || 0,
      medium: trustRow.medium || 0,
      low: trustRow.low || 0,
      none: totalMemories - (trustRow.total || 0),
    },
  };

  // ── Recall ────────────────────────────────────────────────
  const recallRow = one(
    `SELECT
       COUNT(*) as totalRecalls,
       AVG(CASE WHEN was_useful IS NOT NULL THEN was_useful END) as usefulRate,
       COUNT(DISTINCT memory_id) as uniqueMemoriesHit
     FROM recall_log`,
  );
  const recall = {
    totalRecalls: recallRow.totalRecalls || 0,
    usefulRate: recallRow.usefulRate ?? null,
    uniqueMemoriesHit: recallRow.uniqueMemoriesHit || 0,
  };

  // ── Dream Cycle ───────────────────────────────────────────
  const dreamLastRun = sqlJson("SELECT value FROM settings WHERE key = 'dream_last_run'");
  const dreamTotalCleaned = sqlJson("SELECT value FROM settings WHERE key = 'dream_total_cleaned'");
  const dreamRunCount = sqlJson("SELECT value FROM settings WHERE key = 'dream_run_count'");
  const dream = {
    lastRun: dreamLastRun[0]?.value || null,
    totalCleaned: dreamTotalCleaned[0]?.value || null,
    runCount: dreamRunCount[0]?.value || null,
  };

  // ── Code Index ────────────────────────────────────────────
  const codeIndexRaw = sqlJson(
    'SELECT name, path, file_count, symbol_count, indexed_at, base_head FROM code_repos',
  );
  const codeIndex = codeIndexRaw.map((r) => ({
    name: r.name,
    path: r.path,
    fileCount: r.file_count,
    symbolCount: r.symbol_count,
    indexedAt: r.indexed_at,
    base_head: r.base_head,
    // isStale is set by the extension command handler (requires git rev-parse)
  }));

  return {
    overview: {
      totalMemories,
      totalProjects,
      thisWeekSaved,
      thisWeekCleaned,
      avgTrust,
      neverRecalled,
      expiringSoon,
    },
    byType,
    trust,
    recall,
    dream,
    codeIndex,
  };
}

module.exports = { getDashboard };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/data-access-dashboard.test.js`
Expected: 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add data-access/dashboard.js test/data-access-dashboard.test.js
git commit -m "feat: dashboard data aggregation queries (#172)"
```

---

### Task 2: CLI Command Registration — `src/cli/commands/dashboard.js`

**Files:**
- Create: `src/cli/commands/dashboard.js`
- Modify: `src/cli/gateway.js` (lines 1-16: imports, lines 17-27: buildCommandMap)
- Test: `test/gateway-dispatch.test.js`

- [ ] **Step 1: Write the failing test**

Add to `test/gateway-dispatch.test.js`:

```js
it('should dispatch dashboard command', async () => {
  vi.doMock('../../db', () => ({
    ensureDb: vi.fn(),
    getDb: vi.fn(() => ({})),
    sqlJson: vi.fn((query) => {
      // Return minimal valid responses for dashboard queries
      if (query.includes('COUNT(*)')) return [{ cnt: 0 }];
      if (query.includes('AVG')) return [{ avg: null }];
      if (query.includes('SUM')) return [{ high: 0, medium: 0, low: 0, total: 0 }];
      if (query.includes('settings')) return [];
      if (query.includes('code_repos')) return [];
      if (query.includes('GROUP BY type')) return [];
      if (query.includes('recall_log')) return [{ totalRecalls: 0, usefulRate: null, uniqueMemoriesHit: 0 }];
      return [];
    }),
    sqlRun: vi.fn(),
    sqlRaw: vi.fn(),
    jsonErrNoExit: vi.fn((msg) => ({ error: msg })),
    DB_PATH: ':memory:',
    getEngine: vi.fn(() => 'sqlite'),
  }));

  vi.doMock('../../data-access/observations', () => ({ softDeleteObservation: vi.fn() }));
  vi.doMock('../../platform/storage/repositories', () => ({ createRepositories: vi.fn(() => ({})) }));
  vi.doMock('../../config', () => ({ getConfig: vi.fn(() => ({ tier_config_path: '/nonexistent' })) }));
  vi.doMock('fs', () => ({
    readFileSync: vi.fn(() => {
      throw new Error('no tier config');
    }),
  }));

  const { dispatch } = require('../src/cli/gateway');
  const result = await dispatch('dashboard', {});
  expect(result).toBeDefined();
  expect(result.overview).toBeDefined();
  expect(result.overview.totalMemories).toBe(0);
  expect(result.byType).toEqual([]);
  expect(result.codeIndex).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/gateway-dispatch.test.js`
Expected: FAIL — `Unknown command: dashboard`

- [ ] **Step 3: Create the CLI command router**

Create `src/cli/commands/dashboard.js`:

```js
'use strict';

const { getDashboard } = require('../../data-access/dashboard');

const USAGE = {};

function register(commands, deps) {
  commands.dashboard = () => getDashboard(deps);
}

module.exports = { register, USAGE };
```

- [ ] **Step 4: Register in gateway**

In `src/cli/gateway.js`, add the import at the top (after the existing router imports, around line 8):

```js
const dashboardRouter = require('./commands/dashboard');
```

In `buildCommandMap` (around line 25), add:

```js
dashboardRouter.register(commands, deps);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/gateway-dispatch.test.js`
Expected: 2 tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/dashboard.js src/cli/gateway.js test/gateway-dispatch.test.js
git commit -m "feat: register dashboard command in CLI gateway (#172)"
```

---

### Task 3: Dream Cycle Stats Persistence — `src/memory-domain/compaction.js`

**Files:**
- Modify: `src/memory-domain/compaction.js` (lines 315-317: before `return report;`)

- [ ] **Step 1: Write the failing test**

Create `test/compaction-dream-stats.test.js`:

```js
describe('dream cycle stats persistence', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('should persist dream stats to settings on successful dream', () => {
    const sqlJsonCalls = [];
    const sqlRunCalls = [];
    const deps = {
      sqlJson: vi.fn((query, params) => {
        sqlJsonCalls.push({ query, params });
        if (query.includes('observations WHERE expires_at')) return [{ cnt: 0 }];
        if (query.includes('superseded')) return [];
        if (query.includes('stale')) return [];
        if (query.includes('Auto-detected')) return [];
        if (query.includes('CORRECTION')) return [];
        if (query.includes('replaced config')) return [];
        if (query.includes('obsolete')) return [];
        if (query.includes('noise')) return [];
        if (query.includes('topic_key')) return [];
        if (query.includes('topicGroups')) return [];
        if (query.includes('dream_total_cleaned')) return [{ value: '10' }];
        if (query.includes('dream_run_count')) return [{ value: '2' }];
        return [];
      }),
      sqlRun: vi.fn((query, params) => {
        sqlRunCalls.push({ query, params });
      }),
      sqlRaw: vi.fn(),
      softDeleteObservation: vi.fn(),
    };

    const { dream } = require('../src/memory-domain/compaction');
    const report = dream(deps);

    expect(report.ok).toBe(true);
    // Verify settings writes
    const settingsWrites = sqlRunCalls.filter((c) => c.query.includes('settings'));
    expect(settingsWrites).toHaveLength(3);
    expect(settingsWrites[0].query).toContain('dream_last_run');
    expect(settingsWrites[1].query).toContain('dream_total_cleaned');
    expect(settingsWrites[1].params[0]).toBe('10'); // previous 10 + 0 cleaned
    expect(settingsWrites[2].query).toContain('dream_run_count');
    expect(settingsWrites[2].params[0]).toBe('3'); // previous 2 + 1
  });

  it('should NOT persist dream stats when dream fails', () => {
    const sqlRunCalls = [];
    const deps = {
      sqlJson: vi.fn(() => {
        throw new Error('DB error');
      }),
      sqlRun: vi.fn((query, params) => {
        sqlRunCalls.push({ query, params });
      }),
      sqlRaw: vi.fn(),
      softDeleteObservation: vi.fn(),
    };

    const { dream } = require('../src/memory-domain/compaction');
    const report = dream(deps);

    expect(report.ok).toBe(false);
    const settingsWrites = sqlRunCalls.filter((c) => c.query.includes('settings'));
    expect(settingsWrites).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/compaction-dream-stats.test.js`
Expected: FAIL — settings writes not found (0 instead of 3)

- [ ] **Step 3: Add dream stats persistence to compaction.js**

In `src/memory-domain/compaction.js`, insert the following block **right before the final `return report;`** in the `dream()` function (currently at line 317). The insertion point is after `report.cleaned = cleanedIds;` (line 316):

```js
  // Persist dream cycle stats to settings (guarded on success)
  if (report.ok) {
    try {
      const currentTotal = parseInt(
        deps.sqlJson("SELECT value FROM settings WHERE key = 'dream_total_cleaned'")[0]?.value || '0',
        10,
      );
      const currentCount = parseInt(
        deps.sqlJson("SELECT value FROM settings WHERE key = 'dream_run_count'")[0]?.value || '0',
        10,
      );
      deps.sqlRun("INSERT OR REPLACE INTO settings (key, value) VALUES ('dream_last_run', ?)", [report.completedAt]);
      deps.sqlRun("INSERT OR REPLACE INTO settings (key, value) VALUES ('dream_total_cleaned', ?)", [String(currentTotal + totalCleaned)]);
      deps.sqlRun("INSERT OR REPLACE INTO settings (key, value) VALUES ('dream_run_count', ?)", [String(currentCount + 1)]);
    } catch (_e) {
      // Non-critical — dashboard will show "no data" if this fails
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/compaction-dream-stats.test.js`
Expected: 2 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/memory-domain/compaction.js test/compaction-dream-stats.test.js
git commit -m "feat: persist dream cycle stats to settings table (#172)"
```

---

### Task 4: Extension Command — `extensions/memory-layer/commands/dashboard.ts`

**Files:**
- Create: `extensions/memory-layer/commands/dashboard.ts`
- Modify: `extensions/memory-layer/index.ts`

- [ ] **Step 1: Create the extension command**

Create `extensions/memory-layer/commands/dashboard.ts`:

```ts
import { execFileSync } from 'node:child_process';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { mem } from '../host/memory-client';
import { createDashboardComponent } from './dashboard-tui';

export function registerDashboardCommand(pi: ExtensionAPI) {
  pi.registerCommand('dashboard', {
    description: 'Memory health dashboard',
    handler: async (_args, ctx) => {
      const data = await mem('dashboard', {});
      if (!data || !data.overview) {
        ctx.ui.notify('Failed to load dashboard data', 'error');
        return;
      }
      // Enrich code index entries with staleness (requires git rev-parse — side effect)
      if (data.codeIndex) {
        for (const repo of data.codeIndex) {
          try {
            const head = execFileSync('git', ['rev-parse', 'HEAD'], {
              cwd: repo.path,
              encoding: 'utf-8',
            }).trim();
            repo.isStale = head !== repo.base_head;
          } catch {
            repo.isStale = true;
          }
        }
      }
      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        return createDashboardComponent(data, theme, tui, done);
      });
    },
  });
}
```

- [ ] **Step 2: Register in index.ts**

In `extensions/memory-layer/index.ts`, add the import (after existing imports, around line 20):

```ts
import { registerDashboardCommand } from './commands/dashboard';
```

Add the registration (after the existing `safeRegister` calls, around line 60):

```ts
  safeRegister(pi, deps, 'dashboard command', registerDashboardCommand);
```

- [ ] **Step 3: Commit**

```bash
git add extensions/memory-layer/commands/dashboard.ts extensions/memory-layer/index.ts
git commit -m "feat: register /dashboard extension command (#172)"
```

---

### Task 5: TUI Component — `extensions/memory-layer/commands/dashboard-tui.ts`

**Files:**
- Create: `extensions/memory-layer/commands/dashboard-tui.ts`

- [ ] **Step 1: Create the TUI component**

Create `extensions/memory-layer/commands/dashboard-tui.ts`:

```ts
import { matchesKey, Key, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

interface DashboardData {
  overview: {
    totalMemories: number;
    totalProjects: number;
    thisWeekSaved: number;
    thisWeekCleaned: number;
    avgTrust: number | null;
    neverRecalled: number;
    expiringSoon: number;
  };
  byType: Array<{ type: string; count: number }>;
  trust: {
    avg: number | null;
    lowTrustCount: number;
    distribution: { high: number; medium: number; low: number; none: number };
  };
  recall: {
    totalRecalls: number;
    usefulRate: number | null;
    uniqueMemoriesHit: number;
  };
  dream: {
    lastRun: string | null;
    totalCleaned: string | null;
    runCount: string | null;
  };
  codeIndex: Array<{
    name: string;
    path: string;
    fileCount: number;
    symbolCount: number;
    indexedAt: string;
    base_head: string;
    isStale?: boolean;
  }>;
}

interface Theme {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
}

function formatRelativeTime(isoString: string | null): string {
  if (!isoString) return 'Never';
  const diff = Date.now() - new Date(isoString).getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return `${months} month${months > 1 ? 's' : ''} ago`;
}

function pct(value: number | null, total: number): string {
  if (value === null || total === 0) return '—';
  return `${Math.round((value / total) * 100)}%`;
}

function bar(count: number, maxCount: number, maxWidth: number): string {
  if (maxCount === 0) return '';
  const len = Math.max(1, Math.round((count / maxCount) * maxWidth));
  return '█'.repeat(len);
}

export function createDashboardComponent(
  data: DashboardData,
  theme: Theme,
  tui: { requestRender: () => void },
  done: (value: void) => void,
) {
  let cachedWidth: number | undefined;
  let cachedLines: string[] = [];

  function buildLines(width: number): string[] {
    const lines: string[] = [];
    const inner = width - 4; // space for ╭─ ─╮ borders
    const maxBarWidth = Math.max(10, inner - 20); // reserve space for label + count
    const maxTypeCount = data.byType.reduce((mx, t) => Math.max(mx, t.count), 0);

    const border = (char: string) => char.repeat(Math.max(1, inner));
    const section = (title: string) => theme.fg('accent', theme.bold(title));
    const dim = (s: string) => theme.fg('dim', s);

    // ── Header ────────────────────────────────────────────
    lines.push(dim('╭─ ') + theme.fg('accent', theme.bold('LaPis Memory Dashboard')) + dim(' ' + border('─') + '╮'));

    // ── Overview ──────────────────────────────────────────
    const o = data.overview;
    lines.push(dim('│ ') + `Total: ${o.totalMemories} memories across ${o.totalProjects} projects`.padEnd(inner) + dim('│'));
    lines.push(dim('│ ') + `This Week: +${o.thisWeekSaved} saved, -${o.thisWeekCleaned} cleaned`.padEnd(inner) + dim('│'));
    const trustLabel = o.avgTrust !== null ? o.avgTrust.toFixed(2) : '—';
    const recallLabel = data.recall.totalRecalls > 0
      ? pct(data.recall.uniqueMemoriesHit, data.recall.totalRecalls)
      : '—';
    lines.push(dim('│ ') + `Avg Trust: ${trustLabel}  │  Recall Hit Rate: ${recallLabel}`.padEnd(inner) + dim('│'));

    // ── By Type ───────────────────────────────────────────
    lines.push(dim('├') + border('─') + dim('┤'));
    lines.push(dim('│ ') + section('By Type'));
    for (const t of data.byType) {
      const label = t.type.padEnd(12);
      const b = bar(t.count, maxTypeCount, maxBarWidth);
      const countStr = String(t.count);
      lines.push(dim('│ ') + `  ${label} ${b}  ${countStr}`);
    }

    // ── Health Alerts ─────────────────────────────────────
    lines.push(dim('├') + border('─') + dim('┤'));
    lines.push(dim('│ ') + section('Health Alerts'));

    const trustAlert = data.trust.lowTrustCount > 0
      ? theme.fg('warning', `⚠ Low Trust (<0.5):    ${data.trust.lowTrustCount} memories`)
      : theme.fg('success', `✓ Low Trust (<0.5):     0 memories`);
    lines.push(dim('│ ') + `  ${trustAlert}`);

    const recallAlert = o.neverRecalled > 0
      ? theme.fg('warning', `⚠ Never Recalled:      ${o.neverRecalled} memories`)
      : theme.fg('success', `✓ Never Recalled:       0 memories`);
    lines.push(dim('│ ') + `  ${recallAlert}`);

    const expiringAlert = o.expiringSoon > 0
      ? theme.fg('warning', `⏳ Expiring Soon:        ${o.expiringSoon} memories`)
      : theme.fg('success', `✓ Expiring Soon:        0 memories`);
    lines.push(dim('│ ') + `  ${expiringAlert}`);

    // ── Dream Cycle ───────────────────────────────────────
    lines.push(dim('├') + border('─') + dim('┤'));
    lines.push(dim('│ ') + section('Dream Cycle'));
    const lastRun = formatRelativeTime(data.dream.lastRun);
    const totalCleaned = data.dream.totalCleaned ?? '—';
    const runCount = data.dream.runCount ?? '—';
    lines.push(dim('│ ') + `  Last Run: ${lastRun}  │  Runs: ${runCount}  │  Cleaned: ${totalCleaned}`);

    // ── Code Index ────────────────────────────────────────
    lines.push(dim('├') + border('─') + dim('┤'));
    lines.push(dim('│ ') + section('Code Index'));
    for (const repo of data.codeIndex) {
      const stale = repo.isStale
        ? theme.fg('warning', '⚠ STALE')
        : theme.fg('success', '✅');
      lines.push(dim('│ ') + `  ${repo.name.padEnd(22)} ${String(repo.fileCount).padStart(4)} files, ${String(repo.symbolCount).padStart(5)} symbols  ${stale}`);
    }
    if (data.codeIndex.length === 0) {
      lines.push(dim('│ ') + '  No repos indexed');
    }

    // ── Footer ────────────────────────────────────────────
    lines.push(dim('╰') + border('─') + dim('╯'));
    lines.push(dim(' [q] close'));

    // Truncate all lines to width
    return lines.map((line) => truncateToWidth(line, width));
  }

  return {
    render(width: number): string[] {
      if (cachedLines.length && cachedWidth === width) {
        return cachedLines;
      }
      cachedLines = buildLines(width);
      cachedWidth = width;
      return cachedLines;
    },

    handleInput(input: string): void {
      if (matchesKey(input, Key.escape) || input === 'q') {
        done();
        return;
      }
    },

    invalidate(): void {
      cachedWidth = undefined;
      cachedLines = [];
    },
  };
}
```

- [ ] **Step 2: Verify it compiles (TS is transpiled by jiti at runtime, so just check for obvious errors)**

Run: `npx tsc --noEmit extensions/memory-layer/commands/dashboard-tui.ts --esModuleInterop --moduleResolution node --skipLibCheck 2>&1 | head -20`

If there are import resolution errors from `@earendil-works/pi-tui` that's expected — jiti resolves these at runtime. Just verify no syntax errors.

- [ ] **Step 3: Commit**

```bash
git add extensions/memory-layer/commands/dashboard-tui.ts
git commit -m "feat: dashboard TUI component with bar charts and sections (#172)"
```

---

### Task 6: Integration Test — Verify the full pipeline

**Files:**
- No new files

- [ ] **Step 1: Run all tests**

Run: `npx vitest run`
Expected: All existing + new tests pass

- [ ] **Step 2: Test the command manually (if possible)**

If pi is available in the current environment, run:

```bash
pi -e extensions/memory-layer/index.ts
```

Then type `/dashboard` in the pi prompt. Verify:
- The dashboard renders with box drawing characters
- Bar charts appear for memory types
- Pressing `q` or Escape closes the dashboard
- Code index shows repos with ✅ or ⚠ STALE

- [ ] **Step 3: Final commit (if any fixes were needed)**

```bash
git add -A
git commit -m "fix: integration fixes for dashboard (#172)"
```
