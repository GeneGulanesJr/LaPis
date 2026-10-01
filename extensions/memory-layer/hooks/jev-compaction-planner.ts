// extensions/memory-layer/hooks/jev-compaction-planner.ts
// session_before_compact handler that drives pi's compaction via a CompactionJudg
// strategy. Wires together for: threshold gate → per-message judgment →
// cut-point enforcement → custom summary → return CompactionResult.
//
// OFF BY DEFAULT. Three gates (all must allow for the planner to fire):
//   1. `compaction.judg` setting or PI_COMPACTION_JUDG env must be set
//      (anything other than "default"/"noop"/unset)
//   2. The strategy must resolve (registry name OR valid file path)
//   3. Either:
//      a) reason === "manual" (user typed /compact), OR
//      b) tokensBefore >= compaction.judgThresholdTokens (default 100_000)
//         AND reason !== "overflow" (overflow recovery is reserved for pi's
//         built-in path — see docs/JEV_DRIVEN_COMPACTION.md §"Cut-point rules")
//
// When disabled, the handler is a no-op that returns undefined → pi's default
// compaction runs unchanged. This guarantees zero behavior change for users
// who don't opt in.

import { serializeConversation, type CompactionDetails } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import {
  registerCompactionJudg,
  resolveCompactionJudg,
  type CompactionJudg,
  type DecideKeepInput,
  type DecideKeepResult,
  VERDICT_LABELS,
  type KeepVerdict,
} from '../host/compaction-judg';
import { JevCompactionJudg } from '../host/strategies/jev-compaction-judg';
import { DefaultCompactionJudg } from '../host/strategies/default-compaction-judg';
import { NoopCompactionJudg } from '../host/strategies/noop-compaction-judg';

// ----- settings + env resolution ---------------------------------------------

export type PlannerSettings = {
  enabled: boolean;
  thresholdTokens: number;
  dryRun: boolean;
  name: string | null;
  path: string | null;
};

/** Pull planner config from the merged settings object that pi passes to us. */
export function readPlannerSettings(settings: any): PlannerSettings {
  const compaction = settings?.compaction ?? {};
  const envName = process.env.PI_COMPACTION_JUDG?.trim() || null;
  const envPath = process.env.PI_COMPACTION_JUDG_PATH?.trim() || null;
  const envEnabled =
    process.env.PI_COMPACTION_JUDG_ENABLED === '1' ||
    process.env.JEV_COMPACTION_ENABLED === '1';
  const envThreshold = process.env.PI_COMPACTION_JUDG_THRESHOLD
    ? Number(process.env.PI_COMPACTION_JUDG_THRESHOLD)
    : null;
  const envDryRun =
    process.env.PI_COMPACTION_JUDG_DRY_RUN === '1' || process.env.JEV_DRY_RUN === '1';

  // env overrides settings when present
  const name = envName ?? (typeof compaction.judg === 'string' ? compaction.judg : null);
  const path = envPath ?? (typeof compaction.judgPath === 'string' ? compaction.judgPath : null);
  const enabled =
    (envEnabled && (envName !== null || envPath !== null || compaction.judg != null)) ||
    (name !== null && name !== 'default' && name !== 'noop') ||
    (path !== null);
  const threshold = envThreshold ?? clampPlainInt(compaction.judgThresholdTokens, 100_000);
  const dryRun = envDryRun || compaction.judgDryRun === true;

  return { enabled, thresholdTokens: threshold, dryRun, name, path };
}

function clampPlainInt(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

// ----- the planner itself -----------------------------------------------------

export type PlannerHooks = {
  register(pi: ExtensionAPI): void;
};

let defaultStrategiesRegistered = false;

/**
 * Eagerly register the three default strategies so they're discoverable
 * without needing to load index.ts. Idempotent — safe to call multiple times.
 */
export function ensureDefaultStrategies(): void {
  if (defaultStrategiesRegistered) return;
  try {
    registerCompactionJudg('default', new DefaultCompactionJudg());
    registerCompactionJudg('noop', new NoopCompactionJudg());
    registerCompactionJudg('jev', new JevCompactionJudg());
    defaultStrategiesRegistered = true;
  } catch {
    // Some/all already registered (e.g. when index.ts ran first). That's fine.
    defaultStrategiesRegistered = true;
  }
}

export function createJevCompactionPlanner(): PlannerHooks {
  ensureDefaultStrategies();
  return {
    register(pi) {
      pi.on('session_before_compact', async (event, _ctx) => {
        const settings = readPlannerSettings((event as any).preparation?.settings);
        if (!settings.enabled) return undefined; // OFF path — let pi default run
        if (!shouldFire(settings, event)) return undefined;

        const judg = await resolveStrategy(settings);
        if (judg.name === 'noop') return undefined; // safety: never override when noop

        const verdicts = await judgeAll(judg, event);
        const honored = enforceCutPointRules(verdicts, event.preparation.messagesToSummarize);

        // Build the custom summary. We assemble it from the kept messages
        // (verbatim) + a rollup of dropped/summarized ones. If a custom summary
        // model call is needed, we rely on pi's default for the rollup text
        // and just override which messages are kept verbatim.
        const summary = assembleSummary({
          previousSummary: event.preparation.previousSummary,
          allMessages: event.preparation.messagesToSummarize,
          verdicts: honored,
          fileOps: event.preparation.fileOps,
        });

        return {
          compaction: {
            summary,
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
            details: {
              strategy: judg.name,
              verdicts: honored.map((v, i) => ({
                index: i,
                verdict: v.verdict,
                confidence: v.confidence,
                reason: v.reason,
              })),
            } as CompactionDetails & {
              strategy: string;
              verdicts: Array<{ index: number; verdict: KeepVerdict; confidence: number; reason?: string }>;
            },
          },
        };
      });
    },
  };
}

// ----- helpers --------------------------------------------------------------

function shouldFire(settings: PlannerSettings, event: any): boolean {
  const reason = String(event.reason ?? '');
  const tokens = Number(event.preparation?.tokensBefore ?? 0);
  // Manual /compact always fires (user opted in).
  if (reason === 'manual') return true;
  // Overflow recovery: defer to pi's built-in path; Jev-driven summary may
  // not have time to complete inside the recovery window.
  if (reason === 'overflow') return false;
  // Threshold-driven: only fire above the configured token floor.
  return Number.isFinite(tokens) && tokens >= settings.thresholdTokens;
}

async function resolveStrategy(settings: PlannerSettings): Promise<CompactionJudg> {
  if (settings.path) {
    const j = await resolveCompactionJudg(settings.path);
    if (j) return j;
  }
  if (settings.name) {
    const j = await resolveCompactionJudg(settings.name);
    if (j) return j;
  }
  return new NoopCompactionJudg();
}

async function judgeAll(
  judg: CompactionJudg,
  event: any,
): Promise<DecideKeepResult[]> {
  const messages: AgentMessage[] = event.preparation.messagesToSummarize ?? [];
  const total = messages.length;
  if (total === 0) return [];

  // Run all judgments in parallel; each is bounded by JEV_TIMEOUT_MS.
  // abortSignal from event propagates so /compact cancel bails out cleanly.
  return Promise.all(
    messages.map((message, messageIndex) =>
      judg
        .decideKeep(
          {
            message,
            messageIndex,
            totalMessages: total,
            previousSummary: event.preparation.previousSummary,
            fileOps: event.preparation.fileOps,
            tokensBefore: event.preparation.tokensBefore,
            model: event.preparation.settings?.model ?? 'unknown',
          },
          (event as any).signal,
        )
        .catch((err) => {
          // Strategy must never break compaction. On failure, treat as summarize.
          process.stderr.write(
            `[jev-compaction-planner] decideKeep failed at index ${messageIndex}: ${(err as Error).message}; falling back to summarize\n`,
          );
          return {
            verdict: 1 as KeepVerdict,
            confidence: 0,
            reason: `error: ${(err as Error).message}`,
          };
        }),
    ),
  );
}

/**
 * Enforce pi's cut-point rules (per docs/compaction.md §"Cut Point Rules"):
 *   - Never cut at tool results — they must stay with their tool call.
 *   - When an assistant message is kept, its associated tool results must be kept.
 *   - When a tool result is kept, its preceding assistant tool-call must be kept.
 *
 * Walks messages backward; when a message is dropped/summarized but the next
 * message must stay, we promote the dropped one to summarize (keep its gist
 * in the rollup, don't drop entirely).
 */
export function enforceCutPointRules(
  verdicts: DecideKeepResult[],
  messages: AgentMessage[],
): DecideKeepResult[] {
  if (verdicts.length === 0) return verdicts;
  const out = verdicts.slice();

  // Pass forward: tool-result keep forces preceding tool-call keep.
  //              tool-call assistant keep forces next tool-result keep.
  for (let i = 1; i < out.length; i += 1) {
    const prev = messages[i - 1];
    const cur = messages[i];
    const curIsToolResult = isToolResultMessage(cur);
    const prevIsToolCallAssistant = isToolCallAssistant(prev);

    // (a) tool-result keep → previous tool-call must be kept
    if (curIsToolResult && out[i].verdict >= 2 && out[i - 1].verdict < 2) {
      out[i - 1] = { ...out[i - 1], verdict: 2, reason: 'forced by tool-result keep' };
    }
    // (b) tool-call assistant kept → next tool-result must also be kept
    if (curIsToolResult && prevIsToolCallAssistant && out[i - 1].verdict >= 2 && out[i].verdict === 0) {
      out[i] = { ...out[i], verdict: 2, reason: 'forced by tool-call keep' };
    }
  }

  // Pass backward: keep-with-tools (3) requires both sides verbatim.
  for (let i = 0; i < out.length; i += 1) {
    if (out[i].verdict === 3) {
      if (i > 0 && out[i - 1].verdict < 2) {
        out[i - 1] = { ...out[i - 1], verdict: 2, reason: 'forced by keep-with-tools' };
      }
      if (i + 1 < out.length && out[i + 1].verdict < 2) {
        out[i + 1] = { ...out[i + 1], verdict: 2, reason: 'forced by keep-with-tools' };
      }
    }
  }

  return out;
}

function isToolResultMessage(m) {
  if (!m) return false;
  const r = m.role;
  return r === 'toolResult' || r === 'tool_result' || r === 'tool-result';
}

function isToolCallAssistant(m) {
  if (!m) return false;
  if (m.role !== 'assistant') return false;
  // pi's assistant messages carry tool calls in `content` as an array of
  // { type: 'toolCall', ... } blocks. Also handle the alternate shape where
  // the message itself has a `toolCalls` field at the top level.
  if (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) return true;
  if (Array.isArray(m.content)) {
    return m.content.some((c) => c && (c.type === 'toolCall' || c.type === 'tool_use'));
  }
  return false;
}

function assembleSummary(input: {
  previousSummary?: string;
  allMessages: AgentMessage[];
  verdicts: DecideKeepResult[];
  fileOps: { readFiles: string[]; modifiedFiles: string[] };
}): string {
  const { previousSummary, allMessages, verdicts, fileOps } = input;
  const drop: number[] = [];
  const keep: Array<{ idx: number; text: string; label: string }> = [];
  const summary: number[] = [];

  verdicts.forEach((v, i) => {
    if (v.verdict === 0) drop.push(i);
    else if (v.verdict >= 2) {
      try {
        const text = serializeConversation([allMessages[i] as any]).trim();
        keep.push({ idx: i, text, label: VERDICT_LABELS[v.verdict] });
      } catch {
        summary.push(i);
      }
    } else summary.push(i);
  });

  const lines: string[] = [];
  if (previousSummary) lines.push(previousSummary.trim(), '');

  lines.push('## Step decisions (Jev-driven)');
  lines.push(
    `drop=${drop.length} summarize=${summary.length} keep-verbatim=${keep.filter((k) => k.label === 'keep-verbatim').length} keep-with-tools=${keep.filter((k) => k.label === 'keep-with-tools').length}`,
  );
  if (fileOps.readFiles.length || fileOps.modifiedFiles.length) {
    lines.push('');
    lines.push('### File operations');
    if (fileOps.readFiles.length) lines.push(`- read: ${fileOps.readFiles.slice(-20).join(', ')}`);
    if (fileOps.modifiedFiles.length) lines.push(`- modified: ${fileOps.modifiedFiles.slice(-20).join(', ')}`);
  }
  if (keep.length > 0) {
    lines.push('');
    lines.push('### Verbatim-kept messages (full text retained below)');
    keep.forEach((k) => {
      lines.push('', `<keep idx="${k.idx}" mode="${k.label}">`, k.text, '</keep>');
    });
  }
  return lines.join('\n');
}