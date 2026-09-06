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
      // Unauthenticated server: refuse anything that is not addressed to this
      // Machine's loopback interface. This is what keeps a web page from
      // Driving the API (browsers always attach an Origin on cross-origin
      // Requests) and defeats DNS rebinding (Host would name the attacker's
      // Domain, not loopback).
      const reason = assertLocalOnlyRequest(req);
      if (reason) {
        jsonError(
          res,
          403,
          'forbidden',
          `Local-only server: refused ${reason}. Set LAPIS_HTTP_API_KEY to enable authenticated remote use.`,
        );
        return false;
      }
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

// Hostnames that resolve to this machine's loopback interface.
function isLoopbackHost(hostname) {
  if (!hostname) {
    return false;
  }
  const host = String(hostname).trim().toLowerCase().replace(/\.$/, ''),
    bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return (
    bare === 'localhost' ||
    bare.endsWith('.localhost') ||
    bare === '::1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)
  );
}

// Returns null when the request is addressed locally, or a short reason
// String when the unauthenticated server must refuse it.
function assertLocalOnlyRequest(req) {
  const hostHeader = headerValue(req.headers.host),
    hostname = hostHeader ? hostHeader.replace(/:\d+$/, '').replace(/^\[/, '').replace(/\]$/, '') : '',
    origin = headerValue(req.headers.origin);
  if (!isLoopbackHost(hostname)) {
    return `non-loopback Host "${hostHeader ?? ''}"`;
  }
  if (origin) {
    try {
      if (!isLoopbackHost(new URL(origin).hostname)) {
        return `cross-origin Origin "${origin}"`;
      }
    } catch {
      return `malformed Origin "${origin}"`;
    }
  }
  return null;
}

function assertServeHostPolicy(host, apiKey) {
  if (apiKey) {
    return;
  }
  // Any non-loopback bind is unrestricted — not just the literal 0.0.0.0/::
  // Wildcards. A LAN address like 192.168.1.5 exposes the API just the same.
  if (!isLoopbackHost(host)) {
    throw new Error(
      'Refusing to bind HTTP server to a non-loopback address without an API key. Pass --api-key, set LAPIS_HTTP_API_KEY, or bind to 127.0.0.1.',
    );
  }
}

module.exports = {
  resolveHttpApiKey,
  isAuthorized,
  requireHttpAuth,
  assertServeHostPolicy,
  assertLocalOnlyRequest,
  isLoopbackHost,
  keysMatch,
};
