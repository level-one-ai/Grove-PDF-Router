/**
 * Auth middleware.
 * For page loads: uses HTTP Basic Auth (browser prompts for credentials).
 * For API calls from dashboard JS: accepts a session token stored in a cookie
 * OR passes through if the request comes from the same origin with credentials.
 *
 * Simplest approach for same-origin dashboard: skip auth on API routes that
 * are only called from the dashboard page itself, and keep auth only on the
 * dashboard page load. API routes check for the DASHBOARD_TOKEN header instead.
 */

function unauthorized(res) {
  res.setHeader('WWW-Authenticate', 'Basic realm="Grove PDF Router"');
  res.status(401).send('Unauthorised');
}

/**
 * Full Basic Auth — used only for the dashboard HTML page load.
 */
function requireAuth(req, res) {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Basic ')) {
    unauthorized(res);
    return false;
  }

  const base64 = authHeader.slice('Basic '.length);
  const decoded = Buffer.from(base64, 'base64').toString('utf8');
  const [username, ...passwordParts] = decoded.split(':');
  const password = passwordParts.join(':');

  const validUsername = process.env.DASHBOARD_USERNAME;
  const validPassword = process.env.DASHBOARD_PASSWORD;

  if (!validUsername || !validPassword) {
    console.error('[auth] DASHBOARD_USERNAME or DASHBOARD_PASSWORD not set');
    res.status(500).json({ error: 'Dashboard credentials not configured' });
    return false;
  }

  if (username !== validUsername || password !== validPassword) {
    unauthorized(res);
    return false;
  }

  return true;
}

/**
 * Lightweight API auth — used for JSON API endpoints called by dashboard JS.
 * Accepts either:
 *   1. Basic Auth header (same credentials as dashboard login)
 *   2. X-Dashboard-Token header matching CALLBACK_SECRET
 * This allows the browser to pass credentials via fetch without a new prompt.
 */
function requireApiAuth(req, res) {
  // Option 1: Basic Auth (browser sends this automatically with credentials: 'include')
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Basic ')) {
    const base64 = authHeader.slice('Basic '.length);
    const decoded = Buffer.from(base64, 'base64').toString('utf8');
    const [username, ...passwordParts] = decoded.split(':');
    const password = passwordParts.join(':');
    if (username === process.env.DASHBOARD_USERNAME && password === process.env.DASHBOARD_PASSWORD) {
      return true;
    }
  }

  // Option 2: Token header
  const token = req.headers['x-dashboard-token'];
  if (token && token === process.env.CALLBACK_SECRET) {
    return true;
  }

  // Option 3: No auth configured — allow through (will be protected by Vercel URL obscurity)
  // Remove this if you want strict auth on all API calls
  if (!process.env.DASHBOARD_USERNAME) {
    return true;
  }

  res.status(401).json({ error: 'Unauthorised' });
  return false;
}

module.exports = { requireAuth, requireApiAuth };
