// Extensions/memory-layer/hooks/output-compression.ts
// oxlint-disable sort-imports
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { isBashToolResult } from '@earendil-works/pi-coding-agent';
import { state } from '../state';
import { classifyCommand } from '../../../src/token-saver/classify-command';
import { compressOutput } from '../../../src/token-saver/compress-output';
import { estimateTokens } from '../../../src/token-saver/estimate-tokens';
import { recordRun } from '../../../src/token-saver/savings-store';

// IsBashToolResult is undefined outside Pi runtime — null-guard + fallback
function safeIsBashToolResult(event: any): boolean {
  if (typeof isBashToolResult === 'function') {
    return isBashToolResult(event);
  }
  return event?.toolName === 'bash';
}

interface CompressionDeps {
  state: typeof state;
  getConfig: () => { output_compression?: { enabled?: boolean; min_chars?: number; min_savings_percent?: number } };
}

const DEFAULT_MIN_CHARS = 2000,
  DEFAULT_MIN_SAVINGS_PERCENT = 30;

export function registerOutputCompression(pi: ExtensionAPI, deps: CompressionDeps) {
  pi.on('tool_result', async (event, _ctx) => {
    // Only process bash tool results
    if (!safeIsBashToolResult(event)) {
      return;
    }

    // Check config toggle
    const config = deps.getConfig(),
      ocConfig = config.output_compression || {};
    if (ocConfig.enabled === false) {
      return;
    }

    {
      const minChars = ocConfig.min_chars ?? DEFAULT_MIN_CHARS,
        minSavingsPercent = ocConfig.min_savings_percent ?? DEFAULT_MIN_SAVINGS_PERCENT,
        // Extract command and output text
        command = event.input.command as string,
        textContent = event.content.find((c): c is { type: 'text'; text: string } => c.type === 'text'),
        output = textContent ? textContent.text : undefined;
      if (!textContent) {
        return;
      }

      // Skip short output — no point compressing
      if (output.length < minChars) {
        return;
      }

      // Parse command into args for the classifier
      {
        const commandArgs = command.trim().split(/\s+/),
          // Classify and compress
          commandType = classifyCommand(commandArgs),
          exitCode = event.isError ? 1 : 0,
          // Pi's bash tool uses child_process.exec which merges stdout/stderr into
          // a single stream. We pass the combined output as stdout with empty stderr.
          // If Pi ever separates streams, this would need updating.
          compressed = compressOutput({
            commandType,
            commandArgs,
            stdout: output,
            stderr: '',
            exitCode,
          }),
          // Calculate savings
          originalTokens = estimateTokens(output),
          compressedTokens = estimateTokens(compressed.importantOutput),
          savedTokens = Math.max(0, originalTokens - compressedTokens),
          savingsPercent = originalTokens > 0 ? Math.round((savedTokens / originalTokens) * 1000) / 10 : 0;

        // Only replace if savings are meaningful
        if (savingsPercent < minSavingsPercent) {
          return;
        }

        // Update in-memory stats
        deps.state.compressionStats.totalRuns += 1;
        deps.state.compressionStats.totalOriginalTokens += originalTokens;
        deps.state.compressionStats.totalCompressedTokens += compressedTokens;
        deps.state.compressionStats.totalSavedTokens += savedTokens;

        // Record to SQLite (best-effort)
        try {
          recordRun({
            command,
            commandType,
            exitCode,
            originalChars: output.length,
            compressedChars: compressed.importantOutput.length,
            estimatedOriginalTokens: originalTokens,
            estimatedCompressedTokens: compressedTokens,
            estimatedSavedTokens: savedTokens,
            savingsPercent,
            summary: compressed.summary,
          });
        } catch {
          // Swallow — telemetry writes must not break tool results
        }

        // Prepend a savings note so the LLM knows output was compressed
        {
          const prefix = `[Output compressed: ${savingsPercent}% token savings (${savedTokens} tokens saved). Summary: ${compressed.summary}]\n\n`,
            newContent = prefix + compressed.importantOutput;

          // Return modified content
          return {
            content: [{ type: 'text' as const, text: newContent }],
          };
        }
      }
    }
  });
}
