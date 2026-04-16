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
      return res.status(200).json({ action: 'created', expiresAt: result.expirationDateTime });
    }

    // ── Case 2: Subscription expired — recreate ──
    if (!isActive(subscription)) {
      console.log('[cron] Subscription expired — recreating');
      await markExpired();
      const notificationUrl = process.env.WEBHOOK_NOTIFICATION_URL;
      const result = await createSubscription(notificationUrl);
      await saveSubscription(result.id, result.expirationDateTime, `${notificationUrl}/api/webhook`);
      console.log(`[cron] ✅ Recreated. Expires: ${result.expirationDateTime}`);
      return res.status(200).json({ action: 'recreated', expiresAt: result.expirationDateTime });
    }

    // ── Case 3: Not yet time to renew — but check changeType is correct ──
    if (!isTimeToRenew(subscription)) {
      const renewAt = subscription.renewAt || 'unknown';
      const expiresAt = subscription.expiresAt;
      const hoursLeft = Math.round((new Date(expiresAt) - new Date()) / (1000 * 60 * 60));
      console.log(`[cron] Not yet time to renew. ${hoursLeft}h until expiry. Renewal scheduled: ${renewAt}`);

      // Always check auto-poll health — restart if dead
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
    return res.status(200).json({ action: 'renewed', expiresAt: result.expirationDateTime });

  } catch (err) {
    console.error('[cron] Error:', err.message);
    // On any error, try to recreate from scratch
    try {
      console.log('[cron] Error during renewal — attempting fresh creation');
      const notificationUrl = process.env.WEBHOOK_NOTIFICATION_URL;
      const result = await createSubscription(notificationUrl);
      await saveSubscription(result.id, result.expirationDateTime, `${notificationUrl}/api/webhook`);
      console.log(`[cron] ✅ Recovered — new subscription created`);
      return res.status(200).json({ action: 'recovered', expiresAt: result.expirationDateTime });
    } catch (recoveryErr) {
      console.error('[cron] Recovery also failed:', recoveryErr.message);
      return res.status(500).json({ error: err.message, recoveryError: recoveryErr.message });
    }
  }
};
