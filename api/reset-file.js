/**
 * /api/reset-file
 *
 * POST /api/reset-file
 * Body: { fileId: string, secret: string, action?: 'reset' | 'stop' }
 *
 * reset (default) — clears stuck processing status so scan-now will reprocess
 * stop            — marks file as stopped so it won't be picked up again
 *
 * Called from the dashboard Reset and Stop buttons.
 */

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { fileId, secret, action = 'reset' } = req.body || {};
  const expectedSecret = process.env.CALLBACK_SECRET || 'grove-pdf-router-secret';

  if (!fileId)                  return res.status(400).json({ error: 'fileId required' });
  if (secret !== expectedSecret) return res.status(403).json({ error: 'Invalid secret' });

  try {
    const admin = require('firebase-admin');
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
    const ts        = admin.firestore.FieldValue.serverTimestamp();

    if (action === 'stop') {
      // Mark as stopped in both collections — file won't be reprocessed automatically
      const stopData = {
        status:    'error',
        error:     'Manually stopped from dashboard',
        stoppedAt: new Date().toISOString(),
        updatedAt: ts,
      };
      await Promise.all([
        firestore.collection('processedFiles').doc(fileId).set(stopData, { merge: true }),
        firestore.collection('pdfRouterStatus').doc(fileId).set({
          ...stopData,
          fileId,
        }, { merge: true }),
      ]);
      console.log(`[reset-file] Stopped fileId: ${fileId}`);
      return res.status(200).json({
        ok:      true,
        action:  'stop',
        message: `File ${fileId} stopped — marked as error, will not be reprocessed automatically`,
      });

    } else {
      // Reset — clear stuck status so scan-now will pick it up again
      const resetData = {
        status:    'detected',
        error:     null,
        resetAt:   new Date().toISOString(),
        updatedAt: ts,
      };
      await Promise.all([
        firestore.collection('processedFiles').doc(fileId).set(resetData, { merge: true }),
        firestore.collection('pdfRouterStatus').doc(fileId).set({
          ...resetData,
          fileId,
        }, { merge: true }),
      ]);
      console.log(`[reset-file] Reset fileId: ${fileId}`);
      return res.status(200).json({
        ok:      true,
        action:  'reset',
        message: `File ${fileId} reset — will be reprocessed on next scan`,
      });
    }

  } catch (err) {
    console.error('[reset-file] Error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
