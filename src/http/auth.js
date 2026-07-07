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

function isAuthorized(req, apiKey) {
  if (!apiKey) {
    return true;
  }
  const headerKey = req.headers['x-api-key'];
  if (typeof headerKey === 'string' && headerKey === apiKey) {
    return true;
  }
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length) === apiKey;
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
};
