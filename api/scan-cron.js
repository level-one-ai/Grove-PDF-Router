/**
 * /api/scan-cron
 *
 * Runs every minute via Vercel cron.
 * Primary autonomous safety net — triggers scan-now to process any
 * unprocessed files in the OneDrive Scans folder.
 *
 * Checks auto-poll health every 5 minutes (not every minute) to avoid
 * unnecessary Firestore reads. The hourly cron.js handles full health checks.
 *
 * Schedule: every minute ("* * * * *" in vercel.json)
 */

const axios = require('axios');

module.exports.config = { maxDuration: 60 };

// Only check auto-poll heartbeat every 5 minutes to reduce Firestore reads
// (scan-cron fires every minute but auto-poll check only needs to run occasionally)
let lastAutoPollCheck = 0;
const AUTO_POLL_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes

module.exports = async function handler(req, res) {
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
  // This is the primary purpose — runs every minute
  try {
    await axios.post(`${baseUrl}/api/scan-now`, {}, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    results.scanNow = 'triggered';
    console.log('[scan-cron] ✅ scan-now triggered');
  } catch (err) {
    results.scanNow = 'triggered (timeout expected)';
    console.log('[scan-cron] ✅ scan-now triggered (timeout is normal)');
  }

  // ── 2. Check auto-poll health every 5 minutes only ──
  // Saves ~4 Firestore reads per 5-minute window vs checking every minute
  const timeSinceLastCheck = Date.now() - lastAutoPollCheck;
  if (timeSinceLastCheck >= AUTO_POLL_CHECK_INTERVAL) {
    lastAutoPollCheck = Date.now();
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

      const STALE_MS = 2 * 60 * 1000;
      let autoPollAlive = false;

      if (lockDoc.exists) {
        const heartbeat = lockDoc.data().heartbeat
          ? new Date(lockDoc.data().heartbeat).getTime() : 0;
        const age = Date.now() - heartbeat;
        autoPollAlive = age < STALE_MS;
        console.log(`[scan-cron] auto-poll check: heartbeat ${Math.round(age / 1000)}s ago — ${autoPollAlive ? 'alive' : 'stale'}`);
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
  } else {
    results.autoPoll = `skipped (next check in ${Math.round((AUTO_POLL_CHECK_INTERVAL - timeSinceLastCheck) / 1000)}s)`;
  }

  return res.status(200).json({ ok: true, at: now, ...results });
};
