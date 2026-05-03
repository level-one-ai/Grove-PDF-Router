/**
 * /api/reset-file
 *
 * POST /api/reset-file
 * Body: { fileId: string, secret: string }
 *
 * Resets a stuck file's Firestore record so scan-now will pick it up again.
 * Called from the dashboard when a file is stuck in Processing.
 */

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { fileId, secret } = req.body || {};
  const expectedSecret = process.env.CALLBACK_SECRET || 'grove-pdf-router-secret';

  if (!fileId) return res.status(400).json({ error: 'fileId required' });
  if (secret !== expectedSecret) return res.status(403).json({ error: 'Invalid secret' });

  try {
    const admin    = require('firebase-admin');
    // Initialise firebase-admin if not already done
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId:   process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        }),
      });
    }
    const firestore = admin.firestore();

    // Reset the file record so scan-now will reprocess it
    await firestore.collection('processedFiles').doc(fileId).set({
      status:    'reset',
      error:     'Manually reset from dashboard',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    console.log(`[reset-file] Reset fileId: ${fileId}`);
    return res.status(200).json({ ok: true, message: `File ${fileId} reset — will be reprocessed on next scan` });
  } catch (err) {
    console.error('[reset-file] Error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
