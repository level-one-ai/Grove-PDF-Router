/**
 * /api/mode
 *
 * Gets and sets the processing mode (auto vs human interaction).
 * Mode is stored in Firestore: settings/processingMode
 *
 * GET /api/mode          → returns current mode
 * POST /api/mode         → sets mode { mode: 'auto' | 'human' }
 */

const { requireApiAuth } = require('../lib/auth');
const admin = require('firebase-admin');

function getDb() {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
  }
  return admin.firestore();
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (!requireApiAuth(req, res)) return;

  const db = getDb();
  const docRef = db.collection('settings').doc('processingMode');

  // GET — return current mode
  if (req.method === 'GET') {
    try {
      const doc = await docRef.get();
      const mode = doc.exists ? doc.data().mode : 'auto';
      return res.status(200).json({ success: true, mode });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // POST — set mode
  if (req.method === 'POST') {
    const { mode } = req.body;
    if (!['auto', 'human'].includes(mode)) {
      return res.status(400).json({ error: 'mode must be "auto" or "human"' });
    }
    try {
      await docRef.set({ mode, updatedAt: new Date().toISOString() });
      console.log(`[mode] Processing mode set to: ${mode}`);
      return res.status(200).json({ success: true, mode });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
