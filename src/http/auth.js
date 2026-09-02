const crypto = require('crypto');
const { jsonError } = require('./errors');

function resolveHttpApiKey(opts = {}) {
  if (opts.apiKey) {
    return opts.apiKey;
  }
  if (process.env.LAPIS_HTTP_API_KEY) {
    return process.env.LAPIS_HTTP_API_KEY;
  }
  try {
    const { getConfig } = require('../../config');
    const config = getConfig();
    return config.http_api_key || null;
  } catch {
    return null;
  }
}

function keysMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') {
    return false;
  }
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

function headerValue(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }
  return null;
}

function isAuthorized(req, apiKey) {
  if (!apiKey) {
    return true;
  }
  const headerKey = headerValue(req.headers['x-api-key']);
  if (headerKey && keysMatch(headerKey, apiKey)) {
    return true;
  }
  const auth = headerValue(req.headers.authorization);
  if (auth) {
    const bearerMatch = auth.match(/^Bearer\s+(.+)$/i);
    if (bearerMatch && keysMatch(bearerMatch[1], apiKey)) {
      return true;
    }
  }
  return false;
}

function requireHttpAuth(apiKey) {
  return (req, res) => {
    if (!apiKey) {
      return true;
    }
    if (req.method === 'GET' && new URL(req.url, 'http://localhost').pathname === '/health') {
      return true;
    }
    if (isAuthorized(req, apiKey)) {
      return true;
    }
    jsonError(res, 401, 'unauthorized', 'Missing or invalid API key');
    return false;
  };
}

function assertServeHostPolicy(host, apiKey) {
  const unrestricted = host === '0.0.0.0' || host === '::';
  if (unrestricted && !apiKey) {
    throw new Error(
      'Refusing to bind HTTP server to an unrestricted address without an API key. Pass --api-key, set LAPIS_HTTP_API_KEY, or bind to 127.0.0.1.',
    );
  }
}

module.exports = {
  resolveHttpApiKey,
  isAuthorized,
  requireHttpAuth,
  assertServeHostPolicy,
  keysMatch,
};
