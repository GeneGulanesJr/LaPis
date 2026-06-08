import path from 'node:path';

const PKG_ROOT = path.resolve(__dirname, '..', '..');
const MEMORY_SCRIPT = path.join(PKG_ROOT, 'memory-store.js');

export { PKG_ROOT, MEMORY_SCRIPT };

export interface MemResult {
  [key: string]: any;
}

export interface RepoInfo {
  name: string;
  path: string;
  indexed_at: string;
  file_count: number;
  symbol_count: number;
}

export interface DocRepoInfo {
  name: string;
  path: string;
  indexed_at: string;
  file_count: number;
  section_count: number;
}

const TIMEOUT_DEFAULTS: Record<string, number> = {
  _default: 15000,
  'dead-code': 60000,
  cycles: 60000,
  'signal-chains': 45000,
  hotspots: 45000,
  importance: 45000,
  coupling: 30000,
  'blast-radius': 30000,
  preflight: 30000,
  'agent-pack': 30000,
  churn: 30000,
  extractable: 30000,
  'import-graph': 30000,
  'call-hierarchy': 30000,
  'index-repo': 120000,
  'reindex-repo': 120000,
  'index-docs': 120000,
  'reindex-docs': 120000,
};

export function getTimeout(cmd: string): number {
  return TIMEOUT_DEFAULTS[cmd] ?? TIMEOUT_DEFAULTS._default;
}

export function trustIcon(score: number): string {
  if (score < 0.5) {
    return ' ⚠️';
  }
  if (score < 0.7) {
    return ' 🔎';
  }
  return '';
}

const CODE_EXTENSIONS = new Set([
  '.js',
  '.ts',
  '.tsx',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.pyi',
  '.pyx',
  '.go',
  '.rs',
  '.sh',
  '.bash',
  '.json',
  '.jsonc',
  '.yaml',
  '.yml',
  '.rb',
  '.java',
  '.kt',
  '.swift',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.cs',
  '.scala',
  '.clj',
  '.ex',
  '.exs',
  '.erl',
  '.hs',
  '.ml',
  '.zig',
]);

export function isCodeFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return CODE_EXTENSIONS.has(ext);
}

export const REPO_CACHE_TTL = 5 * 60 * 1000;
export const AUTO_DECISION_COOLDOWN = 60000;
export const MEMORY_REMINDER_INTERVAL = 5;
export const CHECKPOINT_INTERVAL = 10;

export const state = {
  nativeChecked: false as boolean,
  cachedRepos: null as RepoInfo[] | null,
  repoCacheTime: 0 as number,
  cachedDocRepos: null as DocRepoInfo[] | null,
  docRepoCacheTime: 0 as number,
  sessionId: null as number | null,
  currentProject: null as string | null,
  projectSessionCount: 0 as number,
  memoriesSavedThisSession: 0 as number,
  exploredFiles: new Set<string>(),
  turnCount: 0 as number,
  lastMemoryToolCall: 0 as number,
  callsSinceLastMemory: 0 as number,
  lastAutoDecisionSave: 0 as number,
  hasInjectedContext: false as boolean,
  editedFiles: new Set<string>(),
  pendingRecallFeedback: new Map<number, { sessionId: number; query: string }>(),
  compressionStats: {
    totalRuns: 0 as number,
    totalOriginalTokens: 0 as number,
    totalCompressedTokens: 0 as number,
    totalSavedTokens: 0 as number,
  },
};
