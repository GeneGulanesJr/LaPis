// extensions/memory-layer/host/strategies/decision-compaction-judg.ts
// Decision-driven compaction judgment. One Decision `score` call per candidate message
// in messagesToSummarize. The 4-level scale (drop / summarize / keep-verbatim
// / keep-with-tools) maps directly to pi's KeepVerdict.
//
// Replaceable: this is one CompactionJudg impl; users can register their own
// via `registerCompactionJudg()` or `compaction.judgPath` in settings.

import { convertToLlm, serializeConversation } from '@earendil-works/pi-coding-agent';
import { decisionAsk, type DecisionScoreAnswer } from '../decision-client';
import {
  type CompactionJudg,
  type DecideKeepInput,
  type DecideKeepResult,
  VERDICT_LABELS,
  type KeepVerdict,
} from '../compaction-judg';

const QUESTION_BODY =
  `Previous compaction summary:\n{previousSummary}\n\n` +
  `Cumulative file operations across this compaction pass:\n` +
  `  read:     {readList}\n` +
  `  modified: {modifiedList}\n\n` +
  `Message {index} of {total} in this compaction pass:\n` +
  `---\n{messageText}\n---\n\n` +
  `How should this message be handled?\n` +
  `0=drop — no value beyond what the rollup carries\n` +
  `1=summarize — gist belongs in the compaction summary\n` +
  `2=keep verbatim — full message needed in the kept slice\n` +
  `3=keep with tool results — message AND its tool output must stay attached`;

const SCORE_LEVELS = ['drop', 'summarize', 'keep-verbatim', 'keep-with-tools'];

export class DecisionCompactionJudg implements CompactionJudg {
  readonly name = 'decision';

  async decideKeep(inp: DecideKeepInput, signal?: AbortSignal): Promise<DecideKeepResult> {
    const question = buildKeepQuestion(inp);
    const answer = await decisionAskWithAbort(question, signal);
    return mapAnswer(answer);
  }
}

function buildKeepQuestion(inp: DecideKeepInput) {
  const readList = inp.fileOps.readFiles.length > 0 ? inp.fileOps.readFiles.slice(-20).join(', ') : '(none)';
  const modifiedList =
    inp.fileOps.modifiedFiles.length > 0 ? inp.fileOps.modifiedFiles.slice(-20).join(', ') : '(none)';

  // Serialize the message into the textual form the model can judge.
  // Tool-result cap (2000) is applied inside it.
  let serialized = '';
  try {
    serialized = serializeConversation(convertToLlm([inp.message])).trim();
  } catch (err) {
    // If serialization fails, fall back to a coarse "summarize" verdict.
    return {
      kind: 'score' as const,
      question: QUESTION_BODY.replace('{previousSummary}', '(serialization failed)')
        .replace('{readList}', readList)
        .replace('{modifiedList}', modifiedList)
        .replace('{index}', String(inp.messageIndex))
        .replace('{total}', String(inp.totalMessages))
        .replace('{messageText}', `(unserializable: ${(err as Error).message})`),
      levels: SCORE_LEVELS,
    };
  }

  return {
    kind: 'score' as const,
    question: QUESTION_BODY.replace('{previousSummary}', inp.previousSummary ?? '(none)')
      .replace('{readList}', readList)
      .replace('{modifiedList}', modifiedList)
      .replace('{index}', String(inp.messageIndex))
      .replace('{total}', String(inp.totalMessages))
      .replace('{messageText}', serialized),
    levels: SCORE_LEVELS,
  };
}

function mapAnswer(answer: DecisionScoreAnswer): DecideKeepResult {
  // Decision returns float scores; round to nearest level index, then clamp.
  const raw = Number(answer.score);
  const idx = Number.isFinite(raw) ? Math.round(raw) : 1; // default to summarize
  const verdict = clampVerdict(idx);
  return {
    verdict,
    confidence: clamp01(Number(answer.confidence ?? 0)),
    reason: `decision: ${VERDICT_LABELS[verdict]} (raw=${raw})`,
  };
}

function clampVerdict(n: number): KeepVerdict {
  if (n <= 0) return 0;
  if (n >= 3) return 3;
  return n as KeepVerdict;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Wrap decisionAsk with an AbortSignal. The base client has its own timeout, but
 * compaction can run for many messages in a batch — if the user cancels
 * mid-batch we want to bail out cleanly rather than waiting for the timeout.
 */
async function decisionAskWithAbort(
  question: ReturnType<typeof buildKeepQuestion>,
  signal?: AbortSignal,
): Promise<DecisionScoreAnswer> {
  if (signal?.aborted) {
    return { score: 1, confidence: 0 };
  }
  return (await decisionAsk(question)) as DecisionScoreAnswer;
}
