/**
 * /api/reprocess-file
 *
 * Reprocesses all pages of a previously processed file by calling
 * /api/reprocess-page for each page in turn.
 *
 * Request body: { fileId: string, secret: string, confirm: "REPROCESS" }
 */

const axios = require('axios');

/**
 * Get a Firestore client by ensuring the DEFAULT Firebase app exists.
 * Some other endpoints may have initialised named (non-default) apps,
 * which makes admin.apps.length > 0 even though no default app exists.
 * This helper explicitly checks for a default app and creates one if needed.
 */
function getFirestore() {
  const admin = require('firebase-admin');
  // Look for an existing DEFAULT app (name === '[DEFAULT]')
  const hasDefault = admin.apps.some(a => a && a.name === '[DEFAULT]');
  if (!hasDefault) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
  }
  return admin.firestore();
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const providedSecret = body.secret || req.headers['x-callback-secret'];
  const expectedSecret = process.env.CALLBACK_SECRET || 'abc123xyz';
  if (providedSecret !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (body.confirm !== 'REPROCESS') {
    return res.status(400).json({
      error: 'Confirmation required',
      message: 'Send confirm: "REPROCESS" to proceed (case-sensitive)',
    });
  }

  const { fileId } = body;
  if (!fileId) return res.status(400).json({ error: 'fileId required' });

  console.log(`[reprocess-file] Starting full reprocess for ${fileId}`);

  try {
    const firestore = getFirestore();
    const dashSnapshot = await firestore.collection('pdfRouterStatus').doc(fileId).get();
    if (!dashSnapshot.exists) {
      return res.status(404).json({ error: 'File not found in dashboard records' });
    }
    const dashData   = dashSnapshot.data();
    const totalPages = Number(dashData.totalPages) || 0;
    if (totalPages === 0) return res.status(400).json({ error: 'totalPages not found for this file' });

    const baseUrl = process.env.WEBHOOK_NOTIFICATION_URL || `https://${req.headers.host}`;
    const results = [];

    for (let p = 1; p <= totalPages; p++) {
      const pageData = dashData[`page_${p}`];
      if (!pageData || !pageData.oneDriveId) {
        results.push({ page: p, status: 'skipped', reason: 'No OneDrive ID' });
        continue;
      }
      try {
        const response = await axios.post(
          `${baseUrl}/api/reprocess-page`,
          { fileId, pageNumber: p, secret: expectedSecret },
          { timeout: 90000, headers: { 'Content-Type': 'application/json' } }
        );
        results.push({ page: p, status: response.data.status, ...response.data });
      } catch (err) {
        const detail = err.response?.data?.error || err.message;
        results.push({ page: p, status: 'failed', error: detail });
      }
    }

    const summary = {
      reprocessed:        results.filter(r => r.status === 'reprocessed').length,
      driveBackfilled:    results.filter(r => r.status === 'drive_backfilled').length,
      driveBackfillFailed:results.filter(r => r.status === 'drive_backfill_failed').length,
      noChange:           results.filter(r => r.status === 'no_change').length,
      skipped:            results.filter(r => r.status === 'skipped').length,
      failed:             results.filter(r => r.status === 'failed').length,
      movedToNonOrder:    results.filter(r => r.status === 'moved_to_non_order').length,
    };

    return res.status(200).json({ status: 'complete', fileId, totalPages, summary, results });

  } catch (err) {
    console.error(`[reprocess-file] FATAL: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
};
