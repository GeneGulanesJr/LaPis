'use strict';

/**
 * Matches git operations that should trigger trust-score sync after Bash tools.
 * Supports optional `git -C <path>` with quoted or unquoted paths.
 */
const GIT_TRUST_OP_RE =
  /\bgit(?:\s+-C\s+(?:"[^"]+"|'[^']+'|[^\s"']+))?\s+(pull|checkout|merge|rebase|reset|stash\s+pop)\b/;

function matchesGitTrustOperation(command) {
  return typeof command === 'string' && GIT_TRUST_OP_RE.test(command);
}

module.exports = { GIT_TRUST_OP_RE, matchesGitTrustOperation };
