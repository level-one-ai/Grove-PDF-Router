/**
 * /api/cron
 *
 * Runs every hour via Vercel cron.
 * Uses a smart renewal schedule — calculates the exact time renewal
 * is needed (1 hour before expiry) and only acts when that time arrives.
 *
 * This means:
 * - Most cron runs do nothing (< 1 second, no API calls)
 * - Exactly one run per subscription cycle does the renewal
 * - No manual activation ever needed
 *
 * Schedule: "0 * * * *" — top of every hour
 */

const {
  getSubscription,
  updateSubscriptionAfterRenewal,
  markExpired,
  isActive,
  isTimeToRenew,
  saveSubscription,
} = require('../lib/subscription');

const {
  createSubscription,
  renewSubscription,
} = require('../lib/graph');

const axios = require('axios');

/**
 * Check whether auto-poll is still alive by reading its lock heartbeat.
 * If the heartbeat is stale (> 2 minutes old) or missing, restart auto-poll.
 * This ensures the system keeps watching OneDrive 24/7 even without the dashboard open.
 */
async function ensureAutoPollAlive() {
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
    console.log('[firestore-reads] cron autoPollLock check: 1 read');

    const STALE_MS = 2 * 60 * 1000; // 2 minutes — auto-poll heartbeats every ~60s
    let needsRestart = true;

    if (lockDoc.exists) {
      const data = lockDoc.data();
      const heartbeat = data.heartbeat ? new Date(data.heartbeat).getTime() : 0;
      const age = Date.now() - heartbeat;
      if (age < STALE_MS) {
        console.log(`[cron] auto-poll is alive (heartbeat ${Math.round(age / 1000)}s ago) — no restart needed`);
        needsRestart = false;
      } else {
        console.log(`[cron] auto-poll heartbeat is stale (${Math.round(age / 1000)}s ago) — restarting`);
      }
    } else {
      console.log('[cron] auto-poll lock not found — starting fresh instance');
    }

    if (needsRestart) {
      const baseUrl = process.env.WEBHOOK_NOTIFICATION_URL || 'https://grove-pdf-router.vercel.app';
      try {
        await axios.post(`${baseUrl}/api/auto-poll`, {}, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 5000,
        });
        console.log('[cron] ✅ auto-poll restarted');
      } catch (err) {
        // auto-poll responds 200 immediately so timeout is expected — treat as success
        console.log('[cron] ✅ auto-poll restart triggered (timeout expected)');
      }

      // Also trigger scan-now immediately to process any files already waiting in Scans.
      // auto-poll on first run seeds existing files — scan-now catches them right away.
      try {
        await axios.post(`${baseUrl}/api/scan-now`, {}, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000,
        });
        console.log('[cron] ✅ scan-now triggered to catch any waiting files');
      } catch (err) {
        console.log('[cron] scan-now trigger warning (non-fatal):', err.message);
      }
    } else {
      // Even when auto-poll is alive, trigger scan-now once per cron run
      // as an additional safety net to catch any files that slipped through.
      const baseUrl = process.env.WEBHOOK_NOTIFICATION_URL || 'https://grove-pdf-router.vercel.app';
      try {
        await axios.post(`${baseUrl}/api/scan-now`, {}, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000,
        });
        console.log('[cron] ✅ scan-now triggered as hourly safety net');
      } catch (err) {
        console.log('[cron] scan-now safety net warning (non-fatal):', err.message);
      }
    }
  } catch (err) {
    console.warn('[cron] auto-poll health check failed (non-fatal):', err.message);
  }
}

module.exports = async function handler(req, res) {
  // Allow Vercel's own cron calls through
  // If CRON_SECRET is set, verify it
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorised' });
    }
  }

  const now = new Date().toISOString();
  console.log(`[cron] Running at ${now}`);

  try {
    const subscription = await getSubscription();

    // ── Case 1: No subscription — create one ──
    if (!subscription) {
      console.log('[cron] No subscription — creating');
      const notificationUrl = process.env.WEBHOOK_NOTIFICATION_URL;
      const result = await createSubscription(notificationUrl);
      await saveSubscription(result.id, result.expirationDateTime, `${notificationUrl}/api/webhook`);
      console.log(`[cron] ✅ Created. Expires: ${result.expirationDateTime}`);
      await ensureAutoPollAlive();
      return res.status(200).json({ action: 'created', expiresAt: result.expirationDateTime, autoPollChecked: true });
    }

    // ── Case 2: Subscription expired — recreate ──
    if (!isActive(subscription)) {
      console.log('[cron] Subscription expired — recreating');
      await markExpired();
      const notificationUrl = process.env.WEBHOOK_NOTIFICATION_URL;
      const result = await createSubscription(notificationUrl);
      await saveSubscription(result.id, result.expirationDateTime, `${notificationUrl}/api/webhook`);
      console.log(`[cron] ✅ Recreated. Expires: ${result.expirationDateTime}`);
      await ensureAutoPollAlive();
      return res.status(200).json({ action: 'recreated', expiresAt: result.expirationDateTime, autoPollChecked: true });
    }

    // ── Case 3: Not yet time to renew — skip ──
    if (!isTimeToRenew(subscription)) {
      const renewAt = subscription.renewAt || 'unknown';
      const expiresAt = subscription.expiresAt;
      const hoursLeft = Math.round((new Date(expiresAt) - new Date()) / (1000 * 60 * 60));
      console.log(`[cron] Not yet time to renew. ${hoursLeft}h until expiry. Renewal scheduled: ${renewAt}`);
      // Always check auto-poll health — restart if dead
      await ensureAutoPollAlive();
      return res.status(200).json({
        action: 'none',
        message: `Renewal scheduled for ${renewAt}`,
        expiresAt,
        hoursLeft,
        autoPollChecked: true,
      });
    }

    // ── Case 4: Time to renew — do it now ──
    console.log(`[cron] Renewal time reached — renewing ${subscription.subscriptionId}`);
    const result = await renewSubscription(subscription.subscriptionId);
    await updateSubscriptionAfterRenewal(result.id, result.expirationDateTime);
    console.log(`[cron] ✅ Renewed. Expires: ${result.expirationDateTime}`);
    await ensureAutoPollAlive();
    return res.status(200).json({ action: 'renewed', expiresAt: result.expirationDateTime, autoPollChecked: true });

  } catch (err) {
    console.error('[cron] Error:', err.message);
    // On any error, try to recreate from scratch
    try {
      console.log('[cron] Error during renewal — attempting fresh creation');
      const notificationUrl = process.env.WEBHOOK_NOTIFICATION_URL;
      const result = await createSubscription(notificationUrl);
      await saveSubscription(result.id, result.expirationDateTime, `${notificationUrl}/api/webhook`);
      console.log(`[cron] ✅ Recovered — new subscription created`);
      await ensureAutoPollAlive();
      return res.status(200).json({ action: 'recovered', expiresAt: result.expirationDateTime, autoPollChecked: true });
    } catch (recoveryErr) {
      console.error('[cron] Recovery also failed:', recoveryErr.message);
      return res.status(500).json({ error: err.message, recoveryError: recoveryErr.message });
    }
  }
};
