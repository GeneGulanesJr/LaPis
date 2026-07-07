import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createGitTrustSyncAdapter } from '../../../src/trust-sync/change-detector';
import { getKnownRepos } from '../host/project-detector';
import { mem } from '../host/memory-client';
import { state } from '../state';

interface TrustSyncDeps {
  state: typeof state;
  mem: typeof mem;
  getKnownRepos: typeof getKnownRepos;
}

export function registerTrustSync(pi: ExtensionAPI, deps: TrustSyncDeps) {
  pi.on('tool_result', async (event, ctx) => {
    if (event.toolName === 'bash') {
      const input = event.input as { command?: string };
      const cmd = input?.command || '';
      if (/\bgit(?:\s+-C\s+\S+)?\s+(pull|checkout|merge|rebase|reset|stash\s+pop)\b/.test(cmd) && deps.state.currentProject) {
        const repos = await deps.getKnownRepos();
        const repo = repos.find((r) => r.name.toLowerCase() === deps.state.currentProject!.toLowerCase());
        if (repo) {
          const syncGitOperation = createGitTrustSyncAdapter(deps.mem, (message: string, level: 'info') =>
            ctx.ui.notify(message, level),
          );
          await syncGitOperation(repo.name);
        }
      }
    }
  });
}
