/**
 * /api/cleanup-drive-recent
 *
 * Lists or trashes recent PDFs in Google Drive. Runs inside Vercel where
 * GOOGLE_OAUTH_* credentials are accessible.
 *
 * Files are sent to Drive Bin (recoverable for 30 days), not permanently deleted.
 *
 * Protected by CALLBACK_SECRET so randoms can't probe Drive.
 *
 * Usage:
 *   List only (dry run):
 *     GET /api/cleanup-drive-recent?hours=24&secret=abc123xyz
 *
 *   List with custom time window:
 *     GET /api/cleanup-drive-recent?hours=2&secret=abc123xyz
 *
 *   Actually trash files (REQUIRES confirm=YES_TRASH_THEM):
 *     GET /api/cleanup-drive-recent?hours=24&confirm=YES_TRASH_THEM&secret=abc123xyz
 */

const { google } = require('googleapis');

module.exports = async function handler(req, res) {
  // ── Auth ────────────────────────────────────────────────────────────────
  const providedSecret = req.query.secret || req.headers['x-callback-secret'];
  const expectedSecret = process.env.CALLBACK_SECRET || 'abc123xyz';
  if (providedSecret !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorized — provide ?secret=...' });
  }

  // ── Parse params ────────────────────────────────────────────────────────
  const hours = parseFloat(req.query.hours || '24');
  if (isNaN(hours) || hours <= 0 || hours > 168) {
    return res.status(400).json({ error: 'hours must be a number between 0 and 168 (1 week)' });
  }

  // CRITICAL: confirm must match exactly to actually delete
  const isDryRun = req.query.confirm !== 'YES_TRASH_THEM';

  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);

  // ── Credentials check ───────────────────────────────────────────────────
  if (!process.env.GOOGLE_OAUTH_CLIENT_ID || !process.env.GOOGLE_OAUTH_REFRESH_TOKEN) {
    return res.status(500).json({
      error: 'Google OAuth credentials missing in this environment',
      hasClientId: !!process.env.GOOGLE_OAUTH_CLIENT_ID,
      hasClientSecret: !!process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      hasRefreshToken: !!process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
    });
  }

  // ── Build Drive client ──────────────────────────────────────────────────
  let drive;
  try {
    const oAuth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_OAUTH_CLIENT_ID,
      process.env.GOOGLE_OAUTH_CLIENT_SECRET
    );
    oAuth2Client.setCredentials({ refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN });
    drive = google.drive({ version: 'v3', auth: oAuth2Client });
  } catch (err) {
    return res.status(500).json({ error: 'Drive client init failed: ' + err.message });
  }

  // ── Search for recent PDFs ──────────────────────────────────────────────
  const q = `mimeType = 'application/pdf' and modifiedTime >= '${cutoff.toISOString()}' and trashed = false`;

  const allFiles = [];
  let pageToken = null;
  try {
    do {
      const resp = await drive.files.list({
        q,
        fields: 'nextPageToken, files(id,name,modifiedTime,parents,size)',
        pageSize: 100,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      allFiles.push(...(resp.data.files || []));
      pageToken = resp.data.nextPageToken;
      if (allFiles.length > 500) break; // safety cap
    } while (pageToken);
  } catch (err) {
    return res.status(500).json({ error: 'Drive list failed: ' + err.message });
  }

  // Sort newest first
  allFiles.sort((a, b) => new Date(b.modifiedTime) - new Date(a.modifiedTime));

  // ── Dry run — just return the list ──────────────────────────────────────
  if (isDryRun) {
    return res.status(200).json({
      mode: 'DRY_RUN',
      message: `Would trash ${allFiles.length} file(s). To actually trash, add &confirm=YES_TRASH_THEM`,
      hours,
      cutoff: cutoff.toISOString(),
      foundCount: allFiles.length,
      files: allFiles.map(f => ({
        name: f.name,
        id: f.id,
        modifiedTime: f.modifiedTime,
        ageMinutes: Math.round((Date.now() - new Date(f.modifiedTime).getTime()) / 60000),
        sizeBytes: f.size ? parseInt(f.size, 10) : null,
      })),
    });
  }

  // ── Actually trash ──────────────────────────────────────────────────────
  const results = { trashed: [], failed: [] };

  for (const file of allFiles) {
    try {
      await drive.files.update({
        fileId: file.id,
        requestBody: { trashed: true },
        supportsAllDrives: true,
      });
      results.trashed.push({ name: file.name, id: file.id });
    } catch (err) {
      results.failed.push({ name: file.name, id: file.id, error: err.message });
    }
  }

  return res.status(200).json({
    mode: 'CONFIRMED',
    message: `Trashed ${results.trashed.length} file(s) (recoverable from Drive Bin for 30 days).`,
    hours,
    cutoff: cutoff.toISOString(),
    trashedCount: results.trashed.length,
    failedCount: results.failed.length,
    trashed: results.trashed,
    failed: results.failed,
  });
};
