/**
 * api/google-diag.js
 *
 * Granular diagnostic for Google OAuth chain.
 * Tells you exactly which credential is wrong when /api/diag says "invalid_client".
 *
 * Usage:
 *   GET /api/google-diag?secret=YOUR_CALLBACK_SECRET
 *
 * Tests, in order:
 *   1. Are all 3 OAuth env vars present + non-empty?
 *   2. Do they have whitespace anywhere (start/end/middle)?
 *   3. Does Client ID match expected format (...apps.googleusercontent.com)?
 *   4. Does Client Secret match expected format (GOCSPX-...)?
 *   5. Does Refresh Token match expected format (1//...)?
 *   6. Direct token-exchange call to Google's oauth2 endpoint, decoding the
 *      exact error response. This is what reveals which credential Google rejects.
 *   7. If token exchange succeeds, try a Drive API call.
 *
 * Returns plain JSON — no HTML — so the dashboard can also call this if needed.
 */

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // Auth: require CALLBACK_SECRET
  const expectedSecret = process.env.CALLBACK_SECRET;
  const providedSecret = req.query?.secret || req.headers['x-callback-secret'];
  if (!expectedSecret || providedSecret !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorised — provide ?secret=<CALLBACK_SECRET>' });
  }

  const results = [];
  const t = (name, ok, details) => results.push({ name, ok, details });

  // ── Step 1: Presence ────────────────────────────────────────────────────────
  const cid     = process.env.GOOGLE_OAUTH_CLIENT_ID     || '';
  const csecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
  const ctoken  = process.env.GOOGLE_OAUTH_REFRESH_TOKEN || '';

  t('Client ID present',          !!cid.trim(),     cid     ? `${cid.length} chars`     : 'MISSING');
  t('Client Secret present',      !!csecret.trim(), csecret ? `${csecret.length} chars` : 'MISSING');
  t('Refresh Token present',      !!ctoken.trim(),  ctoken  ? `${ctoken.length} chars`  : 'MISSING');

  if (!cid.trim() || !csecret.trim() || !ctoken.trim()) {
    return res.status(200).json({ ok: false, summary: 'Missing one or more OAuth credentials', results });
  }

  // ── Step 2: Whitespace check (the most common cause) ────────────────────────
  const checkWhitespace = (label, val) => {
    const issues = [];
    if (val !== val.trim())        issues.push('leading/trailing whitespace');
    if (/[\r\n]/.test(val))        issues.push('embedded newlines');
    if (/\t/.test(val))            issues.push('embedded tabs');
    if (/^[ \t]/.test(val))        issues.push('starts with space/tab');
    if (/[ \t]$/.test(val))        issues.push('ends with space/tab');
    return issues.length === 0
      ? t(`${label} — no whitespace issues`, true,  'clean')
      : t(`${label} — WHITESPACE PROBLEM`,    false, issues.join(', '));
  };
  checkWhitespace('Client ID',     cid);
  checkWhitespace('Client Secret', csecret);
  checkWhitespace('Refresh Token', ctoken);

  // ── Step 3: Format check ────────────────────────────────────────────────────
  t('Client ID format',
    cid.endsWith('.apps.googleusercontent.com'),
    cid.endsWith('.apps.googleusercontent.com')
      ? `ends with .apps.googleusercontent.com (good)`
      : `does NOT end with .apps.googleusercontent.com — first 12 chars: "${cid.slice(0,12)}", last 12: "${cid.slice(-12)}"`
  );
  t('Client Secret format',
    csecret.startsWith('GOCSPX-'),
    csecret.startsWith('GOCSPX-')
      ? `starts with GOCSPX- (good)`
      : `does NOT start with GOCSPX- — first 8 chars: "${csecret.slice(0,8)}"`
  );
  t('Refresh Token format',
    ctoken.startsWith('1//'),
    ctoken.startsWith('1//')
      ? `starts with 1// (good)`
      : `does NOT start with 1// — first 8 chars: "${ctoken.slice(0,8)}"`
  );

  // ── Step 4: Direct token exchange — this is where Google tells us the truth ─
  // We hit Google's OAuth endpoint directly and decode the exact error.
  const start = Date.now();
  let tokenResponse;
  try {
    const body = new URLSearchParams({
      client_id:     cid.trim(),
      client_secret: csecret.trim(),
      refresh_token: ctoken.trim(),
      grant_type:    'refresh_token',
    });
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    body.toString(),
    });
    tokenResponse = { status: r.status, body: await r.json().catch(() => ({})) };
  } catch (err) {
    t('Token exchange — network',
      false,
      `network error: ${err.message}`
    );
    return res.status(200).json({ ok: false, summary: 'Network error reaching Google', results });
  }

  const elapsed = Date.now() - start;
  if (tokenResponse.status === 200 && tokenResponse.body.access_token) {
    t('Token exchange — Google accepted credentials',
      true,
      `OK in ${elapsed}ms — got access_token (${String(tokenResponse.body.access_token).length} chars)`
    );
  } else {
    const err  = tokenResponse.body.error             || '(no error code)';
    const desc = tokenResponse.body.error_description || '(no description)';
    let interpretation = '';
    if (err === 'invalid_client') {
      interpretation = ' → Client ID or Client Secret is wrong (or they don\'t match each other in Google Cloud Console)';
    } else if (err === 'invalid_grant') {
      interpretation = ' → Refresh Token is wrong, revoked, expired, or was generated with a DIFFERENT Client ID/Secret pair';
    } else if (err === 'unauthorized_client') {
      interpretation = ' → OAuth client exists but is not authorised for this grant type';
    }
    t('Token exchange — Google REJECTED',
      false,
      `HTTP ${tokenResponse.status} | error=${err} | description="${desc}"${interpretation}`
    );
    return res.status(200).json({
      ok: false,
      summary: `Google rejected the credentials with: ${err}`,
      results,
      googleRawResponse: tokenResponse.body,
    });
  }

  // ── Step 5: Try a Drive API call to confirm end-to-end ──────────────────────
  try {
    const { google } = require('googleapis');
    const oauthClient = new google.auth.OAuth2(cid.trim(), csecret.trim());
    oauthClient.setCredentials({ refresh_token: ctoken.trim() });
    const drive = google.drive({ version: 'v3', auth: oauthClient });
    const driveStart = Date.now();
    const aboutRes = await drive.about.get({ fields: 'user' });
    t('Drive API — about.get',
      true,
      `OK in ${Date.now()-driveStart}ms — logged in as ${aboutRes.data.user?.emailAddress || 'unknown'}`
    );
  } catch (err) {
    t('Drive API — about.get',
      false,
      `failed: ${err.message}`
    );
  }

  return res.status(200).json({ ok: true, summary: 'Google OAuth chain works end-to-end', results });
};
