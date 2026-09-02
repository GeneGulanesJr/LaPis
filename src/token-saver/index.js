const { runCommand } = require('./run-command'),
  { classifyCommand } = require('./classify-command'),
  { estimateTokens } = require('./estimate-tokens'),
  { compressOutput } = require('./compress-output'),
  { recordRun } = require('./savings-store');

async function executeAndCompress(commandArgs, options = {}) {
  const command = commandArgs.join(' '),
    commandType = classifyCommand(commandArgs),
    result = await runCommand(commandArgs, {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      maxBufferChars: options.maxBufferChars,
      env: options.env,
    }),
    combined = `${result.stdout}\n${result.stderr}`,
    originalChars = combined.length,
    estimatedOriginalTokens = estimateTokens(combined);

  if (options.raw) {
    const rawOutput = combined.trim(),
      rawResult = {
        command,
        exitCode: result.exitCode,
        commandType,
        originalChars,
        compressedChars: originalChars,
        estimatedOriginalTokens,
        estimatedCompressedTokens: estimatedOriginalTokens,
        estimatedSavedTokens: 0,
        savingsPercent: 0,
        summary: 'Raw output (no compression).',
        importantOutput: rawOutput,
        truncated: result.truncated,
        timedOut: result.timedOut,
      };
    return rawResult;
  }

  {
    const compressed = compressOutput({
        commandType,
        commandArgs,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      }),
      compressedChars = compressed.importantOutput.length,
      estimatedCompressedTokens = estimateTokens(compressed.importantOutput),
      estimatedSavedTokens = Math.max(0, estimatedOriginalTokens - estimatedCompressedTokens),
      savingsPercent =
        estimatedOriginalTokens > 0 ? Math.round((estimatedSavedTokens / estimatedOriginalTokens) * 1000) / 10 : 0,
      finalResult = {
        command,
        exitCode: result.exitCode,
        commandType,
        originalChars,
        compressedChars,
        estimatedOriginalTokens,
        estimatedCompressedTokens,
        estimatedSavedTokens,
        savingsPercent,
        summary: compressed.summary,
        importantOutput: compressed.importantOutput,
        truncated: result.truncated,
        timedOut: result.timedOut,
      };

    try {
      recordRun(finalResult);
    } catch {}

    return finalResult;
  }
}

function formatTextOutput(result) {
  let output = '';
  output += `Command: ${result.command}\n`;
  output += `Exit code: ${result.exitCode}\n`;
  output += `Type: ${result.commandType}\n`;
  output += `Tokens: ${result.estimatedCompressedTokens}/${result.estimatedOriginalTokens} (saved ${result.estimatedSavedTokens}, ${result.savingsPercent}%)\n`;
  output += `\n${result.summary}\n`;
  if (result.importantOutput) {
    output += `\n${result.importantOutput}\n`;
  }
  if (result.truncated) {
    output += '\n[Output was truncated due to buffer limit]';
  }
  if (result.timedOut) {
    output += '\n[Command timed out]';
  }
  return output;
}

module.exports = { executeAndCompress, formatTextOutput };
