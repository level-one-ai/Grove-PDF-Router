/**
 * /api/status
 *
 * Dashboard API endpoints for querying processed file records.
 *
 * GET /api/status              — returns all records (paginated, most recent first)
 * GET /api/status?fileId=xxx   — returns a single record by fileId
 * GET /api/status?limit=20     — returns N most recent records
 */

const admin = require('firebase-admin');
const db = require('../lib/firebase');

module.exports = async function handler(req, res) {
  // CORS headers — allow your dashboard domain to query this
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { fileId, limit = '50' } = req.query;

  try {
    // Single record lookup
    if (fileId) {
      const record = await db.getRecord(fileId);
      if (!record) {
        return res.status(404).json({ error: 'Record not found' });
      }
      return res.status(200).json({ success: true, record });
    }

    // List all records (most recent first)
    const firebase = require('firebase-admin');
    let app;
    if (!firebase.apps.length) {
      app = firebase.initializeApp({
        credential: firebase.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        }),
      });
    }

    const firestore = firebase.firestore();
    const snapshot = await firestore
      .collection('processedFiles')
      .orderBy('createdAt', 'desc')
      .limit(parseInt(limit, 10))
      .get();

    const records = snapshot.docs.map((doc) => {
      const data = doc.data();
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
        // Top-level URL (set on completion) or fallback from first page that has one
        googleDriveFolderUrl: data.googleDriveFolderUrl ||
          Object.values(data.pages || {}).map(p => p?.googleDrive?.folderUrl).find(u => !!u) || null,
        oneDriveProcessedFolderUrl: data.oneDriveProcessedFolderUrl,
        createdAt: data.createdAt?.toDate?.()?.toISOString() || null,
        completedAt: data.completedAt?.toDate?.()?.toISOString() || null,
        error: data.error || null,
      };
    });

    return res.status(200).json({
      success: true,
      count: records.length,
      records,
    });
  } catch (err) {
    console.error('[status] Error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};
