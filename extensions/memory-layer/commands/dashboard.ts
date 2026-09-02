import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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
            if (!existsSync(repo.path)) {
              repo.isStale = true;
              continue;
            }
            const head = execFileSync('git', ['rev-parse', 'HEAD'], {
              cwd: repo.path,
              encoding: 'utf-8',
              stdio: ['ignore', 'pipe', 'pipe'],
            }).trim();
            repo.isStale = head !== repo.base_head;
          } catch {
            repo.isStale = true;
          }
        }
      }
      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => createDashboardComponent(data, theme, tui, done));
    },
  });
}
