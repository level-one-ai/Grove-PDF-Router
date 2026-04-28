/**
 * /api/status
 *
 * Dashboard API endpoints for querying processed file records.
 *
 * GET /api/status              — returns all records (paginated, most recent first)
 * GET /api/status?fileId=xxx   — returns a single record by fileId
 * GET /api/status?limit=20     — returns N most recent records
 *
 * Each record includes a `pageFiles` array — one entry per processed page —
 * so the processed column can show individual page filenames rather than
 * just the original scan filename.
 */

const admin = require('firebase-admin');
const db = require('../lib/firebase');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // limit: dashboard page-load uses 10 (recent history only).
  // Pass limit=200 explicitly only when a full export/audit is needed.
  const { fileId, limit = '10' } = req.query;

  try {
    // Single-record fetch — used by dashboard to check one file without loading all records.
    // This costs exactly 1 Firestore read regardless of collection size.
    if (fileId) {
      const record = await db.getRecord(fileId);
      if (!record) return res.status(404).json({ error: 'Record not found' });
      return res.status(200).json({ success: true, record });
    }

    const firebase = require('firebase-admin');
    if (!firebase.apps.length) {
      firebase.initializeApp({
        credential: firebase.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        }),
      });
    }

    const firestore = firebase.firestore();
    // Cap at 50 as a hard safety limit — dashboard only needs recent records.
    // Full history is available by passing ?limit=50 explicitly if ever needed.
    const safeLimit = Math.min(parseInt(limit, 10) || 10, 50);
    const snapshot = await firestore
      .collection('processedFiles')
      .orderBy('createdAt', 'desc')
      .limit(safeLimit)
      .get();

    const records = snapshot.docs.map((doc) => {
      const data = doc.data();

      // Build pageFiles — one entry per processed page, sorted by page number.
      // Each entry has: pageNumber, finalFileName, customerName, ref, supplier,
      // oneDriveUrl, googleDriveUrl so the processed column can show per-page rows.
      const pagesMap = data.pages || {};
      const pageFiles = Object.entries(pagesMap)
        .map(([pageNum, p]) => ({
          pageNumber: parseInt(pageNum, 10),
          finalFileName: p?.finalFileName || null,
          status: p?.status || null,
          customerName: p?.customerName || data.customerName || null,
          ref: p?.ref || data.ref || null,
          supplier: p?.supplier || data.supplier || null,
          oneDriveUrl: p?.oneDrive?.oneDriveUrl || null,
          googleDriveUrl: p?.googleDrive?.folderUrl || null,
          docType: p?.docType || null,           // for non-order pages
          nonOrderFileName: p?.nonOrderFileName || null,
          skipped: p?.status === 'skipped',
        }))
        .filter(p => p.finalFileName || p.nonOrderFileName) // only pages that produced a file
        .sort((a, b) => a.pageNumber - b.pageNumber);

      return {
        fileId: data.fileId,
        originalFileName: data.originalFileName,
        status: data.status,
        supplier: data.supplier,
        customerName: data.customerName,
        ref: data.ref,
        totalPages: data.totalPages,
        pagesReturned: data.pagesReturned,
        renamedFiles: data.renamedFiles || [],
        pageFiles,   // ← new: per-page breakdown
        googleDriveFolderUrl: data.googleDriveFolderUrl ||
          Object.values(pagesMap).map(p => p?.googleDrive?.folderUrl).find(u => !!u) || null,
        oneDriveProcessedFolderUrl: data.oneDriveProcessedFolderUrl,
        createdAt: data.createdAt?.toDate?.()?.toISOString() || null,
        completedAt: data.completedAt?.toDate?.()?.toISOString() || null,
        error: data.error || null,
      };
    });

    return res.status(200).json({ success: true, count: records.length, records });
  } catch (err) {
    console.error('[status] Error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};
