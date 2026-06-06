# Memory Dashboard TUI — Design Spec

**Date:** 2026-06-06
**Issue:** #172
**Scope:** `/dashboard` command with interactive TUI, data aggregation, and dream cycle stat persistence

## Overview

Add a `/dashboard` command to the memory-layer extension that opens an interactive TUI component showing memory health: total counts, type distribution with bar charts, trust score health, recall hit rates, dream cycle stats, and code index freshness.

## Architecture

```
/dashboard command (extension)
    ↓ calls
mem('dashboard')  (CLI gateway dispatch)
    ↓ calls
getDashboard(deps) (data-access/dashboard.js — aggregate queries)
```

Three layers matching existing patterns (extension → gateway → data-access). The dream function also gets a small change to persist cycle stats to the `settings` table.

## Data Aggregation — `data-access/dashboard.js` (new)

One exported function `getDashboard(deps)` that returns:

```js
{
  overview: {
    totalMemories,        // COUNT from observations WHERE deleted_at IS NULL
    totalProjects,        // COUNT(DISTINCT project)
    thisWeekSaved,        // created_at >= now - 7 days
    thisWeekCleaned,      // deleted_at >= now - 7 days
    avgTrust,             // AVG(trust_score) from symbol_links
    neverRecalled,        // observations with 0 recall_log entries (LEFT JOIN)
    expiringSoon,         // expires_at within 7 days (or null if column absent)
  },
  byType: [               // GROUP BY type WHERE deleted_at IS NULL, ORDER BY cnt DESC
    { type: 'decision', count: 142 },
  ],
  trust: {
    avg,                  // overall average from symbol_links
    lowTrustCount,        // trust_score < 0.5
    distribution: {       // bucketed counts
      high,               // >= 0.8
      medium,             // 0.5–0.79
      low,                // 0.1–0.49
      none,               // no symbol_links row (trust = default 1.0, not tracked)
    },
  },
  recall: {
    totalRecalls,         // COUNT(*) from recall_log
    usefulRate,           // AVG(was_useful) where was_useful IS NOT NULL
    uniqueMemoriesHit,    // COUNT(DISTINCT memory_id) from recall_log
  },
  dream: {
    lastRun,              // from settings key 'dream_last_run' (ISO string or null)
    totalCleaned,         // from settings key 'dream_total_cleaned' (integer string or null)
    runCount,             // from settings key 'dream_run_count' (integer string or null)
  },
  codeIndex: [            // from code_repos
    {
      name,
      fileCount,
      symbolCount,
      indexedAt,          // ISO string
      isStale,            // boolean — determined by comparing base_head to current HEAD
    },
  ],
}
```

Queries are read-only `sqlJson` calls. No new tables or columns needed.

### Query details

**overview.totalMemories:**
```sql
SELECT COUNT(*) as cnt FROM observations WHERE deleted_at IS NULL
```

**overview.totalProjects:**
```sql
SELECT COUNT(DISTINCT project) as cnt FROM observations WHERE deleted_at IS NULL
```

**overview.thisWeekSaved:**
```sql
SELECT COUNT(*) as cnt FROM observations
WHERE deleted_at IS NULL AND created_at >= datetime('now', '-7 days')
```

**overview.thisWeekCleaned:**
```sql
SELECT COUNT(*) as cnt FROM observations
WHERE deleted_at IS NOT NULL AND deleted_at >= datetime('now', '-7 days')
```

**overview.avgTrust:**
```sql
SELECT AVG(trust_score) as avg FROM symbol_links
```

**overview.neverRecalled:**
```sql
SELECT COUNT(*) as cnt FROM observations o
LEFT JOIN (SELECT DISTINCT memory_id FROM recall_log) rl ON rl.memory_id = o.id
WHERE o.deleted_at IS NULL AND rl.memory_id IS NULL
```

**overview.expiringSoon:**
Gracefully handle missing `expires_at` column (older DBs) — catch and return 0.

**byType:**
```sql
SELECT type, COUNT(*) as cnt FROM observations
WHERE deleted_at IS NULL AND type != 'skill'
GROUP BY type ORDER BY cnt DESC
```

**trust:**
```sql
SELECT
  SUM(CASE WHEN trust_score >= 0.8 THEN 1 ELSE 0 END) as high,
  SUM(CASE WHEN trust_score >= 0.5 AND trust_score < 0.8 THEN 1 ELSE 0 END) as medium,
  SUM(CASE WHEN trust_score > 0 AND trust_score < 0.5 THEN 1 ELSE 0 END) as low,
  COUNT(*) as total
FROM symbol_links
```
Plus `none` = totalMemories - total. Uses `SUM(CASE)` instead of `FILTER (WHERE)` for broader SQLite compatibility.

**recall:**
```sql
SELECT
  COUNT(*) as totalRecalls,
  AVG(CASE WHEN was_useful IS NOT NULL THEN was_useful END) as usefulRate,
  COUNT(DISTINCT memory_id) as uniqueMemoriesHit
FROM recall_log
```

**dream:** Read 3 keys from `settings` table. Return null defaults if missing.

**codeIndex:**
```sql
SELECT name, file_count, symbol_count, indexed_at, base_head FROM code_repos
```
Staleness: compare `base_head` to actual git HEAD at the repo path. If different or path missing, `isStale = true`.

## Dream Cycle Persistence — modify `src/memory-domain/compaction.js`

At the end of `dream()`, after `report.totalCleaned = totalCleaned`, before the return:

```js
// Persist dream cycle stats to settings
try {
  const currentTotal = parseInt(
    deps.sqlJson("SELECT value FROM settings WHERE key = 'dream_total_cleaned'")[0]?.value || '0',
    10
  );
  const currentCount = parseInt(
    deps.sqlJson("SELECT value FROM settings WHERE key = 'dream_run_count'")[0]?.value || '0',
    10
  );
  deps.sqlRun("INSERT OR REPLACE INTO settings (key, value) VALUES ('dream_last_run', ?)", [report.completedAt]);
  deps.sqlRun("INSERT OR REPLACE INTO settings (key, value) VALUES ('dream_total_cleaned', ?)", [String(currentTotal + totalCleaned)]);
  deps.sqlRun("INSERT OR REPLACE INTO settings (key, value) VALUES ('dream_run_count', ?)", [String(currentCount + 1)]);
} catch (_e) {
  // Non-critical — dashboard will show "no data" if this fails
}
```

Wrapped in try/catch so a settings table issue never breaks the dream cycle itself.

## CLI Registration — `src/cli/commands/dashboard.js` (new)

```js
const { getDashboard } = require('../../data-access/dashboard');

function register(commands, deps) {
  commands.dashboard = () => getDashboard(deps);
}

module.exports = { register };
```

## Gateway Registration — modify `src/cli/gateway.js`

Add import and registration alongside existing routers:

```js
const dashboardRouter = require('./commands/dashboard');
// In buildCommandMap:
dashboardRouter.register(commands, deps);
```

## Extension Command — `extensions/memory-layer/commands/dashboard.ts` (new)

```ts
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { mem } from '../host/memory-client';
import { DashboardComponent } from './dashboard-tui';

export function registerDashboardCommand(pi: ExtensionAPI) {
  pi.registerCommand('dashboard', {
    description: 'Memory health dashboard',
    handler: async (_args, ctx) => {
      const data = await mem('dashboard', {});
      if (!data || !data.overview) {
        ctx.ui.notify('Failed to load dashboard data', 'error');
        return;
      }
      await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
        return new DashboardComponent(data, theme, done);
      });
    },
  });
}
```

Register in `extensions/memory-layer/index.ts`:
```ts
import { registerDashboardCommand } from './commands/dashboard';
safeRegister(pi, deps, 'dashboard command', registerDashboardCommand);
```

## TUI Component — `extensions/memory-layer/commands/dashboard-tui.ts` (new)

Implements the `Component` interface from `@earendil-works/pi-tui`.

### Layout

Single viewport, scrollable. Sections separated by horizontal rules. Bottom bar shows keybindings.

```
╭─ LaPis Memory Dashboard ────────────────────────────╮
│ Total: 560 memories across 4 projects               │
│ This Week: +12 saved, -3 cleaned                    │
│ Avg Trust: 0.78  │  Recall Hit Rate: 72%            │
├──────────────────────────────────────────────────────┤
│ By Type                                              │
│   decision  ██████████████████████  142              │
│   bugfix    ████████████            89               │
│   discovery ████████                67               │
│   pattern   █████                   45               │
│   progress  ████████████████████   120 (auto)        │
├──────────────────────────────────────────────────────┤
│ Health Alerts                                        │
│   ⚠ Low Trust (<0.5):    12 memories                │
│   ⚠ Never Recalled:      34 memories                │
│   ⏳ Expiring Soon:        2 memories                │
├──────────────────────────────────────────────────────┤
│ Dream Cycle                                          │
│   Last Run: 2 days ago  │  Runs: 9  │  Cleaned: 47  │
├──────────────────────────────────────────────────────┤
│ Code Index                                            │
│   PiMemoryExtension  359 files, 8874 symbols  ✅     │
│   other-repo         102 files, 2140 symbols   ⚠ STALE│
╰──────────────────────────────────────────────────────╯
 [↑↓] scroll  [q] close
```

### Behavior

- **Width-aware**: `render(width)` calculates bar lengths relative to available width
- **Bar chart**: `█` chars, scaled to max count in byType array, max bar width = `width - type_label_len - count_len - padding`
- **Scroll**: tracks `scrollOffset`, adjusts which lines render. Up/Down arrows move by 1 line, Page Up/Down by 5
- **Close**: `q` or Escape calls `done()`
- **Color**: use `theme.fg()` for:
  - Green (`success`) for healthy metrics
  - Yellow (`warning`) for moderate alerts
  - Red (`error`) for high alerts
  - Dim (`dim`) for labels, accent for section headers

### Component structure

```ts
class DashboardComponent implements Component {
  private data: DashboardData;
  private theme: Theme;
  private done: (value: void) => void;
  private scrollOffset: number = 0;
  private allLines: string[] = [];  // pre-rendered, recalculated on render

  constructor(data, theme, done) { ... }

  render(width: number): string[] {
    // Build allLines from data
    // Return visible slice based on scrollOffset and terminal height
  }

  handleInput(data: string): void {
    // up arrow: scrollOffset--
    // down arrow: scrollOffset++
    // page up: scrollOffset -= 5
    // page down: scrollOffset += 5
    // q / escape: done()
  }

  invalidate(): void {
    this.allLines = [];
  }
}
```

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `data-access/dashboard.js` | **New** | Aggregation queries |
| `src/cli/commands/dashboard.js` | **New** | CLI command registration |
| `src/cli/gateway.js` | **Modify** | Add dashboard router |
| `src/memory-domain/compaction.js` | **Modify** | Persist dream stats to settings |
| `extensions/memory-layer/commands/dashboard.ts` | **New** | `/dashboard` command |
| `extensions/memory-layer/commands/dashboard-tui.ts` | **New** | TUI component |
| `extensions/memory-layer/index.ts` | **Modify** | Register dashboard command |

## Out of Scope (future)

- `--json` flag for programmatic consumption
- `--web` / browser variant
- HTTP `/api/dashboard` endpoint
- Drill-down into specific memories from the dashboard
- Real-time auto-refresh
