// Deployment statement for the sidebar, More and About. VECTOR's server runs only on the owner's machine; a copy of the
// web/ files served anywhere else (the public Netlify preview) has no API, no data, no models and no real accounts, so
// it says "Static preview" instead of claiming to be the local, not-publicly-deployed app. A reachable API (also on a
// LAN or tailnet host in VECTOR_ALLOW_REMOTE mode) means the real local server.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export const isLoopbackHost = (host = location.hostname) => LOOPBACK.has(host);

/**
 * @param {{apiReachable?: boolean|null, deployment?: string|null}} o  apiReachable: a status answer arrived from the VECTOR
 *        API; deployment: that answer's app.deployment ('local' | 'hosted-demo').
 */
export function deployNote({ apiReachable = null, deployment = null } = {}) {
  if (apiReachable === true && deployment === 'hosted-demo') {
    return {
      local: false,
      short: 'Hosted demo · paper only · resets on restart',
      long: 'Hosted demo of VECTOR on a free server, reached through the owner\'s token link. Paper only: the replay, paper orders and agents work on the real stored IEX day, but everything resets when the server restarts or sleeps; real accounts are disabled; no model is configured unless the owner adds a free API key. The public RCL website is not modified.',
    };
  }
  if (isLoopbackHost() || apiReachable === true) {
    return {
      local: true,
      short: 'Local MVP · not publicly deployed',
      long: 'Local MVP on 127.0.0.1 — not publicly deployed; the public RCL website is not modified.',
    };
  }
  return {
    local: false,
    short: 'Static preview · no live data',
    long: 'Static preview of the web UI only: no VECTOR server, so no data, replay, models or real accounts. VECTOR itself runs only on the owner\'s machine; the public RCL website is not modified.',
  };
}
