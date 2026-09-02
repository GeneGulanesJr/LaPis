'use strict';

/**
 * Hooks-engine: preflight-assembly
 *
 * Pure preflight/coding-context block assembly extracted from
 * extensions/memory-layer/hooks/context-injection.ts. Imports extractFilePaths
 * from context-builder (shared helper).
 */

const { CONTEXT } = require('../../constants'),
  { extractFilePaths } = require('./context-builder');

function iconForRisk(risk) {
  if (risk === 'high') {
    return '🔴';
  }
  if (risk === 'medium') {
    return '🟡';
  }
  return '🟢';
}

function appendPreflightBlock(lines, result) {
  const code = result.likely_existing_code || [],
    warnings = result.duplicate_warnings || [],
    risk = result.risk,
    action = result.recommended_action,
    relatedFiles = result.related_files || [],
    maxFiles = CONTEXT.PREFLIGHT_RELATED_FILES || 3;

  if (code.length === 0 && warnings.length === 0 && risk === 'low') {
    return;
  }

  lines.push('');
  lines.push('### Preflight — Before Coding');

  if (warnings.length > 0) {
    const riskIcon = iconForRisk(risk);
    lines.push(`${riskIcon} **Duplicate risk: ${risk}** — existing code may already handle this task.`);
    for (const w of warnings.slice(0, 2)) {
      lines.push(`- ⚠️ \`${w.symbol}\` in \`${w.file}\``);
    }
  } else if (code.length > 0) {
    const riskIcon = iconForRisk(risk);
    lines.push(`${riskIcon} Risk: **${risk}** — related code exists.`);
    for (const c of code.slice(0, 2)) {
      const loc = c.line ? `:${c.line}` : '';
      lines.push(`- \`${c.symbol}\` (${c.kind || 'symbol'}) — \`${c.file}${loc}\``);
    }
  }

  if (relatedFiles.length > 0) {
    lines.push(
      `Related files: ${relatedFiles
        .slice(0, maxFiles)
        .map((f) => `\`${f}\``)
        .join(', ')}`,
    );
  }

  if (action) {
    lines.push(`→ ${action}`);
  }
}

function extractExplicitSymbol(prompt) {
  if (!prompt) {
    return null;
  }

  const codeSymbol = prompt.match(/`([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)`/);
  if (codeSymbol) {
    return codeSymbol[1];
  }

  {
    const callSymbol = prompt.match(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\(/);
    if (callSymbol) {
      return callSymbol[1];
    }

    return null;
  }
}

function chooseCodingContextTarget(prompt, preflightResult) {
  const promptFiles = extractFilePaths(prompt || ''),
    explicitSymbol = !(promptFiles.length > 0) ? extractExplicitSymbol(prompt) : undefined;
  if (promptFiles.length > 0) {
    return { file: promptFiles[0] };
  }

  if (explicitSymbol) {
    return { symbol: explicitSymbol };
  }

  const code = preflightResult?.likely_existing_code || [],
    firstCode = code.find((item) => item.symbol || item.file);
  if (firstCode?.symbol) {
    return firstCode.file ? { symbol: firstCode.symbol, file: firstCode.file } : { symbol: firstCode.symbol };
  }
  if (firstCode?.file) {
    return { file: firstCode.file };
  }

  return null;
}

function unwrapAnalysisData(result) {
  if (result && typeof result === 'object' && result.data && typeof result.data === 'object') {
    return result.data;
  }
  return result;
}

function appendCodingContextBlock(lines, result) {
  if (!result || result.error) {
    return;
  }

  const target = result.target || {},
    summary = result.summary || {},
    relatedFiles = result.related_files || [],
    likelyTests = result.likely_tests || [],
    maxFiles = CONTEXT.PREFLIGHT_RELATED_FILES || 3;

  if (!target.symbol && !target.file && relatedFiles.length === 0 && likelyTests.length === 0) {
    return;
  }

  lines.push('');
  lines.push('### Coding Context — Before Editing');

  if (target.symbol) {
    const file = target.file ? ` — \`${target.file}\`` : '';
    lines.push(`Target: \`${target.symbol}\`${file}`);
  } else if (target.file) {
    lines.push(`Target file: \`${target.file}\``);
  }

  if (summary.risk || summary.review_bar) {
    const risk = summary.risk || 'unknown',
      review = summary.review_bar || 'unknown',
      affected = typeof summary.affected_files === 'number' ? ` | affected files: ${summary.affected_files}` : '';
    lines.push(`Risk: **${risk}** | review: **${review}**${affected}`);
  }

  if (relatedFiles.length > 0) {
    lines.push(
      `Review files: ${relatedFiles
        .slice(0, maxFiles)
        .map((f) => `\`${f}\``)
        .join(', ')}`,
    );
  }

  if (likelyTests.length > 0) {
    lines.push(
      `Likely tests: ${likelyTests
        .slice(0, 2)
        .map((test) => `\`${test.file || '?'}\``)
        .join(', ')}`,
    );
  }
}

module.exports = {
  appendPreflightBlock,
  iconForRisk,
  appendCodingContextBlock,
  chooseCodingContextTarget,
  unwrapAnalysisData,
  extractExplicitSymbol,
};
