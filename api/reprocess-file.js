/**
 * /api/reprocess-file
 *
 * Reprocesses all pages of a previously processed file by calling
 * /api/reprocess-page for each page in turn.
 *
 * Confirmation: client must send confirm: "REPROCESS" to actually run.
 *
 * Request body: { fileId: string, secret: string, confirm: "REPROCESS" }
 */

const axios = require('axios');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST' });
  }

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
  if (!fileId) {
    return res.status(400).json({ error: 'fileId required' });
  }

  console.log(`[reprocess-file] Starting full reprocess for ${fileId}`);

  try {
    // Look up the file in Firestore to find total pages
    const admin = require('firebase-admin');
    const dashSnapshot = await admin.firestore().collection('pdfRouterStatus').doc(fileId).get();
    if (!dashSnapshot.exists) {
      return res.status(404).json({ error: 'File not found in dashboard records' });
    }
    const dashData = dashSnapshot.data();
    const totalPages = Number(dashData.totalPages) || 0;

    if (totalPages === 0) {
      return res.status(400).json({ error: 'totalPages not found for this file' });
    }

    // Reprocess each page sequentially
    const baseUrl = process.env.WEBHOOK_NOTIFICATION_URL || `https://${req.headers.host}`;
    const results = [];

    for (let p = 1; p <= totalPages; p++) {
      // Skip pages that don't have OneDrive IDs (e.g. non-order pages routed to Non-Order Documents)
      const pageData = dashData[`page_${p}`];
      if (!pageData || !pageData.oneDriveId) {
        results.push({ page: p, status: 'skipped', reason: 'No OneDrive ID — page may be in Non-Order Documents' });
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
      reprocessed: results.filter(r => r.status === 'reprocessed').length,
      noChange:    results.filter(r => r.status === 'no_change').length,
      skipped:     results.filter(r => r.status === 'skipped').length,
      failed:      results.filter(r => r.status === 'failed').length,
    };

    return res.status(200).json({
      status: 'complete',
      fileId,
      totalPages,
      summary,
      results,
    });

  } catch (err) {
    console.error(`[reprocess-file] FATAL: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
};
