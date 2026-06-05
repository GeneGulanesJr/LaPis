function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

module.exports = { estimateTokens };
