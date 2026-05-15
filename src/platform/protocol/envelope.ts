const envelope = require('./envelope.js');

export const checkFreshness = envelope.checkFreshness;
export const getFreshness = envelope.getFreshness;
export const clearFreshnessCache = envelope.clearFreshnessCache;
export const computeConfidence = envelope.computeConfidence;
export const extractResultCount = envelope.extractResultCount;
export const buildEnvelope = envelope.buildEnvelope;
export const TOOL_NAMES = envelope.TOOL_NAMES;
export const buildAnalysisEnvelope = envelope.buildAnalysisEnvelope;
export default envelope;
