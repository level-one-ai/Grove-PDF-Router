/**
 * /api/reset
 *
 * Clears a stuck or failed Firestore record so a file can be retried.
 *
 * POST /api/reset
 * Body: { fileId: "xxx" }
 */

const { requireAuth } = require('../lib/auth');
const db = require('../lib/firebase');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (!requireAuth(req, res)) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { fileId } = req.body;
  if (!fileId) {
    return res.status(400).json({ error: 'fileId is required' });
  }

  try {
    const existing = await db.getRecord(fileId);
    if (!existing) {
      return res.status(200).json({
        success: true,
        message: 'No record found — file is ready to process',
      });
    }

    // Reset to clean state
    await db.updateRecord(fileId, {
      status: 'reset',
      pagesReturned: 0,
      totalPages: null,
      pages: {},
      renamedFiles: [],
      pageStore: {},
      completedAt: null,
      error: null,
      resetAt: new Date().toISOString(),
    });

    console.log(`[reset] Record cleared for fileId: ${fileId} (was: ${existing.status})`);
    return res.status(200).json({
      success: true,
      message: `Record reset from "${existing.status}" — file can now be processed`,
      fileId,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};
