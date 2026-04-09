/**
 * /api/logs
 *
 * Returns aggregated Firestore read counts collected by the system.
 * These counts are written to Firestore by the [firestore-reads] logging
 * helper in each function, then read here for display in the dashboard Logs panel.
 *
 * GET /api/logs
 */

module.exports.config = { maxDuration: 10 };

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const admin = require('firebase-admin');
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        }),
      });
    }
    const firestore = admin.firestore();

    // Read the aggregated read log document
    const doc = await firestore.collection('settings').doc('firestoreReadLog').get();

    if (!doc.exists) {
      return res.status(200).json({
        entries: [],
        totalReads: 0,
        windowMins: 60,
        message: 'No read log data yet — deploy and run the system for a few minutes',
      });
    }

    const data = doc.data();
    const sources = data.sources || {};
    const windowMins = data.windowMins || 60;

    // Convert to sorted array
    const entries = Object.entries(sources).map(([source, info]) => ({
      source,
      reads: info.reads || 0,
      invocations: info.invocations || 0,
      lastSeen: info.lastSeen || null,
    })).sort((a, b) => b.reads - a.reads);

    const totalReads = entries.reduce((sum, e) => sum + e.reads, 0);

    return res.status(200).json({
      entries,
      totalReads,
      windowMins,
      updatedAt: data.updatedAt || null,
    });

  } catch (err) {
    console.error('[logs] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
