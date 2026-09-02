import { Key, matchesKey, truncateToWidth } from '@earendil-works/pi-tui';

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
  if (!isoString) {
    return 'Never';
  }
  const diff = Date.now() - new Date(isoString).getTime(),
    days = Math.floor(diff / 86400000),
    months = !(days === 0) && !(days === 1) && !(days < 30) ? Math.floor(days / 30) : undefined;
  if (days === 0) {
    return 'Today';
  }
  if (days === 1) {
    return 'Yesterday';
  }
  if (days < 30) {
    return `${days} days ago`;
  }
  return `${months} month${months > 1 ? 's' : ''} ago`;
}

function bar(count: number, maxCount: number, maxWidth: number): string {
  if (maxCount === 0 || maxWidth <= 0) {
    return '';
  }
  const len = Math.max(1, Math.round((count / maxCount) * maxWidth));
  return '█'.repeat(len);
}

export function createDashboardComponent(
  data: DashboardData,
  theme: Theme,
  tui: { requestRender: () => void },
  done: (value: void) => void,
) {
  let cachedWidth: number | undefined,
    cachedLines: string[] = [];

  function buildLines(width: number): string[] {
    const lines: string[] = [],
      inner = Math.max(20, width - 4),
      maxBarWidth = Math.max(10, inner - 24),
      maxTypeCount = data.byType.reduce((mx, t) => Math.max(mx, t.count), 0),
      hr = (char: string) => char.repeat(inner),
      section = (title: string) => theme.fg('accent', theme.bold(title)),
      dim = (s: string) => theme.fg('dim', s),
      // ── Header ────────────────────────────────────────────
      titleText = 'LaPis Memory Dashboard',
      titlePad = Math.max(0, inner - titleText.length - 2),
      o = (() => {
        lines.push(
          `${dim('╭─ ') + theme.fg('accent', theme.bold(titleText))} ${dim(hr('─').slice(0, titlePad))}${dim('╮')}`,
        );

        // ── Overview ──────────────────────────────────────────

        return data.overview;
      })();
    lines.push(`${dim('│ ')}Total: ${o.totalMemories} memories across ${o.totalProjects} projects${dim('│')}`);
    lines.push(`${dim('│ ')}This Week: +${o.thisWeekSaved} saved, -${o.thisWeekCleaned} cleaned${dim('│')}`);
    const trustLabel = o.avgTrust !== null ? o.avgTrust.toFixed(2) : '—',
      recallRate =
        data.recall.totalRecalls > 0
          ? `${Math.round((data.recall.uniqueMemoriesHit / data.recall.totalRecalls) * 100)}%`
          : '—',
      trustAlert = (() => {
        lines.push(`${dim('│ ')}Avg Trust: ${trustLabel}  │  Recall Hit Rate: ${recallRate}${dim('│')}`);

        // ── By Type ───────────────────────────────────────────
        lines.push(dim('├') + hr('─') + dim('┤'));
        lines.push(dim('│ ') + section('By Type'));
        for (const t of data.byType) {
          const label = t.type.padEnd(12),
            b = bar(t.count, maxTypeCount, maxBarWidth),
            countStr = String(t.count);
          lines.push(`${dim('│ ')}  ${label} ${b}  ${countStr}`);
        }

        // ── Health Alerts ─────────────────────────────────────
        lines.push(dim('├') + hr('─') + dim('┤'));
        lines.push(dim('│ ') + section('Health Alerts'));

        return data.trust.lowTrustCount > 0
          ? theme.fg('warning', `⚠ Low Trust (<0.5):    ${data.trust.lowTrustCount} memories`)
          : theme.fg('success', `✓ Low Trust (<0.5):     0 memories`);
      })();
    lines.push(`${dim('│ ')}  ${trustAlert}`);

    const recallAlert =
        o.neverRecalled > 0
          ? theme.fg('warning', `⚠ Never Recalled:      ${o.neverRecalled} memories`)
          : theme.fg('success', `✓ Never Recalled:       0 memories`),
      expiringAlert = (() => {
        lines.push(`${dim('│ ')}  ${recallAlert}`);

        return o.expiringSoon > 0
          ? theme.fg('warning', `⏳ Expiring Soon:        ${o.expiringSoon} memories`)
          : theme.fg('success', `✓ Expiring Soon:        0 memories`);
      })();
    lines.push(`${dim('│ ')}  ${expiringAlert}`);

    // ── Dream Cycle ───────────────────────────────────────
    lines.push(dim('├') + hr('─') + dim('┤'));
    lines.push(dim('│ ') + section('Dream Cycle'));
    const lastRun = formatRelativeTime(data.dream.lastRun),
      totalCleaned = data.dream.totalCleaned ?? '—',
      runCount = data.dream.runCount ?? '—';
    lines.push(`${dim('│ ')}  Last Run: ${lastRun}  │  Runs: ${runCount}  │  Cleaned: ${totalCleaned}`);

    // ── Code Index ────────────────────────────────────────
    lines.push(dim('├') + hr('─') + dim('┤'));
    lines.push(dim('│ ') + section('Code Index'));
    for (const repo of data.codeIndex) {
      const stale = repo.isStale ? theme.fg('warning', '⚠ STALE') : theme.fg('success', '✅');
      lines.push(
        `${dim(
          '│ ',
        )}  ${repo.name.padEnd(22)} ${String(repo.fileCount).padStart(4)} files, ${String(repo.symbolCount).padStart(5)} symbols  ${stale}`,
      );
    }
    if (data.codeIndex.length === 0) {
      lines.push(`${dim('│ ')}  No repos indexed`);
    }

    // ── Footer ────────────────────────────────────────────
    lines.push(dim('╰') + hr('─') + dim('╯'));
    lines.push(dim(' [q] close'));

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
