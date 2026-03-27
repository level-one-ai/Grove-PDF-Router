/**
 * Basic authentication middleware for the test dashboard.
 * Username and password are set via environment variables:
 *   DASHBOARD_USERNAME
 *   DASHBOARD_PASSWORD
 *
 * Uses HTTP Basic Auth — credentials are checked on every request
 * to protected endpoints.
 */

function unauthorized(res) {
  res.setHeader('WWW-Authenticate', 'Basic realm="Grove PDF Router"');
  res.status(401).send('Unauthorised');
}

/**
 * Middleware that checks Basic Auth credentials against env vars.
 * Call at the top of any handler that should be protected.
 * Returns true if authorised, false if not (and sends 401 itself).
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
  const password = passwordParts.join(':'); // handle colons in password

  const validUsername = process.env.DASHBOARD_USERNAME;
  const validPassword = process.env.DASHBOARD_PASSWORD;

  if (!validUsername || !validPassword) {
    console.error('[auth] DASHBOARD_USERNAME or DASHBOARD_PASSWORD env vars not set');
    res.status(500).send('Dashboard credentials not configured');
    return false;
  }

  if (username !== validUsername || password !== validPassword) {
    unauthorized(res);
    return false;
  }

  return true;
}

module.exports = { requireAuth };
