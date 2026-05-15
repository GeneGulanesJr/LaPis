const compactFormat = require('./compact-format.js');

export const compactResponse = compactFormat.compactResponse;
export const expandResponse = compactFormat.expandResponse;
export const autoFormat = compactFormat.autoFormat;
export const estimateTokens = compactFormat.estimateTokens;
export const _encodeList = compactFormat._encodeList;
export const _decodeList = compactFormat._decodeList;
export const _isHomogeneous = compactFormat._isHomogeneous;
export const _findEncodableList = compactFormat._findEncodableList;
export const _escapePipe = compactFormat._escapePipe;
export const _unescapePipe = compactFormat._unescapePipe;
export const _computePrefixes = compactFormat._computePrefixes;
export default compactFormat;
