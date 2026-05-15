import path from "node:path";
import { RepoInfo, state } from "../state";
import { mem, memCmd } from "./memory-client";

export { type RepoInfo };

export async function getKnownRepos(): Promise<RepoInfo[]> {
  const now = Date.now();
  if (state.cachedRepos && now - state.repoCacheTime < 5 * 60 * 1000) {return state.cachedRepos;}
  const result = await memCmd("list-code-repos");
  if (!result || !(result as any).repos) {return state.cachedRepos || [];}
  state.cachedRepos = (result as any).repos as RepoInfo[];
  state.repoCacheTime = now;
  return state.cachedRepos;
}

export function isRepoStale(repo: RepoInfo): boolean {
  try {
    const fs = require("fs");
    const stat = fs.statSync(repo.path);
    const indexedTime = new Date(repo.indexed_at).getTime();
    const mtime = Math.max(stat.mtimeMs, stat.ctimeMs);
    return mtime > indexedTime + 3600000;
  } catch {
    return false;
  }
}

export async function detectProject(cwd: string): Promise<string> {
  const resolved = path.resolve(cwd);

  let knownProjects: string[] = [];
  try {
    const result = await mem("list-projects", {});
    if (result && (result as any).projects) {
      knownProjects = ((result as any).projects as any[]).map((p: any) => p.project);
    }
  } catch (_) { /* DB may not exist yet */ }

  try {
    const codeRepos = await getKnownRepos();
    if (codeRepos.length > 0) {
      let bestRepo: { repo: RepoInfo; depth: number } | null = null;
      let dir = resolved;
      const root = path.parse(dir).root;
      while (dir !== root && dir !== path.dirname(dir)) {
        for (const repo of codeRepos) {
          if (dir.toLowerCase() === repo.path.toLowerCase()) {
            const depth = dir.split("/").length;
            if (!bestRepo || depth > bestRepo.depth) {
              bestRepo = { repo, depth };
            }
          }
        }
        dir = path.dirname(dir);
      }
      if (bestRepo) {return bestRepo.repo.name;}
    }
  } catch (_) { /* Code repos may not be available */ }

  let dir = resolved;
  const root = path.parse(dir).root;
  while (dir !== root && dir !== path.dirname(dir)) {
    const name = path.basename(dir);
    const match = knownProjects.find(p => p && p.toLowerCase() === name.toLowerCase());
    if (match) {return match;}
    dir = path.dirname(dir);
  }

  return path.basename(resolved) || "unknown";
}
