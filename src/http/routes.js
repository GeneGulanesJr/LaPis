function matchRoute(method, pathname, routes) {
  for (const route of routes) {
    if (route.method !== method) {
      continue;
    }
    const params = matchPath(route.pattern, pathname);
    if (params !== null) {
      return { handler: route.handler, params };
    }
  }
  return null;
}

function matchPath(pattern, pathname) {
  const patternParts = pattern.split('/'),
    pathParts = pathname.split('/');
  if (patternParts.length !== pathParts.length) {
    return null;
  }
  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      try {
        params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
      } catch {
        // Malformed percent-encoding (e.g. %ZZ) — treat as no match so the
        // Caller surfaces a clean 404 instead of an unhandled URIError.
        return null;
      }
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

module.exports = { matchRoute };
