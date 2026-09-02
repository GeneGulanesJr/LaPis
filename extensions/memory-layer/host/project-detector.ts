import { type DocRepoInfo, REPO_CACHE_TTL, type RepoInfo, state } from '../state';
import { mem, memCmd } from './memory-client';
import path from 'node:path';

export { type RepoInfo, type DocRepoInfo };

export async function getKnownRepos(): Promise<RepoInfo[]> {
  const now = Date.now();
  if (state.cachedRepos && now - state.repoCacheTime < REPO_CACHE_TTL) {
    return state.cachedRepos;
  }
  const result = await memCmd('list-code-repos');
  if (!result || !(result as any).repos) {
    return state.cachedRepos || [];
  }
  state.cachedRepos = (result as any).repos as RepoInfo[];
  state.repoCacheTime = now;
  return state.cachedRepos;
}

export async function getKnownDocRepos(): Promise<DocRepoInfo[]> {
  const now = Date.now();
  if (state.cachedDocRepos && now - state.docRepoCacheTime < REPO_CACHE_TTL) {
    return state.cachedDocRepos;
  }
  const result = await memCmd('list-doc-repos');
  if (!result || !(result as any).repos) {
    return state.cachedDocRepos || [];
  }
  state.cachedDocRepos = (result as any).repos as DocRepoInfo[];
  state.docRepoCacheTime = now;
  return state.cachedDocRepos;
}

export function invalidateRepoCache(): void {
  state.cachedRepos = null;
  state.repoCacheTime = 0;
  state.cachedDocRepos = null;
  state.docRepoCacheTime = 0;
}

export function isRepoStale(repo: RepoInfo): boolean {
  try {
    const fs = require('fs'),
      pathMod = require('path'),
      indexedTime = new Date(repo.indexed_at).getTime() + 3600000, // 1h grace
      // Sample up to 50 source files for mtime changes
      extensions = new Set(['.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java']),
      maxCheck = 50;

    let checked = 0;

    function checkDir(dir) {
      if (checked >= maxCheck) {
        return true;
      } // Assume stale if too many files
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return false;
      }
      for (const entry of entries) {
        if (checked >= maxCheck) {
          return true;
        }
        // oxlint-disable-next-line no-continue
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '.git') {
          continue;
        }
        const fullPath = pathMod.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (checkDir(fullPath)) {
            return true;
          }
        } else if (extensions.has(pathMod.extname(entry.name).toLowerCase())) {
          checked++;
          try {
            const stat = fs.statSync(fullPath);
            if (Math.max(stat.mtimeMs, stat.ctimeMs) > indexedTime) {
              return true;
            }
          } catch {}
        }
      }
      return false;
    }

    return checkDir(repo.path);
  } catch {
    return false;
  }
}

export async function detectProject(cwd: string): Promise<string> {
  const resolved = path.resolve(cwd);

  let knownProjects: string[] = [],
    dir = resolved;
  try {
    const result = await mem('list-projects', {});
    if (result && (result as any).projects) {
      knownProjects = ((result as any).projects as any[]).map((p: any) => p.project);
    }
  } catch {
    /* DB may not exist yet */
  }

  try {
    const codeRepos = await getKnownRepos();
    if (codeRepos.length > 0) {
      let bestRepo: { repo: RepoInfo; depth: number } | null = null,
        candidateDir = resolved;
      const root = path.parse(candidateDir).root;
      while (candidateDir !== root && candidateDir !== path.dirname(candidateDir)) {
        for (const repo of codeRepos) {
          if (candidateDir.toLowerCase() === repo.path.toLowerCase()) {
            const depth = candidateDir.split('/').length;
            if (!bestRepo || depth > bestRepo.depth) {
              bestRepo = { repo, depth };
            }
          }
        }
        candidateDir = path.dirname(candidateDir);
      }
      if (bestRepo) {
        return bestRepo.repo.name;
      }
    }
  } catch {
    /* Code repos may not be available */
  }

  const root = path.parse(dir).root;
  while (dir !== root && dir !== path.dirname(dir)) {
    const name = path.basename(dir),
      match = knownProjects.find((p) => p && p.toLowerCase() === name.toLowerCase());
    if (match) {
      return match;
    }
    dir = path.dirname(dir);
  }

  return path.basename(resolved) || 'unknown';
}
