/**
 * /api/cron
 *
 * Vercel Cron Job — runs automatically every 2 days.
 * Checks the Microsoft Graph API subscription and renews it
 * if it is within 24 hours of expiry.
 *
 * Configured in vercel.json:
 *   { "path": "/api/cron", "schedule": "0 9 * * *" }
 *   (runs daily at 9am UTC — checks if renewal needed)
 *
 * Vercel calls this endpoint automatically on schedule.
 * It is protected by the CRON_SECRET env var which Vercel
 * sets automatically when you use cron jobs.
 */

const {
  getSubscription,
  updateSubscriptionAfterRenewal,
  markExpired,
  needsRenewal,
  isActive,
  saveSubscription,
} = require('../lib/subscription');

const {
  createSubscription,
  renewSubscription,
} = require('../lib/graph');

module.exports = async function handler(req, res) {
  // Vercel automatically sets the Authorization header when calling cron jobs
  // This prevents anyone else from triggering the cron endpoint
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorised' });
  }

  console.log('[cron] Running subscription check...');

  try {
    const subscription = await getSubscription();

    // ── Case 1: No subscription exists — create one ──
    if (!subscription) {
      console.log('[cron] No subscription found — creating new subscription');
      const notificationUrl = process.env.WEBHOOK_NOTIFICATION_URL;
      const result = await createSubscription(notificationUrl);

      await saveSubscription(
        result.id,
        result.expirationDateTime,
        `${notificationUrl}/api/webhook`
      );

      console.log(`[cron] ✅ Subscription created: ${result.id}, expires: ${result.expirationDateTime}`);
      return res.status(200).json({
        action: 'created',
        subscriptionId: result.id,
        expiresAt: result.expirationDateTime,
      });
    }

    // ── Case 2: Subscription exists but expired ──
    if (!isActive(subscription)) {
      console.log('[cron] Subscription expired — creating new subscription');
      await markExpired();

      const notificationUrl = process.env.WEBHOOK_NOTIFICATION_URL;
      const result = await createSubscription(notificationUrl);

      await saveSubscription(
        result.id,
        result.expirationDateTime,
        `${notificationUrl}/api/webhook`
      );

      console.log(`[cron] ✅ New subscription created: ${result.id}`);
      return res.status(200).json({
        action: 'recreated',
        subscriptionId: result.id,
        expiresAt: result.expirationDateTime,
      });
    }

    // ── Case 3: Subscription exists and needs renewal ──
    if (needsRenewal(subscription)) {
      console.log(`[cron] Subscription expiring soon — renewing ${subscription.subscriptionId}`);
      const result = await renewSubscription(subscription.subscriptionId);

      await updateSubscriptionAfterRenewal(result.id, result.expirationDateTime);

      console.log(`[cron] ✅ Subscription renewed: ${result.id}, expires: ${result.expirationDateTime}`);
      return res.status(200).json({
        action: 'renewed',
        subscriptionId: result.id,
        expiresAt: result.expirationDateTime,
      });
    }

    // ── Case 4: Subscription is active and not due for renewal ──
    console.log(`[cron] ✅ Subscription active — no action needed. Expires: ${subscription.expiresAt}`);
    return res.status(200).json({
      action: 'none',
      message: 'Subscription is active and not due for renewal',
      expiresAt: subscription.expiresAt,
    });

  } catch (err) {
    console.error('[cron] Error during subscription check:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
