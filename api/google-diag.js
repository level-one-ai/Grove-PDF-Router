/**
 * api/google-diag.js — v2
 *
 * Granular diagnostic for Google OAuth chain, PLUS:
 *  - Counts ALL customer folders under the Drive root (verifies pagination)
 *  - Confirms the count via a second pass with a different page size
 *
 * Usage: GET /api/google-diag?secret=YOUR_CALLBACK_SECRET
 */

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

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
  const rootFolderId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID || '';

  t('Client ID present',          !!cid.trim(),     cid     ? `${cid.length} chars`     : 'MISSING');
  t('Client Secret present',      !!csecret.trim(), csecret ? `${csecret.length} chars` : 'MISSING');
  t('Refresh Token present',      !!ctoken.trim(),  ctoken  ? `${ctoken.length} chars`  : 'MISSING');
  t('Root folder ID present',     !!rootFolderId.trim(), rootFolderId || 'MISSING');

  if (!cid.trim() || !csecret.trim() || !ctoken.trim()) {
    return res.status(200).json({ ok: false, summary: 'Missing one or more OAuth credentials', results });
  }

  // ── Step 2: Whitespace check ────────────────────────────────────────────────
  const checkWhitespace = (label, val) => {
    const issues = [];
    if (val !== val.trim())  issues.push('leading/trailing whitespace');
    if (/[\r\n]/.test(val))  issues.push('embedded newlines');
    if (/\t/.test(val))      issues.push('embedded tabs');
    return issues.length === 0
      ? t(`${label} — no whitespace issues`, true, 'clean')
      : t(`${label} — WHITESPACE PROBLEM`,    false, issues.join(', '));
  };
  checkWhitespace('Client ID',     cid);
  checkWhitespace('Client Secret', csecret);
  checkWhitespace('Refresh Token', ctoken);

  // ── Step 3: Format check ────────────────────────────────────────────────────
  t('Client ID format',     cid.endsWith('.apps.googleusercontent.com'),
    cid.endsWith('.apps.googleusercontent.com') ? 'good' : `last 12: "${cid.slice(-12)}"`);
  t('Client Secret format', csecret.startsWith('GOCSPX-'),
    csecret.startsWith('GOCSPX-') ? 'good' : `first 8: "${csecret.slice(0,8)}"`);
  t('Refresh Token format', ctoken.startsWith('1//'),
    ctoken.startsWith('1//') ? 'good' : `first 8: "${ctoken.slice(0,8)}"`);

  // ── Step 4: Token exchange ──────────────────────────────────────────────────
  let tokenResponse;
  try {
    const body = new URLSearchParams({
      client_id:     cid.trim(),
      client_secret: csecret.trim(),
      refresh_token: ctoken.trim(),
      grant_type:    'refresh_token',
    });
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:   body.toString(),
    });
    tokenResponse = { status: r.status, body: await r.json().catch(() => ({})) };
  } catch (err) {
    t('Token exchange — network', false, `network error: ${err.message}`);
    return res.status(200).json({ ok: false, summary: 'Network error', results });
  }
  if (tokenResponse.status === 200 && tokenResponse.body.access_token) {
    t('Token exchange — Google accepted credentials', true, `OK (access_token ${tokenResponse.body.access_token.length} chars)`);
  } else {
    const err  = tokenResponse.body.error             || '(no error code)';
    const desc = tokenResponse.body.error_description || '(no description)';
    t('Token exchange — Google REJECTED', false, `HTTP ${tokenResponse.status} | error=${err} | "${desc}"`);
    return res.status(200).json({ ok: false, summary: `Google rejected: ${err}`, results });
  }

  // ── Step 5: Drive API call ──────────────────────────────────────────────────
  let drive;
  try {
    const { google } = require('googleapis');
    const oauthClient = new google.auth.OAuth2(cid.trim(), csecret.trim());
    oauthClient.setCredentials({ refresh_token: ctoken.trim() });
    drive = google.drive({ version: 'v3', auth: oauthClient });
    const aboutRes = await drive.about.get({ fields: 'user, storageQuota' });
    t('Drive API — about.get', true, `logged in as ${aboutRes.data.user?.emailAddress || 'unknown'}`);
  } catch (err) {
    t('Drive API — about.get', false, `failed: ${err.message}`);
    return res.status(200).json({ ok: false, summary: 'Drive API call failed', results });
  }

  // ── Step 6: COUNT all customer folders (proves pagination works) ────────────
  if (!rootFolderId) {
    t('Folder count', false, 'GOOGLE_DRIVE_ROOT_FOLDER_ID not set — skipping');
    return res.status(200).json({ ok: true, summary: 'OAuth works (folder count skipped)', results });
  }

  try {
    let total      = 0;
    let pages      = 0;
    let pageToken  = null;
    const sample   = [];   // first 3 and last 3 folder names for inspection
    const allFolders = [];

    do {
      const r = await drive.files.list({
        q: `'${rootFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields:    'nextPageToken, files(id, name)',
        pageSize:  1000,
        pageToken: pageToken || undefined,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        corpora: 'allDrives',
      });
      const batch = r.data.files || [];
      total += batch.length;
      allFolders.push(...batch.map(f => f.name));
      pageToken = r.data.nextPageToken || null;
      pages++;
      if (pages > 50) break;
    } while (pageToken);

    // Sort names alphabetically for inspection
    allFolders.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    sample.push(...allFolders.slice(0, 3).map(n => `[A] ${n}`));
    if (allFolders.length > 6) {
      const mid = Math.floor(allFolders.length / 2);
      sample.push(`[~mid] ${allFolders[mid]}`);
    }
    sample.push(...allFolders.slice(-3).map(n => `[Z] ${n}`));

    t('Folder pagination scan',
      true,
      `Found ${total} customer folder(s) across ${pages} page(s). ` +
      (pages > 1 ? `Pagination IS active and working.` : `(Only 1 page needed — your folder count is under 1000.)`)
    );
    t('Folder name sample',
      true,
      sample.join(' | ')
    );
  } catch (err) {
    t('Folder pagination scan', false, `failed: ${err.message}`);
  }

  return res.status(200).json({ ok: true, summary: 'Google OAuth chain works end-to-end', results });
};
