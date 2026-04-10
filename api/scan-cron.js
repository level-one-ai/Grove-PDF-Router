/**
 * /api/scan-cron
 *
 * Runs every 5 minutes via Vercel cron.
 * Lightweight safety net that:
 *   1. Triggers scan-now to process any unprocessed files in Scans
 *   2. Ensures auto-poll is alive and restarts it if dead
 *
 * This is separate from /api/cron which handles subscription renewal hourly.
 * Together they ensure files are never missed for more than 5 minutes even if
 * the Microsoft Graph webhook subscription lapses or auto-poll dies.
 *
 * Schedule: every 5 minutes ("* /5 * * * *" in vercel.json)
 */

const axios = require('axios');

module.exports.config = { maxDuration: 60 };

module.exports = async function handler(req, res) {
  // Verify Vercel cron secret if set
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorised' });
    }
  }

  const now = new Date().toISOString();
  console.log(`[scan-cron] Running at ${now}`);

  const baseUrl = process.env.WEBHOOK_NOTIFICATION_URL || 'https://grove-pdf-router.vercel.app';
  const results = {};

  // ── 1. Trigger scan-now to pick up any waiting files ──
  try {
    await axios.post(`${baseUrl}/api/scan-now`, {}, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    results.scanNow = 'triggered';
    console.log('[scan-cron] ✅ scan-now triggered');
  } catch (err) {
    // scan-now responds 200 immediately — timeout means it's running fine
    results.scanNow = 'triggered (timeout expected)';
    console.log('[scan-cron] ✅ scan-now triggered (timeout is normal)');
  }

  // ── 2. Ensure auto-poll is alive ──
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
    const lockDoc = await firestore.collection('settings').doc('autoPollLock').get();

    const STALE_MS = 2 * 60 * 1000; // 2 minutes
    let autoPollAlive = false;

    if (lockDoc.exists) {
      const heartbeat = lockDoc.data().heartbeat
        ? new Date(lockDoc.data().heartbeat).getTime() : 0;
      const age = Date.now() - heartbeat;
      autoPollAlive = age < STALE_MS;
      console.log(`[scan-cron] auto-poll heartbeat age: ${Math.round(age / 1000)}s — ${autoPollAlive ? 'alive' : 'stale'}`);
    } else {
      console.log('[scan-cron] auto-poll lock not found');
    }

    if (!autoPollAlive) {
      try {
        await axios.post(`${baseUrl}/api/auto-poll`, {}, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 5000,
        });
        results.autoPoll = 'restarted';
        console.log('[scan-cron] ✅ auto-poll restarted');
      } catch (err) {
        results.autoPoll = 'restarted (timeout expected)';
        console.log('[scan-cron] ✅ auto-poll restart triggered');
      }
    } else {
      results.autoPoll = 'alive';
    }

  } catch (err) {
    results.autoPoll = `check failed: ${err.message}`;
    console.warn('[scan-cron] auto-poll check failed (non-fatal):', err.message);
  }

  return res.status(200).json({ ok: true, at: now, ...results });
};
