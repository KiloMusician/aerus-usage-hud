// Request policy for the local dashboard server. It listens on 127.0.0.1 only, but any web page the
// user has open can still make the browser send requests to it, and a hostile DNS name can point at it.
// These checks keep the usage data and the account lookup reachable only from the dashboard itself:
//
// * Host must be exactly 127.0.0.1 or localhost on the port we listen on (defeats DNS rebinding).
// * A browser-supplied Origin must be this same dashboard.
// * /api/ requests that a browser marks as coming from another site (Sec-Fetch-Site) are refused, so a
//   page cannot trigger the scan or the Codex account lookup with a cross-site "no-cors" request.
//
// None of this is authentication: another program running as the same user can still call the API.

const LOOPBACK_NAMES = ['127.0.0.1', 'localhost'];

function hostMatches(value, port) {
  const host = String(value ?? '').toLowerCase();
  return LOOPBACK_NAMES.some((name) => host === `${name}:${port}` || (port === 80 && host === name));
}

// Returns { ok: true } or { ok: false, status, reason } for one request.
export function checkRequest({ method, pathname, headers, port }) {
  if (method !== 'GET' && method !== 'HEAD') return { ok: false, status: 405, reason: 'Method not allowed.' };
  if (!hostMatches(headers.host, port)) return { ok: false, status: 403, reason: 'Unexpected Host header.' };

  const origin = headers.origin;
  if (origin !== undefined) {
    const match = /^http:\/\/(.+)$/.exec(String(origin).toLowerCase());
    if (!match || !hostMatches(match[1], port)) return { ok: false, status: 403, reason: 'Unexpected Origin header.' };
  }

  const site = headers['sec-fetch-site'];
  if (pathname.startsWith('/api/') && site !== undefined && site !== 'same-origin' && site !== 'none') {
    return { ok: false, status: 403, reason: 'Cross-site request refused.' };
  }
  return { ok: true };
}
