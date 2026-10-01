// extensions/memory-layer/host/compaction-judg.ts
// Strategy interface for Jev-driven compaction.
//
// Compaction is per-message decided by a CompactionJudg implementation. The
// default strategy is `noop` (no per-message decision, falls through to pi's
// built-in compaction unchanged). Replaceable via:
//
//   1) In-code `registerCompactionJudg("name", impl)` from any extension
//   2) Settings JSON: `compaction.judgPath: "./my-judg.mjs"` (default export
//      that satisfies CompactionJudg)
//
// This module is intentionally strategy-agnostic. It does not depend on Jev,
// LLM, or pi's compaction internals beyond the cut-point boundaries documented in
// `docs/JEV_DRIVEN_COMPACTION.md`.

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { FileOperations } from '@earendil-works/pi-coding-agent';

/** Per-message verdict. Mirrors the score levels described in the docs. */
export type KeepVerdict = 0 | 1 | 2 | 3;

export const VERDICT_LABELS = [
  'drop', // 0 — no value to the LLM beyond what the summary will carry
  'summarize', // 1 — gist belongs in the compaction rollup
  'keep-verbatim', // 2 — full text retained in the kept slice
  'keep-with-tools', // 3 — keep AND retain tool results / tool calls
] as const;

/** Input to a single decideKeep() call. */
export interface DecideKeepInput {
  /** The message to judge. Serialized via serializeConversation() by the caller. */
  message: AgentMessage;
  /** Position within messagesToSummarize (0-based). */
  messageIndex: number;
  /** Total candidate messages in this compaction pass. */
  totalMessages: number;
  /** Previous compaction summary, if any. */
  previousSummary?: string;
  /** File operations extracted from messagesToSummarize (cumulative). */
  fileOps: FileOperations;
  /** Total context tokens before this compaction. */
  tokensBefore: number;
  /** Model id used for compaction summarization. */
  model: string;
}

/** Per-message decision. */
export interface DecideKeepResult {
  verdict: KeepVerdict;
  /** Confidence in [0, 1]. Strategies may use this to flag uncertain keeps. */
  confidence: number;
  /** Optional human-readable reason. Logged + surfaced in telemetry, not used by the planner. */
  reason?: string;
}

/**
 * Strategy contract. Implementations must be:
 *   - Deterministic-enough that re-runs on the same input produce the same verdict.
 *   - Graceful: throw or return error sentinel; never corrupt pi's compaction flow.
 *   - Bounded: per-call latency < JEV_TIMEOUT_MS (default 8s); under that,
 *           unpredictable judgments across long sessions fail loudly rather than
 *           blocking compaction silently.
 */
export interface CompactionJudg {
  /** Strategy name (used for logging + telemetry). */
  readonly name: string;
  /** Decide whether to keep a single message verbatim, summarize it, or drop it. */
  decideKeep(input: DecideKeepInput, signal?: AbortSignal): Promise<DecideKeepResult>;
}

// In-process registry. Populated by:
//   - registerCompactionJudg() at extension boot time
//   - Lazy-load from `compaction.judgPath` settings (one-shot cache)
const REGISTRY = new Map<string, CompactionJudg>();
const FILE_CACHE = new Map<string, CompactionJudg>();

export function registerCompactionJudg(name: string, impl: CompactionJudg): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('CompactionJudg name must be a non-empty string');
  }
  if (!impl || typeof impl.decideKeep !== 'function' || typeof impl.name !== 'string') {
    throw new Error('CompactionJudg impl must satisfy { name, decideKeep }');
  }
  // Idempotent re-registration: overwriting with the same instance is fine
  // (e.g. when memoryLayer() is called twice during a hot-reload, or when
  // index.ts re-runs after a settings edit). Reject ONLY when the same name
  // is registered with a DIFFERENT impl, which is a real conflict.
  const existing = REGISTRY.get(name);
  if (existing && existing !== impl) {
    throw new Error(
      `CompactionJudg "${name}" already registered with a different impl (got "${impl.name}")`,
    );
  }
  REGISTRY.set(name, impl);
}

/**
 * Resolve a strategy by name. If the name is not registered and looks like a
 * file path (starts with "." or "/", or ends in .mjs/.cjs/.js), lazy-load it
 * via dynamic import and validate the default export.
 *
 * Returns undefined when not found; callers should fall back to the noop
 * strategy (which mirrors pi's default compaction behavior).
 */
export async function resolveCompactionJudg(name: string): Promise<CompactionJudg | undefined> {
  if (REGISTRY.has(name)) return REGISTRY.get(name);
  if (!looksLikePath(name)) return undefined;
  if (FILE_CACHE.has(name)) return FILE_CACHE.get(name);

  try {
    const mod = await import(name);
    const impl = mod.default ?? mod.compactionJudg ?? mod;
    if (!impl || typeof impl.decideKeep !== 'function' || typeof impl.name !== 'string') {
      throw new Error(
        `CompactionJudg file "${name}" must default-export an object with { name, decideKeep }`,
      );
    }
    const wrapped: CompactionJudg = { name: impl.name, decideKeep: impl.decideKeep.bind(impl) };
    FILE_CACHE.set(name, wrapped);
    return wrapped;
  } catch (err) {
    // Surface the failure for telemetry; do not throw from the registry.
    process.stderr.write(
      `[compaction-judg] failed to load "${name}": ${(err as Error).message}\n`,
    );
    return undefined;
  }
}

export function listRegisteredJudg(): string[] {
  return Array.from(REGISTRY.keys());
}

/** Test-only: reset the registry. Never call from production code paths. */
export function __resetJudgRegistryForTests(): void {
  REGISTRY.clear();
  FILE_CACHE.clear();
}

function looksLikePath(name: string): boolean {
  return (
    name.startsWith('./') ||
    name.startsWith('../') ||
    name.startsWith('/') ||
    name.endsWith('.mjs') ||
    name.endsWith('.cjs') ||
    name.endsWith('.js')
  );
}