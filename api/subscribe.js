/**
 * /api/subscribe
 *
 * Handles Microsoft Graph API subscription management.
 *
 * GET /api/subscribe?action=create
 *   → Creates a new subscription, saves to Firestore, returns details
 *
 * GET /api/subscribe?action=renew
 *   → Renews using the subscriptionId stored in Firestore (no manual ID needed)
 *   → Or pass ?subscriptionId=xxx to renew a specific one
 *
 * GET /api/subscribe?action=status
 *   → Returns current subscription status from Firestore
 *
 * POST /api/subscribe?validationToken=xxx
 *   → Microsoft Graph validation token handshake (automatic)
 */

const { createSubscription, renewSubscription } = require('../lib/graph');
const {
  saveSubscription,
  updateSubscriptionAfterRenewal,
  getSubscription,
  needsRenewal,
  isActive,
  getStatusSummary,
} = require('../lib/subscription');

function getSubscriptionHint(err) {
  const code = err.graphCode || '';
  const msg = (err.graphMessage || '').toLowerCase();
  if (msg.includes('notificationurl')) return 'The WEBHOOK_NOTIFICATION_URL is invalid or Microsoft cannot reach it. Make sure it is set to your exact Vercel URL e.g. https://grove-pdf-router.vercel.app';
  if (msg.includes('expiration')) return 'Expiry date is invalid. This is a system error — please report it.';
  if (code === 'ExtensionError') return 'Microsoft cannot reach your webhook URL to validate it. Check WEBHOOK_NOTIFICATION_URL is correct and the /api/webhook endpoint is deployed.';
  if (err.response?.status === 403) return 'Permission denied. Check Azure API permissions have admin consent granted for Files.ReadWrite.All.';
  return 'Check all Microsoft environment variables are set correctly in Vercel and redeployed.';
}

module.exports = async function handler(req, res) {

  // ── Microsoft Graph Validation Token Handshake ──
  // Graph API sends this POST to verify the endpoint exists.
  // Must respond with the token as plain text within 10 seconds.
  if (req.method === 'POST' && req.query.validationToken) {
    console.log('[subscribe] Validation token handshake received');
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send(req.query.validationToken);
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action } = req.query;

  // ── STATUS ──
  if (action === 'status') {
    try {
      // Timeout after 6 seconds to avoid hanging
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Firestore timeout')), 6000)
      );
      const subscription = await Promise.race([getSubscription(), timeoutPromise]);
      const summary = getStatusSummary(subscription);
      return res.status(200).json({
        success: true,
        ...summary,
        subscription: subscription || null,
      });
    } catch (err) {
      // Return a safe fallback instead of hanging
      return res.status(200).json({
        success: true,
        status: 'unknown',
        message: 'Checking subscription status...',
        colour: 'grey',
        subscription: null,
      });
    }
  }

  // ── CREATE ──
  // Creates a new Graph API subscription and saves it to Firestore.
  // Safe to call even if one already exists — will create a fresh one.
  if (action === 'create') {
    try {
      // Check if an active subscription already exists
      const existing = await getSubscription();
      if (existing && isActive(existing) && !req.query.force) {
        // Check if the subscription was created before the changeType fix
        // (old subscriptions only watched 'updated', missing file creation events)
        // Force recreation if changeType field is missing or doesn't include 'created'
        const hasCorrectChangeType = existing.changeType &&
          existing.changeType.includes('created');
        if (hasCorrectChangeType) {
          const summary = getStatusSummary(existing);
          return res.status(200).json({
            success: true,
            alreadyActive: true,
            message: `Subscription already active. ${summary.message}. Add ?force=true to create a new one anyway.`,
            subscriptionId: existing.subscriptionId,
            expiresAt: existing.expiresAt,
          });
        }
        console.log('[subscribe] Existing subscription missing created changeType — recreating');
      }

      const notificationUrl = process.env.WEBHOOK_NOTIFICATION_URL;
      const subscription = await createSubscription(notificationUrl);

      // Save to Firestore — cron job uses this for auto-renewal
      await saveSubscription(
        subscription.id,
        subscription.expirationDateTime,
        `${notificationUrl}/api/webhook`,
        'created,updated'
      );

      console.log('[subscribe] Subscription created and saved:', subscription.id);
      return res.status(200).json({
        success: true,
        subscriptionId: subscription.id,
        expiresAt: subscription.expirationDateTime,
        message: 'Subscription created and saved. Auto-renewal is active via Vercel Cron — no manual renewal needed.',
      });
    } catch (err) {
      console.error('[subscribe] Create error:', err.graphError || err.response?.data || err.message);
      return res.status(500).json({
        success: false,
        error: err.message,
        graphError: err.graphError || err.response?.data || null,
        graphMessage: err.graphMessage || null,
        graphCode: err.graphCode || null,
        hint: getSubscriptionHint(err),
      });
    }
  }

  // ── RENEW ──
  // Renews the subscription. Uses the ID stored in Firestore automatically.
  // Optionally accepts ?subscriptionId=xxx to override.
  if (action === 'renew') {
    try {
      let subscriptionId = req.query.subscriptionId;

      // If no ID passed, get it from Firestore
      if (!subscriptionId) {
        const existing = await getSubscription();
        if (!existing || !existing.subscriptionId) {
          return res.status(400).json({
            success: false,
            error: 'No subscription found in database. Please create one first using ?action=create',
          });
        }
        subscriptionId = existing.subscriptionId;
      }

      const updated = await renewSubscription(subscriptionId);

      // Update Firestore with new expiry
      await updateSubscriptionAfterRenewal(updated.id, updated.expirationDateTime);

      console.log('[subscribe] Subscription renewed:', subscriptionId);
      return res.status(200).json({
        success: true,
        subscriptionId: updated.id,
        expiresAt: updated.expirationDateTime,
        message: 'Subscription renewed successfully. Next auto-renewal will happen via Vercel Cron.',
      });
    } catch (err) {
      console.error('[subscribe] Renew error:', err.response?.data || err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // ── NO ACTION ──
  return res.status(400).json({
    error: 'Missing action parameter',
    usage: {
      create: '/api/subscribe?action=create',
      renew: '/api/subscribe?action=renew',
      status: '/api/subscribe?action=status',
    },
  });
};
